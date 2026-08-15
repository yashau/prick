import type { CreateGrantBody, IdentityKind, Role, UpdateIdentityBody } from "@prick/shared";
import { count, eq, gt, isNull, max, min, or } from "drizzle-orm";

import { resolveAuthorization } from "../auth/authorize.js";
import { assertNotLastAdmin } from "../auth/bootstrap.js";
import { uuidv7 } from "../db/ids.js";
import { auditLog, environments, grants, identities, projects } from "../db/schema.js";
import { auditStatement } from "./audit.js";
import type { CoreContext, Scope } from "./context.js";
import { PrickError, notFound } from "./errors.js";
import { assertRole } from "./guards.js";
import { requireProject } from "./projects.js";
import { findEnvironment } from "./environments.js";
import { runBatch } from "./sql.js";

export interface IdentityRecord {
  id: string;
  kind: IdentityKind;
  subject: string;
  displayName: string | null;
  disabled: boolean;
  lastSeenAt: number | null;
}

export interface GrantRecord {
  id: string;
  identityId: string;
  subject: string;
  role: Role;
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

/**
 * Who may see the access graph at all.
 *
 * ANY admin, at any scope -- not global admin. A project admin has to be able to
 * grant access within their project, and they cannot do that without seeing the
 * list of identities to grant it to. Restricting this to global admins would
 * make delegated administration decorative: the role would exist and be
 * unusable.
 *
 * What they may see is then narrowed per row by `visibleGrant` below. Being
 * allowed to open the screen is not being allowed to read every grant on it.
 */
async function assertAnyAdmin(ctx: CoreContext): Promise<void> {
  const snapshot = await resolveAuthorization(ctx);

  if (!snapshot.disabled) {
    if (snapshot.bootstrap || snapshot.globalRole === "admin") return;
    for (const role of snapshot.byProject.values()) if (role === "admin") return;
    for (const role of snapshot.byEnvironment.values()) if (role === "admin") return;
  }

  // Routed through the standard denial path so it is audited and shows up in
  // "Seen but not granted" like every other refusal.
  await assertRole(ctx, { type: "global" }, "admin");
}

export async function listIdentities(ctx: CoreContext): Promise<IdentityRecord[]> {
  await assertAnyAdmin(ctx);

  const rows = await ctx.db.select().from(identities).orderBy(identities.subject);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "service" ? "service" : "user",
    subject: row.subject,
    displayName: row.displayName,
    disabled: row.disabled,
    lastSeenAt: row.lastSeenAt,
  }));
}

/**
 * Enable/disable an identity, or set its display name.
 *
 * `display_name` is not cosmetic. A service token's subject is
 * `e367826f93b8d71185e03fe518aff3b4.access`, and an access list of those is
 * unreadable -- which is how a stale token survives three audits. The name is
 * the only thing that makes revocation a decision anyone can take.
 *
 * GLOBAL admin, because `disabled` is a kill switch that outranks every grant at
 * every scope; a project admin flipping it would be revoking access to projects
 * they have nothing to do with.
 */
export async function updateIdentity(
  ctx: CoreContext,
  id: string,
  input: UpdateIdentityBody,
): Promise<IdentityRecord> {
  await assertRole(ctx, { type: "global" }, "admin");

  const rows = await ctx.db.select().from(identities).where(eq(identities.id, id)).limit(1);
  const identity = rows[0];
  if (identity === undefined) throw notFound("identity");

  const fields: string[] = [];
  const patch: { displayName?: string | null; disabled?: boolean; updatedAt: number } = {
    updatedAt: ctx.now,
  };

  if (input.display_name !== undefined) {
    patch.displayName = input.display_name;
    fields.push("display_name");
  }
  if (input.disabled !== undefined) {
    patch.disabled = input.disabled;
    fields.push("disabled");
  }

  await runBatch(ctx.db, [
    ctx.db.update(identities).set(patch).where(eq(identities.id, id)),
    auditStatement(ctx, {
      action: "identity.update",
      outcome: "success",
      detail: { kind: "identity", subject: identity.subject, fields },
    }),
  ]);

  return {
    id: identity.id,
    kind: identity.kind === "service" ? "service" : "user",
    subject: identity.subject,
    displayName: patch.displayName === undefined ? identity.displayName : patch.displayName,
    disabled: patch.disabled ?? identity.disabled,
    lastSeenAt: identity.lastSeenAt,
  };
}

/** `expires_at IS NULL OR expires_at > now`. An expired grant is not a grant. */
function liveGrant(now: number) {
  return or(isNull(grants.expiresAt), gt(grants.expiresAt, now));
}

export async function listGrants(ctx: CoreContext): Promise<GrantRecord[]> {
  await assertAnyAdmin(ctx);

  const snapshot = await resolveAuthorization(ctx);
  const globalAdmin = snapshot.bootstrap || snapshot.globalRole === "admin";

  const rows = await ctx.db
    .select({
      id: grants.id,
      identityId: grants.identityId,
      subject: identities.subject,
      role: grants.role,
      scopeType: grants.scopeType,
      projectId: grants.projectId,
      environmentId: grants.environmentId,
      projectSlug: projects.slug,
      environmentSlug: environments.slug,
      expiresAt: grants.expiresAt,
    })
    .from(grants)
    .innerJoin(identities, eq(identities.id, grants.identityId))
    .leftJoin(projects, eq(projects.id, grants.projectId))
    .leftJoin(environments, eq(environments.id, grants.environmentId))
    .where(liveGrant(ctx.now));

  const out: GrantRecord[] = [];

  for (const row of rows) {
    // A scoped admin sees the grants that touch what they administer, and not
    // the rest of the organisation's access graph.
    if (!globalAdmin) {
      const administers =
        (row.projectId !== null && snapshot.byProject.get(row.projectId) === "admin") ||
        (row.environmentId !== null &&
          snapshot.byEnvironment.get(row.environmentId) === "admin") ||
        (row.environmentId !== null &&
          row.projectId !== null &&
          snapshot.byProject.get(row.projectId) === "admin");

      if (!administers) continue;
    }

    out.push({
      id: row.id,
      identityId: row.identityId,
      subject: row.subject,
      role: asRole(row.role),
      scopeType: asScopeType(row.scopeType),
      projectSlug: row.projectSlug,
      environmentSlug: row.environmentSlug,
      expiresAt: row.expiresAt,
    });
  }

  return out;
}

function asRole(value: string): Role {
  return value === "admin" || value === "writer" ? value : "reader";
}

function asScopeType(value: string): "global" | "project" | "environment" {
  return value === "global" || value === "environment" ? value : "project";
}

/**
 * Create a grant.
 *
 * ADMIN AT THE SCOPE BEING GRANTED, resolved through the same `assertCan` every
 * other operation uses. A project admin may grant within their project; only a
 * global admin may grant globally. That falls out of scope inheritance and needs
 * no special case -- which is the point, because the special case is where
 * privilege escalation lives.
 *
 * A duplicate is a CONFLICT, not an upsert. The partial unique indexes on
 * `grants` do the detection. Silently upgrading an existing reader grant to
 * admin because somebody re-submitted a form is precisely the change nobody
 * would notice.
 */
export async function createGrant(
  ctx: CoreContext,
  input: CreateGrantBody,
): Promise<GrantRecord> {
  const resolved = await resolveGrantScope(ctx, input);

  await assertRole(ctx, resolved.scope, "admin");

  const rows = await ctx.db
    .select()
    .from(identities)
    .where(eq(identities.id, input.identity_id))
    .limit(1);

  const identity = rows[0];
  if (identity === undefined) throw notFound("identity");

  const id = uuidv7(ctx.now);

  try {
    await runBatch(ctx.db, [
      ctx.db.insert(grants).values({
        id,
        identityId: input.identity_id,
        role: input.role,
        scopeType: input.scope_type,
        projectId: resolved.projectId,
        environmentId: resolved.environmentId,
        expiresAt: input.expires_at,
        createdAt: ctx.now,
        createdBy: ctx.actor.subject,
      }),
      auditStatement(ctx, {
        action: "grant.create",
        outcome: "success",
        projectId: resolved.projectId,
        environmentId: resolved.environmentId,
        detail: {
          kind: "grant",
          role: input.role,
          scopeType: input.scope_type,
          subject: identity.subject,
          expiresAt: input.expires_at,
        },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new PrickError("CONFLICT", "That identity already has a grant at this scope.", {
        hint: "Revoke the existing grant first. Grants are not upgraded in place, so that a re-submitted form cannot silently widen access.",
        cause: error,
      });
    }
    throw error;
  }

  return {
    id,
    identityId: input.identity_id,
    subject: identity.subject,
    role: input.role,
    scopeType: input.scope_type,
    projectSlug: resolved.projectSlug,
    environmentSlug: resolved.environmentSlug,
    expiresAt: input.expires_at,
  };
}

interface ResolvedScope {
  scope: Scope;
  projectId: string | null;
  environmentId: string | null;
  projectSlug: string | null;
  environmentSlug: string | null;
}

async function resolveGrantScope(
  ctx: CoreContext,
  input: CreateGrantBody,
): Promise<ResolvedScope> {
  if (input.scope_type === "global") {
    return {
      scope: { type: "global" },
      projectId: null,
      environmentId: null,
      projectSlug: null,
      environmentSlug: null,
    };
  }

  const project = await requireProject(ctx, input.project);

  if (input.scope_type === "project") {
    return {
      scope: { type: "project", projectId: project.id },
      projectId: project.id,
      environmentId: null,
      projectSlug: project.slug,
      environmentSlug: null,
    };
  }

  const environment = await findEnvironment(ctx, project.id, input.environment);
  if (environment === null) throw notFound("environment");

  return {
    scope: { type: "environment", environmentId: environment.id, projectId: project.id },
    projectId: project.id,
    environmentId: environment.id,
    projectSlug: project.slug,
    environmentSlug: environment.slug,
  };
}

/**
 * Revoke a grant.
 *
 * Refuses to remove the last global admin while `BOOTSTRAP_ADMINS` is empty.
 * There is no recovery credential in this design -- that is deliberate, and it
 * means "are you sure?" is not a question a dialog can be trusted to ask. The
 * only way back from an accidental lockout is editing a var and redeploying, so
 * the operation is refused rather than confirmed.
 */
export async function revokeGrant(ctx: CoreContext, grantId: string): Promise<void> {
  const rows = await ctx.db
    .select({
      id: grants.id,
      identityId: grants.identityId,
      subject: identities.subject,
      role: grants.role,
      scopeType: grants.scopeType,
      projectId: grants.projectId,
      environmentId: grants.environmentId,
      expiresAt: grants.expiresAt,
    })
    .from(grants)
    .innerJoin(identities, eq(identities.id, grants.identityId))
    .where(eq(grants.id, grantId))
    .limit(1);

  const grant = rows[0];
  if (grant === undefined) throw notFound("grant");

  const scope: Scope =
    grant.scopeType === "global"
      ? { type: "global" }
      : grant.scopeType === "project" && grant.projectId !== null
        ? { type: "project", projectId: grant.projectId }
        : grant.environmentId !== null
          ? {
              type: "environment",
              environmentId: grant.environmentId,
              ...(grant.projectId === null ? {} : { projectId: grant.projectId }),
            }
          : { type: "global" };

  await assertRole(ctx, scope, "admin");
  await assertNotLastAdmin(ctx, grantId);

  await runBatch(ctx.db, [
    ctx.db.delete(grants).where(eq(grants.id, grantId)),
    auditStatement(ctx, {
      action: "grant.revoke",
      outcome: "success",
      projectId: grant.projectId,
      environmentId: grant.environmentId,
      detail: {
        kind: "grant",
        role: grant.role,
        scopeType: grant.scopeType,
        subject: grant.subject,
        expiresAt: grant.expiresAt,
      },
    }),
  ]);
}

export interface UnknownIdentity {
  kind: IdentityKind;
  subject: string;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
}

/**
 * Subjects that authenticated successfully and were then DENIED, and that hold
 * no grant.
 *
 * The highest-value screen in the app, and it exists because of one fact: a
 * service token's `common_name` is an opaque hex string, and no operator can map
 * `e367826f93b8d71185e03fe518aff3b4.access` to "staging deploy" by looking at
 * it. There is no list of tokens to browse -- Access issues them, we only ever
 * see one when it arrives.
 *
 * Because denials are audited, that list can be read back OUT of the audit log,
 * which turns provisioning CI from "find the token id, copy it, create a grant"
 * into: point it at prick, watch it 403, click Grant.
 */
export async function listUnknownIdentities(ctx: CoreContext): Promise<UnknownIdentity[]> {
  await assertAnyAdmin(ctx);

  const denials = await ctx.db
    .select({
      kind: auditLog.actorKind,
      subject: auditLog.actorSubject,
      firstSeenAt: min(auditLog.ts),
      lastSeenAt: max(auditLog.ts),
      attempts: count(),
    })
    .from(auditLog)
    .where(eq(auditLog.outcome, "denied"))
    .groupBy(auditLog.actorKind, auditLog.actorSubject);

  // Subjects that DO hold a live grant are not "unknown" -- they were denied
  // something narrower than what they hold, which is ordinary authorization
  // doing its job rather than a missing introduction.
  const granted = await ctx.db
    .selectDistinct({ subject: identities.subject })
    .from(identities)
    .innerJoin(grants, eq(grants.identityId, identities.id))
    .where(liveGrant(ctx.now));

  const known = new Set(granted.map((row) => row.subject));

  return denials
    .filter((row) => !known.has(row.subject))
    .map((row) => ({
      kind: row.kind === "service" ? ("service" as const) : ("user" as const),
      subject: row.subject,
      firstSeenAt: row.firstSeenAt ?? 0,
      lastSeenAt: row.lastSeenAt ?? 0,
      attempts: row.attempts,
    }))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}
