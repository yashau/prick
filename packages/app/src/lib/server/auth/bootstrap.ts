import { and, eq, gt, isNull, ne, or } from "drizzle-orm";

import type { CoreContext, RuntimeConfig } from "../core/context.js";
import { PrickError } from "../core/errors.js";
import { uuidv7 } from "../db/ids.js";
import { auditLog, grants, identities } from "../db/schema.js";

/**
 * First-admin bootstrap, without a race and without a bootstrap token.
 *
 * `BOOTSTRAP_ADMINS` is a plain `vars` list of emails, evaluated LIVE on every
 * request rather than seeded once into the database. The honest justification:
 * the real root of trust is already "whoever can run `wrangler deploy`" -- that
 * person can read `MASTER_KEY` and decrypt every value in the database
 * regardless of what any grant says. Anchoring bootstrap to the same authority
 * therefore adds no exposure, and unlike a one-time token there is no window
 * during which a printed credential is valid and unrevoked.
 *
 * On the first authenticated request from a listed email it SELF-HEALS into a
 * real `grants` row and audits the fact, so the implicit path stops being used
 * as soon as it has been used once.
 *
 * Three guards, all of which exist here:
 *
 *   - A UI banner for as long as any admin is implicit (`Actor.bootstrap`).
 *   - `503 NO_ADMINS_CONFIGURED` when BOTH the var is empty AND no global admin
 *     grant exists. Failing closed and loudly beats serving an install that
 *     nobody can administer.
 *   - `409 LAST_ADMIN` on revoking the last global admin grant while the var is
 *     empty. There is no recovery credential by design, so this must be refused
 *     rather than confirmed.
 */

/** The actor recorded on rows this module writes on nobody's behalf. */
export const SYSTEM_ACTOR_KIND = "system";
export const SYSTEM_ACTOR_SUBJECT = "bootstrap";

/**
 * Parse the comma-separated `vars` string into a comparable list.
 *
 * Lower-cased and de-duplicated, matching how a user subject is derived from
 * the `email` claim -- otherwise `Ops@Example.com` in the var would never match
 * `ops@example.com` from the token, and the operator would see a 403 with no
 * explanation and a var that looks obviously correct.
 */
export function parseBootstrapAdmins(raw: string | undefined | null): readonly string[] {
  if (raw === undefined || raw === null) return [];

  const seen = new Set<string>();

  for (const entry of raw.split(",")) {
    const normalised = entry.trim().toLowerCase();
    if (normalised !== "") seen.add(normalised);
  }

  return [...seen];
}

/**
 * Is this subject an admin by virtue of the var alone?
 *
 * Evaluated LIVE against the parsed config on every call. Removing an email
 * from `BOOTSTRAP_ADMINS` and redeploying takes effect on the next request --
 * there is no cached copy to invalidate and no seeded row to hunt down.
 */
export function isBootstrapAdmin(config: RuntimeConfig, subject: string): boolean {
  const normalised = subject.trim().toLowerCase();
  if (normalised === "") return false;

  return config.bootstrapAdmins.includes(normalised);
}

/** Create the identity row if it does not exist, and touch `last_seen_at`. */
export async function upsertIdentity(ctx: CoreContext): Promise<string> {
  const id = uuidv7(ctx.now);

  const rows = await ctx.db
    .insert(identities)
    .values({
      id,
      kind: ctx.actor.kind,
      subject: ctx.actor.subject,
      displayName: null,
      disabled: false,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      lastSeenAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [identities.kind, identities.subject],
      set: { lastSeenAt: ctx.now, updatedAt: ctx.now },
    })
    .returning({ id: identities.id });

  return rows[0]?.id ?? id;
}

export interface SelfHealResult {
  identityId: string;
  /** True when this request is the one that converted the var into a grant. */
  granted: boolean;
}

/**
 * Convert an implicit bootstrap admin into a real, revocable grant.
 *
 * The grant insert is `ON CONFLICT DO NOTHING` against the partial unique index
 * `grants_global_uniq`, so two concurrent first requests cannot produce two
 * global grants for one identity. The audit insert rides in the SAME `batch()`
 * as the grant, per the rule that no mutation may be written without one.
 *
 * The one accepted imprecision: under that same race both requests may write an
 * audit row while only one writes a grant. An append-only log recording two
 * attempts is an honest account of what happened, and it is strictly better
 * than the alternative -- moving the audit outside the batch so it can be made
 * conditional, which reintroduces the un-audited mutation.
 */
export async function selfHealBootstrapGrant(ctx: CoreContext): Promise<SelfHealResult> {
  if (!isBootstrapAdmin(ctx.config, ctx.actor.subject)) {
    throw new PrickError(
      "FORBIDDEN",
      "This subject is not listed in BOOTSTRAP_ADMINS.",
      { hint: "Only a subject named in the var can be promoted by the bootstrap path." },
    );
  }

  const identityId = await upsertIdentity(ctx);

  const existing = await ctx.db
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.identityId, identityId),
        eq(grants.scopeType, "global"),
        eq(grants.role, "admin"),
        liveGrant(ctx.now),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { identityId, granted: false };
  }

  await ctx.db.batch([
    ctx.db
      .insert(grants)
      .values({
        id: uuidv7(ctx.now),
        identityId,
        role: "admin",
        scopeType: "global",
        projectId: null,
        environmentId: null,
        expiresAt: null,
        createdAt: ctx.now,
        // Recorded as created by the system, not by the person it promotes.
        // "acme@example.com granted acme@example.com global admin" would be a
        // false account of how that row came to exist.
        createdBy: SYSTEM_ACTOR_SUBJECT,
      })
      .onConflictDoNothing(),
    ctx.db.insert(auditLog).values({
      id: uuidv7(ctx.now),
      ts: ctx.now,
      requestId: ctx.requestId,
      actorKind: SYSTEM_ACTOR_KIND,
      actorSubject: SYSTEM_ACTOR_SUBJECT,
      identityId,
      action: "bootstrap.grant.create",
      outcome: "success",
      projectId: null,
      environmentId: null,
      targetKey: null,
      detail: JSON.stringify({
        reason: "BOOTSTRAP_ADMINS",
        subject: ctx.actor.subject,
        kind: ctx.actor.kind,
      }),
    }),
  ]);

  return { identityId, granted: true };
}

/** `expires_at IS NULL OR expires_at > now`. Expired is not an admin. */
function liveGrant(now: number) {
  return or(isNull(grants.expiresAt), gt(grants.expiresAt, now));
}

/** How many live global admin grants belong to identities that are not disabled. */
async function countGlobalAdmins(ctx: CoreContext, excludeGrantId?: string): Promise<number> {
  const conditions = [
    eq(grants.scopeType, "global"),
    eq(grants.role, "admin"),
    eq(identities.disabled, false),
    liveGrant(ctx.now),
  ];

  if (excludeGrantId !== undefined) conditions.push(ne(grants.id, excludeGrantId));

  const rows = await ctx.db
    .select({ id: grants.id })
    .from(grants)
    .innerJoin(identities, eq(grants.identityId, identities.id))
    .where(and(...conditions));

  return rows.length;
}

/**
 * True when neither the var nor any usable global admin grant exists.
 *
 * "Usable" is doing work: a grant belonging to a disabled identity, or one that
 * has expired, cannot administer anything, so counting it would report an
 * install as administrable when nobody can actually log in and fix it.
 */
export async function hasNoAdmins(ctx: CoreContext): Promise<boolean> {
  if (ctx.config.bootstrapAdmins.length > 0) return false;

  return (await countGlobalAdmins(ctx)) === 0;
}

/**
 * Fail the request with 503 when the install has no administrator at all.
 *
 * Loud and closed. The alternative is an install that answers requests, denies
 * every privileged action, and gives no indication why -- which looks exactly
 * like a permissions bug and gets debugged for an afternoon.
 */
export async function assertAdminsConfigured(ctx: CoreContext): Promise<void> {
  if (!(await hasNoAdmins(ctx))) return;

  throw new PrickError("NO_ADMINS_CONFIGURED", "This installation has no administrator.", {
    hint: 'Set BOOTSTRAP_ADMINS in wrangler.jsonc to a comma-separated list of admin emails and redeploy. The first authenticated request from one of them creates a real, revocable grant.',
  });
}

/**
 * Refuse to revoke the last global admin grant.
 *
 * There is no recovery credential in this design, so the only way back from
 * "revoked the last admin" is editing `BOOTSTRAP_ADMINS` and redeploying. If
 * the var is set, this is therefore allowed -- the recovery path exists. If it
 * is empty, it is refused, because confirming an irreversible lockout is not a
 * decision a confirmation dialog can make on the operator's behalf.
 */
export async function assertNotLastAdmin(ctx: CoreContext, grantId: string): Promise<void> {
  const rows = await ctx.db
    .select({ role: grants.role, scopeType: grants.scopeType })
    .from(grants)
    .where(eq(grants.id, grantId))
    .limit(1);

  const grant = rows[0];
  if (grant === undefined) return;
  if (grant.scopeType !== "global" || grant.role !== "admin") return;

  if (ctx.config.bootstrapAdmins.length > 0) return;

  if ((await countGlobalAdmins(ctx, grantId)) > 0) return;

  throw new PrickError("LAST_ADMIN", "This is the last administrator of this installation.", {
    hint: "Grant global admin to another identity first, or set BOOTSTRAP_ADMINS in wrangler.jsonc and redeploy.",
  });
}
