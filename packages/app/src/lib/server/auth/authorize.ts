import { and, eq } from "drizzle-orm";
import type { Role } from "@prick/shared";

import { ROLE_RANK, type Actor, type CoreContext, type Scope } from "../core/context.js";
import { PrickError } from "../core/errors.js";
import { uuidv7 } from "../db/ids.js";
import { auditLog, environments, grants, identities } from "../db/schema.js";
import { isBootstrapAdmin } from "./bootstrap.js";

/**
 * Authorization. One resolution per request, one code path, no exceptions.
 *
 * THERE IS NO GOD MODE, and the hazard is worth stating rather than assuming.
 * A shortcut of the form `if (actor.kind === 'user') return true` -- for any
 * identity kind at all -- means the scope check has stopped being the thing that
 * decides, and every grant written afterwards is decoration: the row says
 * `reader`, the answer is `true`, and nothing in the system disagrees out loud.
 * So a global admin here is an ordinary `grants` row with
 * `scope_type = 'global'` -- same query, same audit trail, revocable by the same
 * DELETE as any other. Nothing below branches on `actor.kind`.
 *
 * Effective role = MAX over all matching, non-expired grants -- the identity's
 * OWN and those of every group it belongs to -- resolved ONCE and cached against
 * the request context. A 200-secret operation must perform one authorization
 * query, not two hundred, and adding groups must not make it two.
 */

export interface AuthorizationSnapshot {
  /** `identities.id`, or `null` when this subject has never been recorded. */
  identityId: string | null;
  /** The kill switch. Outranks every grant, and the bootstrap var too. */
  disabled: boolean;
  /** From a real `scope_type = 'global'` grants row, never from a shortcut. */
  globalRole: Role | null;
  byProject: ReadonlyMap<string, Role>;
  byEnvironment: ReadonlyMap<string, Role>;
  /** True when admin rights come ONLY from `BOOTSTRAP_ADMINS`. */
  bootstrap: boolean;
}

/**
 * One snapshot per request, keyed by the context object itself.
 *
 * A `WeakMap` rather than a field on `CoreContext` so that the cache cannot
 * outlive the request and cannot be serialised into anything. The promise --
 * not the resolved value -- is stored, so two concurrent `assertCan` calls on
 * one request share a single in-flight query instead of racing to issue two.
 */
const snapshots = new WeakMap<CoreContext, Promise<AuthorizationSnapshot>>();

/** Memoised `environments.id -> project_id`, also per request. */
const environmentProjects = new WeakMap<CoreContext, Map<string, string | null>>();

function maxRole(current: Role | null, candidate: Role | null): Role | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return ROLE_RANK[candidate] > ROLE_RANK[current] ? candidate : current;
}

function asRole(value: string | null): Role | null {
  return value === "reader" || value === "writer" || value === "admin" ? value : null;
}

function asScopeType(value: string | null): "global" | "project" | "environment" | null {
  return value === "global" || value === "project" || value === "environment" ? value : null;
}

/**
 * Load the actor's identity row and every grant attached to it, in ONE query.
 *
 * A `LEFT JOIN` rather than two round-trips, because an identity with no grants
 * is the normal case for a service token that has just been pointed at this
 * Worker for the first time -- and that case must still produce a snapshot, so
 * the denial can be audited and the subject can appear in "Seen but not
 * granted".
 */
async function loadSnapshot(ctx: CoreContext): Promise<AuthorizationSnapshot> {
  const rows = await ctx.db
    .select({
      identityId: identities.id,
      disabled: identities.disabled,
      role: grants.role,
      scopeType: grants.scopeType,
      projectId: grants.projectId,
      environmentId: grants.environmentId,
      expiresAt: grants.expiresAt,
    })
    .from(identities)
    .leftJoin(grants, eq(grants.identityId, identities.id))
    .where(and(eq(identities.kind, ctx.actor.kind), eq(identities.subject, ctx.actor.subject)));

  const bootstrapAdmin = isBootstrapAdmin(ctx.config, ctx.actor.subject);

  const first = rows[0];

  if (first === undefined) {
    return {
      identityId: null,
      disabled: false,
      globalRole: null,
      byProject: new Map(),
      byEnvironment: new Map(),
      bootstrap: bootstrapAdmin,
    };
  }

  if (first.disabled) {
    /*
     * A disabled identity resolves to NOTHING, including when it is named in
     * `BOOTSTRAP_ADMINS`.
     *
     * The alternative -- letting the var override the flag -- means an operator
     * who disables an identity gets no guarantee that it stopped working, which
     * makes the kill switch worthless exactly when it is being used in anger.
     * Recovery from disabling your only bootstrap admin is a `wrangler d1
     * execute`, which is available to the same person who can edit the var.
     */
    return {
      identityId: first.identityId,
      disabled: true,
      globalRole: null,
      byProject: new Map(),
      byEnvironment: new Map(),
      bootstrap: false,
    };
  }

  let globalRole: Role | null = null;
  const byProject = new Map<string, Role>();
  const byEnvironment = new Map<string, Role>();

  for (const row of rows) {
    const role = asRole(row.role);
    const scopeType = asScopeType(row.scopeType);
    if (role === null || scopeType === null) continue;

    // Expiry is absolute epoch ms, compared against the request's injected
    // clock rather than `Date.now()`, so a grant cannot be live for one check
    // and expired for the next within the same request.
    if (row.expiresAt !== null && row.expiresAt <= ctx.now) continue;

    if (scopeType === "global") {
      globalRole = maxRole(globalRole, role);
      continue;
    }

    if (scopeType === "project" && row.projectId !== null) {
      byProject.set(row.projectId, maxRole(byProject.get(row.projectId) ?? null, role) as Role);
      continue;
    }

    if (scopeType === "environment" && row.environmentId !== null) {
      byEnvironment.set(
        row.environmentId,
        maxRole(byEnvironment.get(row.environmentId) ?? null, role) as Role,
      );
    }
  }

  return {
    identityId: first.identityId,
    disabled: false,
    globalRole,
    byProject,
    byEnvironment,
    // Implicit only while there is no real global admin grant. The moment the
    // self-heal has run, this goes false and the UI banner disappears.
    bootstrap: bootstrapAdmin && globalRole !== "admin",
  };
}

/** The per-request snapshot. Safe to call as often as you like. */
export function resolveAuthorization(ctx: CoreContext): Promise<AuthorizationSnapshot> {
  const existing = snapshots.get(ctx);
  if (existing !== undefined) return existing;

  const pending = loadSnapshot(ctx);
  snapshots.set(ctx, pending);
  return pending;
}

async function projectOfEnvironment(
  ctx: CoreContext,
  environmentId: string,
): Promise<string | null> {
  let memo = environmentProjects.get(ctx);
  if (memo === undefined) {
    memo = new Map();
    environmentProjects.set(ctx, memo);
  }

  const cached = memo.get(environmentId);
  if (cached !== undefined) return cached;

  const rows = await ctx.db
    .select({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);

  const projectId = rows[0]?.projectId ?? null;
  memo.set(environmentId, projectId);
  return projectId;
}

/**
 * The effective role at a scope, or `null` for "no access at all".
 *
 * Grants are INHERITED downwards: a global grant covers every project, a
 * project grant covers every environment in it. They are never inherited
 * upwards -- an environment admin is not a project admin.
 *
 * Takes `Scope` from `core/context.ts` directly. This function used to declare
 * a widened `AuthorizationScope` of its own, because `Scope`'s environment
 * variant could not name the environment's project and a project-scoped grant
 * covers every environment under it. `Scope` now carries an optional
 * `projectId` on that variant, so the local type is gone and there is one scope
 * type in the codebase again.
 */
export async function resolveEffectiveRole(ctx: CoreContext, scope: Scope): Promise<Role | null> {
  const snapshot = await resolveAuthorization(ctx);

  if (snapshot.disabled) return null;

  // The bootstrap var grants global admin, and it does so by the SAME
  // inheritance rules as a real global grant -- there is no separate path that
  // skips scope resolution.
  const effectiveGlobal = maxRole(
    snapshot.globalRole,
    snapshot.bootstrap || isBootstrapAdmin(ctx.config, ctx.actor.subject) ? "admin" : null,
  );

  if (scope.type === "global") return effectiveGlobal;

  if (scope.type === "project") {
    return maxRole(effectiveGlobal, snapshot.byProject.get(scope.projectId) ?? null);
  }

  // Present when the caller already loaded the environment row -- which is every
  // caller in `core` -- and looked up and memoised for this request when not.
  const projectId = scope.projectId ?? (await projectOfEnvironment(ctx, scope.environmentId));

  const fromProject = projectId === null ? null : (snapshot.byProject.get(projectId) ?? null);

  return maxRole(
    maxRole(effectiveGlobal, fromProject),
    snapshot.byEnvironment.get(scope.environmentId) ?? null,
  );
}

export async function can(ctx: CoreContext, scope: Scope, required: Role): Promise<boolean> {
  const role = await resolveEffectiveRole(ctx, scope);
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * Throw `PrickError('FORBIDDEN')` unless the actor holds at least `required`
 * at `scope`.
 *
 * EVERY denial is audited with `outcome: 'denied'` BEFORE it throws -- that is
 * what populates the "Seen but not granted" screen, and it is the only way an
 * operator ever learns that a service token exists. `common_name` is an opaque
 * hex string; nobody maps `e367826f93b8d71185e03fe518aff3b4.access` to "staging
 * deploy" by looking at it. The denial row is the introduction.
 */
export async function assertCan(ctx: CoreContext, scope: Scope, required: Role): Promise<void> {
  if (await can(ctx, scope, required)) return;

  const snapshot = await resolveAuthorization(ctx);

  await recordDenial(ctx, {
    action: `authz.${scope.type}.${required}`,
    scope,
    disabled: snapshot.disabled,
  });

  throw new PrickError("FORBIDDEN", "You do not have permission to perform this action.", {
    hint: snapshot.disabled
      ? "This identity is disabled. An administrator must re-enable it."
      : 'An administrator can grant access from the Access screen; your subject now appears under "Seen but not granted".',
    detail: { required, scope: scope.type },
  });
}

/**
 * A standalone denial audit row.
 *
 * TODO(build order step 12): move to `core/audit.ts` as `recordAudit`. It lives
 * here for now because `assertCan` cannot be correct without it -- a denial
 * that is not recorded is a service token that never appears in the UI -- and
 * the audit module is written after this one.
 *
 * Deliberately best-effort: an audit failure must not convert a 403 into a 500,
 * because that would let a caller distinguish "denied" from "denied and the log
 * broke". Mutations, by contrast, carry their audit row inside the same
 * `batch()` and DO fail with it.
 */
async function recordDenial(
  ctx: CoreContext,
  input: { action: string; scope: Scope; disabled: boolean },
): Promise<void> {
  const snapshot = await resolveAuthorization(ctx);

  const projectId = input.scope.type === "project" ? input.scope.projectId : null;
  const environmentId = input.scope.type === "environment" ? input.scope.environmentId : null;

  try {
    await ctx.db.insert(auditLog).values({
      id: uuidv7(ctx.now),
      ts: ctx.now,
      requestId: ctx.requestId,
      actorKind: ctx.actor.kind,
      actorSubject: ctx.actor.subject,
      identityId: snapshot.identityId,
      action: input.action,
      outcome: "denied",
      projectId,
      environmentId,
      targetKey: null,
      detail: JSON.stringify({ disabled: input.disabled }),
    });
  } catch {
    // Swallowed on purpose -- see the note above.
  }
}

/** The `Actor` with the facts only the database knows filled in. */
export async function hydrateActor(ctx: CoreContext): Promise<Actor> {
  const snapshot = await resolveAuthorization(ctx);

  return {
    kind: ctx.actor.kind,
    subject: ctx.actor.subject,
    identityId: snapshot.identityId,
    bootstrap: snapshot.bootstrap,
  };
}
