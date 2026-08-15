import { and, eq, gt, isNull, ne, or, type AnyColumn, type SQLWrapper } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";

import type { CoreContext, RuntimeConfig } from "../core/context.js";
import { PrickError } from "../core/errors.js";
import { uuidv7 } from "../db/ids.js";
import { auditLog, grants, groupGrants, groupMembers, identities } from "../db/schema.js";

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
    throw new PrickError("FORBIDDEN", "This subject is not listed in BOOTSTRAP_ADMINS.", {
      hint: "Only a subject named in the var can be promoted by the bootstrap path.",
    });
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
        live(grants.expiresAt, ctx.now),
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

/**
 * `expires_at IS NULL OR expires_at > now`. Expired is not an admin.
 *
 * Takes the column so the same predicate serves `grants` and `group_grants`. A
 * second copy spelled against the other table is how one of them ends up
 * counting expired rows after somebody fixes a bug in the first.
 */
function live(column: AnyColumn, now: number) {
  return or(isNull(column), gt(column, now));
}

/**
 * What a pending deletion is about to remove, so the admin count can be taken as
 * of AFTER it.
 *
 * Four shapes because there are four ways to stop being a global admin without
 * anybody deleting a `grants` row: the group's grant goes, the whole group goes,
 * you leave the group, or your own grant goes. A guard that knew only the last
 * one would let an operator delete the group holding the only global admin grant
 * and lock the installation out -- through a route whose name does not contain
 * the word "grant".
 */
export interface AdminExclusion {
  /** A `grants` row about to be deleted. */
  grantId?: string;
  /** A `group_grants` row about to be deleted. */
  groupGrantId?: string;
  /** A whole group about to be deleted, with its grants and memberships. */
  groupId?: string;
  /** One membership about to be removed. */
  membership?: { groupId: string; identityId: string };
}

/**
 * How many DISTINCT, enabled identities hold live global admin -- directly, or
 * through a group.
 *
 * ONE query, via `UNION ALL`, because this runs on every authenticated request:
 * `assertAdminsConfigured` calls it whenever `BOOTSTRAP_ADMINS` is empty, which
 * is every properly bootstrapped installation. Two round-trips here would be a
 * per-request regression paid by every caller to fund a check that almost always
 * says "yes".
 *
 * DISTINCT is not decoration either. One identity can now reach global admin by
 * several paths at once -- a direct grant and two groups -- and counting rows
 * would report three administrators where there is one, which is precisely the
 * arithmetic that makes a lockout guard pass while the last human loses access.
 */
async function countGlobalAdmins(ctx: CoreContext, exclude: AdminExclusion = {}): Promise<number> {
  const directConditions: (SQLWrapper | undefined)[] = [
    eq(grants.scopeType, "global"),
    eq(grants.role, "admin"),
    eq(identities.disabled, false),
    live(grants.expiresAt, ctx.now),
  ];

  if (exclude.grantId !== undefined) directConditions.push(ne(grants.id, exclude.grantId));

  const direct = ctx.db
    .select({ identityId: identities.id })
    .from(grants)
    .innerJoin(identities, eq(grants.identityId, identities.id))
    .where(and(...directConditions));

  const groupConditions: (SQLWrapper | undefined)[] = [
    eq(groupGrants.scopeType, "global"),
    eq(groupGrants.role, "admin"),
    eq(identities.disabled, false),
    live(groupGrants.expiresAt, ctx.now),
  ];

  if (exclude.groupGrantId !== undefined) {
    groupConditions.push(ne(groupGrants.id, exclude.groupGrantId));
  }
  if (exclude.groupId !== undefined) {
    groupConditions.push(ne(groupGrants.groupId, exclude.groupId));
  }
  if (exclude.membership !== undefined) {
    // NOT (group = ? AND identity = ?), written as the De Morgan form because
    // both columns are NOT NULL and `or(ne, ne)` needs no non-null assertion.
    groupConditions.push(
      or(
        ne(groupMembers.groupId, exclude.membership.groupId),
        ne(groupMembers.identityId, exclude.membership.identityId),
      ),
    );
  }

  const viaGroups = ctx.db
    .select({ identityId: identities.id })
    .from(groupGrants)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groupGrants.groupId))
    .innerJoin(identities, eq(identities.id, groupMembers.identityId))
    .where(and(...groupConditions));

  const rows = await unionAll(direct, viaGroups);

  return new Set(rows.map((row) => row.identityId)).size;
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
    hint: "Set BOOTSTRAP_ADMINS in wrangler.jsonc to a comma-separated list of admin emails and redeploy. The first authenticated request from one of them creates a real, revocable grant.",
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

  await assertNotLastAdminAfter(ctx, { grantId });
}

/**
 * The same refusal, for the three ways GROUPS can remove the last administrator.
 *
 * Deliberately has NO pre-check of the kind `assertNotLastAdmin` performs above.
 * The count is taken as of after the exclusion, so a deletion that has nothing
 * to do with global admin simply does not change it -- the guard passes on the
 * arithmetic rather than on somebody having correctly enumerated which
 * deletions are dangerous. That enumeration is exactly the thing that goes stale
 * when a fourth way to lose a role is added.
 */
export async function assertNotLastAdminAfter(
  ctx: CoreContext,
  exclusion: AdminExclusion,
): Promise<void> {
  if (ctx.config.bootstrapAdmins.length > 0) return;

  if ((await countGlobalAdmins(ctx, exclusion)) > 0) return;

  throw new PrickError("LAST_ADMIN", "This is the last administrator of this installation.", {
    hint: "Grant global admin to another identity first, or set BOOTSTRAP_ADMINS in wrangler.jsonc and redeploy.",
  });
}
