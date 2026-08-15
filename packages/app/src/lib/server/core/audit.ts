import type { AuditQuery } from "@prick/shared";
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";

import { assertCan, resolveAuthorization } from "../auth/authorize.js";
import { uuidv7 } from "../db/ids.js";
import { auditLog, environments, projects, type NewAuditEntry } from "../db/schema.js";
import type { CoreContext, Scope } from "./context.js";
import { notFound } from "./errors.js";

/**
 * The audit log.
 *
 * ONE RULE ABOVE ALL OTHERS: a mutation's audit row is the LAST statement of the
 * same `db.batch()` that carries the mutation. Not "written afterwards", not
 * "written best-effort", not "written by a wrapper". Inside. If the audit insert
 * fails, the data write fails with it, so an un-audited mutation is not
 * discouraged -- it is unrepresentable.
 *
 * That is why the primary export here is `auditStatement()`, which RETURNS a
 * statement rather than executing one. `recordAudit()` exists too, and is for
 * the strictly smaller set of events that have no accompanying data write at
 * all: reveals, exports, denials, and read-path decrypt failures. Reaching for
 * it inside a mutation re-creates exactly the hole the batch rule closes.
 */

export type AuditOutcome = "success" | "denied" | "error";

/**
 * The actions this layer emits.
 *
 * A union rather than a bare `string`, so a typo produces a compile error
 * instead of a row that no filter in the UI will ever match and that nobody
 * discovers until they go looking for it.
 */
export type AuditAction =
  | "project.create"
  | "project.update"
  | "project.delete"
  | "environment.create"
  | "environment.update"
  | "environment.delete"
  | "secret.write"
  | "secret.reveal"
  | "secret.export"
  | "secret.list"
  | "secret.rollback"
  | "secret.rename"
  | "secret.import"
  | "identity.update"
  | "grant.create"
  | "grant.revoke"
  | "admin.rekey"
  /** A read or write refused before it reached the resource. */
  | "access.denied";

/**
 * Structured audit detail. TYPED, and typed for exactly one reason.
 *
 * `detail` is a JSON blob in a TEXT column, so `Record<string, unknown>` would
 * typecheck for `{ value: plaintext }` as happily as for anything else. This
 * union is the mechanism that makes the AGENTS.md rule ("audit detail must never
 * carry a secret value") a compile error rather than a review comment: there is
 * no member with a field that could hold one, and adding one would be a visible,
 * deliberate edit to this type.
 *
 * KEY NAMES ARE FINE and appear throughout -- they are stored in plaintext in
 * `secrets.key` and are what makes the log useful. VALUES ARE NOT REPRESENTABLE.
 */
export type AuditDetail =
  | {
      kind: "secret.diff";
      mode: "merge" | "replace";
      added: readonly string[];
      changed: readonly string[];
      removed: readonly string[];
      /** Operator-supplied, length-bounded by the schema. Never a value. */
      reason?: string;
      /** Set when the write was retried after losing a version race. */
      retried?: boolean;
    }
  | {
      kind: "secret.read";
      /** 'reveal' | 'copy' | 'export' | 'run'. */
      reason: string;
      /** How many keys the read covered. An export names no keys at all. */
      count: number;
    }
  | {
      kind: "secret.unreadable";
      /** The keys whose stored envelope failed to open. Names only. */
      keys: readonly string[];
      /** The kid the failing rows named, when they agreed on one. */
      kid?: string | null;
    }
  | {
      kind: "secret.version";
      key: string;
      from: number;
      to: number;
      reason?: string;
    }
  | {
      kind: "secret.rename";
      from: string;
      to: string;
      version: number;
    }
  | {
      kind: "resource";
      slug: string;
      /** Which fields changed, by name. Never their contents. */
      fields?: readonly string[];
      /** Rows removed by the FK cascade, for a delete. */
      cascade?: Record<string, number>;
    }
  | {
      kind: "grant";
      role: string;
      scopeType: string;
      subject: string;
      expiresAt: number | null;
    }
  | {
      kind: "identity";
      subject: string;
      fields: readonly string[];
    }
  | {
      kind: "denial";
      /** 'global' | 'project' | 'environment'. */
      scope: string;
      required: string;
      /** What was being reached for, e.g. "project". Never its slug. */
      resource: string;
    };

export interface AuditInput {
  action: AuditAction;
  outcome: AuditOutcome;
  projectId?: string | null;
  environmentId?: string | null;
  /** The secret key name, when the action concerns exactly one. Never a value. */
  targetKey?: string | null;
  detail?: AuditDetail | null;
}

/**
 * Build the row. Does not write it.
 *
 * Split out from `auditStatement` so the write path can inspect what it is about
 * to record -- the atomicity regression test asserts on the absence of a row,
 * and being able to build one without writing it is what lets a test compare
 * shapes rather than substrings.
 */
export function buildAuditRow(ctx: CoreContext, input: AuditInput): NewAuditEntry {
  return {
    id: uuidv7(ctx.now),
    ts: ctx.now,
    requestId: ctx.requestId,
    actorKind: ctx.actor.kind,
    actorSubject: ctx.actor.subject,
    identityId: ctx.actor.identityId,
    action: input.action,
    outcome: input.outcome,
    projectId: input.projectId ?? null,
    environmentId: input.environmentId ?? null,
    targetKey: input.targetKey ?? null,
    detail:
      input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
  };
}

/**
 * The audit INSERT, as a statement to append to a `batch()`.
 *
 * THIS IS THE ONE TO USE FROM A MUTATION, and it must be the LAST element of the
 * array handed to `db.batch()`.
 */
export function auditStatement(ctx: CoreContext, input: AuditInput) {
  return ctx.db.insert(auditLog).values(buildAuditRow(ctx, input));
}

/**
 * Write a standalone audit row.
 *
 * ONLY for events with no accompanying data write: a reveal, an export, a
 * denial, a decrypt failure on a read path. Every one of those is a read, so
 * there is no batch for the row to ride in and nothing for its failure to roll
 * back.
 *
 * NOT best-effort, unlike the denial path in `auth/authorize.ts`. A reveal whose
 * audit row is lost is a secret that left the building with no record of it
 * having done so, and the caller should learn that the reveal did not complete
 * rather than receive the value with the log silently short. The one place that
 * inversion is correct is a denial, where failing loudly would let a caller
 * distinguish "denied" from "denied and the log broke".
 */
export async function recordAudit(ctx: CoreContext, input: AuditInput): Promise<void> {
  await ctx.db.insert(auditLog).values(buildAuditRow(ctx, input));
}

/**
 * Record a denial. BEST-EFFORT, and deliberately the one exception to the rule
 * above.
 *
 * An audit failure must not turn a refusal into a 500. If it did, a caller could
 * distinguish "refused" from "refused, and the log write failed" by the status
 * code -- a side channel out of the one path whose entire job is to reveal
 * nothing. So this swallows, and the mutation paths, which carry their audit row
 * inside the batch, do not.
 */
export async function recordDenial(
  ctx: CoreContext,
  input: { scope: Scope; required: string; resource: string },
): Promise<void> {
  const projectId = input.scope.type === "project" ? input.scope.projectId : null;
  const environmentId = input.scope.type === "environment" ? input.scope.environmentId : null;

  try {
    await recordAudit(ctx, {
      action: "access.denied",
      outcome: "denied",
      projectId,
      environmentId,
      detail: {
        kind: "denial",
        scope: input.scope.type,
        required: input.required,
        resource: input.resource,
      },
    });
  } catch {
    // See above. Intentionally silent.
  }
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

export interface AuditEntryView {
  id: string;
  ts: number;
  requestId: string | null;
  actorKind: string;
  actorSubject: string;
  action: string;
  outcome: string;
  projectId: string | null;
  environmentId: string | null;
  targetKey: string | null;
  detail: unknown;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass back as `cursor` for the next page. `null` at the end of the log. */
  cursor: string | null;
}

/**
 * ---------------------------------------------------------------------------
 * WHO MAY READ THE LOG, AND HOW MUCH OF IT
 * ---------------------------------------------------------------------------
 *
 * THE LINE IS ADMIN, AT A SCOPE. Not reader, not writer, and this is the one
 * decision in this file worth arguing with, so here is the argument.
 *
 * An audit row is not a secret value -- the `AuditDetail` union is built so that
 * it cannot be. But it is three other things: the roster of humans and service
 * tokens that touched a scope, the times at which each of them did, and the
 * `access.denied` rows naming subjects that were refused. A reader on one
 * environment already knows its key names, because reading the values is what
 * their grant is for; what their grant is NOT for is enumerating the people and
 * the machine credentials around it, or learning which subjects have been
 * probing it and failing. "May read the secrets" and "may audit who read the
 * secrets" are different sentences, and only the second is a statement about
 * other people.
 *
 * Admin is also the line the rest of the access graph already draws:
 * `listIdentities` and `listGrants` gate on admin-at-any-scope and then narrow
 * per row to what the actor administers. The log is the same information viewed
 * from the other end -- what was done with the access, rather than who holds it
 * -- so it takes the same rule rather than inventing a second one.
 *
 * Erring restrictive is deliberate. Too restrictive is a bug an operator
 * reports on the first afternoon; too permissive is a disclosure nobody reports
 * because nobody notices.
 *
 * The resulting matrix:
 *
 *   global admin        every row, unfiltered.
 *   project admin       rows carrying that project, AND rows carrying one of
 *                       its environments. Nothing else.
 *   environment admin   rows carrying that environment. Not its project's
 *                       other environments, and not the project's own rows --
 *                       grants inherit downwards only.
 *   below admin         403, audited like every other denial.
 *   disabled identity   403. The kill switch outranks every grant.
 */
type AuditView =
  | { kind: "all" }
  | {
      kind: "scoped";
      /** Projects administered outright. Their rows are visible wholesale. */
      projectIds: readonly string[];
      /**
       * Every environment whose rows are visible: administered directly, or
       * belonging to an administered project.
       */
      environmentIds: readonly string[];
      /**
       * Projects `?project=` may NAME. A superset of `projectIds`: it also holds
       * the project of every directly-administered environment, so an
       * environment admin can still address their own environment's history --
       * which the UI does as `{project, environment}`. Naming the project widens
       * nothing, because the view condition is ANDed with the filter: it selects
       * within what is already visible.
       */
      addressableProjectIds: readonly string[];
    };

/**
 * Resolve what this actor may see, or refuse.
 *
 * Built from the authorization snapshot that has ALREADY been resolved for this
 * request, plus at most ONE query. That query does double duty: it expands
 * administered projects into their environment ids and, in the same pass, finds
 * the project of every administered environment.
 */
async function resolveAuditView(ctx: CoreContext): Promise<AuditView> {
  const snapshot = await resolveAuthorization(ctx);

  if (!snapshot.disabled) {
    if (snapshot.bootstrap || snapshot.globalRole === "admin") return { kind: "all" };

    const adminProjects = adminScopes(snapshot.byProject);
    const adminEnvironments = adminScopes(snapshot.byEnvironment);

    if (adminProjects.length > 0 || adminEnvironments.length > 0) {
      const rows = await ctx.db
        .select({ id: environments.id, projectId: environments.projectId })
        .from(environments)
        .where(
          or(
            adminProjects.length > 0 ? inArray(environments.projectId, adminProjects) : undefined,
            adminEnvironments.length > 0 ? inArray(environments.id, adminEnvironments) : undefined,
          ),
        );

      const directly = new Set(adminEnvironments);
      // Seeded with the grants themselves, so a grant naming an environment that
      // has since been deleted still cannot be widened by its absence.
      const environmentIds = new Set(adminEnvironments);
      const addressable = new Set(adminProjects);

      for (const row of rows) {
        environmentIds.add(row.id);
        if (directly.has(row.id)) addressable.add(row.projectId);
      }

      return {
        kind: "scoped",
        projectIds: adminProjects,
        environmentIds: [...environmentIds],
        addressableProjectIds: [...addressable],
      };
    }
  }

  /*
   * No admin anywhere. Routed through the standard denial path rather than a
   * bare throw, so the refusal is audited and the subject appears in "Seen but
   * not granted" exactly as it would for any other route -- a grantless service
   * token pointed at `/audit` is how that token first becomes visible to an
   * operator.
   *
   * The scope named is `global`, which is honest: what the actor lacks is admin
   * anywhere at all. It also names no resource, so the 403 is not an existence
   * oracle the way a resource-addressed one would be.
   */
  await assertCan(ctx, { type: "global" }, "admin");

  /* istanbul ignore next -- assertCan always throws once we are in this branch */
  throw notFound("audit");
}

/** The ids from a snapshot map whose role is exactly `admin`. */
function adminScopes(roles: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, role] of roles) if (role === "admin") out.push(id);
  return out;
}

/**
 * `project_id IN (...) OR environment_id IN (...)`, dropping either half when
 * its list is empty.
 *
 * The environment half is not redundant, and removing it is the mistake this
 * comment exists to prevent. A denial recorded at an environment scope carries
 * `environment_id` and a NULL `project_id` -- there is no project on that scope
 * to record -- so filtering a project admin's view on `project_id` alone would
 * silently drop exactly the rows they most need: the refusals inside their own
 * project. Teaching the writers to backfill `project_id` would fix new rows and
 * not the log, which is append-only and historical; the read side has to be
 * right for every row ever written.
 */
function coversAnyOf(
  projectIds: readonly string[],
  environmentIds: readonly string[],
): SQL | undefined {
  const parts: SQL[] = [];

  if (projectIds.length > 0) parts.push(inArray(auditLog.projectId, [...projectIds]));
  if (environmentIds.length > 0) parts.push(inArray(auditLog.environmentId, [...environmentIds]));

  return or(...parts);
}

/**
 * Resolve `?project=` THROUGH THE VIEW, so an unauthorized slug is `NOT_FOUND`.
 *
 * Both failures -- no such project, and a project this actor may not audit --
 * end at the same zero-argument `notFound("project")`, built the same way, with
 * the same hint. Splitting them would make the filter an oracle for which
 * project names are in use: a caller with an admin grant on one small project
 * could walk a slug dictionary and read the difference between 403 and 404 off
 * an organisation they have nothing to do with. Slugs are things like
 * `acme-payroll-migration`.
 *
 * Only the unauthorized branch records a denial. There is nothing to be denied
 * about a project that does not exist, and auditing one would fill "Seen but
 * not granted" with the noise of mistyped slugs.
 */
async function resolveProjectFilter(
  ctx: CoreContext,
  view: AuditView,
  slug: string,
): Promise<string> {
  const rows = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);

  const id = rows[0]?.id;
  if (id === undefined) throw notFound("project");

  if (view.kind === "all" || view.addressableProjectIds.includes(id)) return id;

  await recordDenial(ctx, {
    scope: { type: "project", projectId: id },
    required: "admin",
    resource: "audit",
  });

  throw notFound("project");
}

/**
 * Resolve `?environment=` to EVERY matching environment, within the view.
 *
 * Never a bare `WHERE slug = ? LIMIT 1`. Environment slugs are unique only
 * WITHIN a project -- `environments_project_slug_uniq` is a composite index --
 * so a global lookup for `prod` finds an arbitrary project's production
 * environment and answers a question nobody asked. Paired with `?project=` this
 * resolves the slug PAIR exactly, which is what every caller in the UI sends;
 * unpaired it means "every environment by that name that you may audit", which
 * is the only reading of an ambiguous slug that is not a coin toss.
 *
 * An environment outside the view is `NOT_FOUND`, for the same reason the
 * project filter is.
 */
async function resolveEnvironmentFilter(
  ctx: CoreContext,
  view: AuditView,
  projectId: string | null,
  slug: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: environments.id })
    .from(environments)
    .where(
      projectId === null
        ? eq(environments.slug, slug)
        : and(eq(environments.projectId, projectId), eq(environments.slug, slug)),
    );

  const ids = rows
    .map((row) => row.id)
    .filter((id) => view.kind === "all" || view.environmentIds.includes(id));

  if (ids.length === 0) throw notFound("environment");

  return ids;
}

/**
 * Keyset-paginated audit query.
 *
 * AUTHORIZATION IS THE FIRST STATEMENT, and it lives here rather than in a
 * route guard for the reason the whole `core` layer exists: a Hono handler and a
 * SvelteKit server load both enter through this function, and a check written in
 * one of those transports is a check the other does not have. It also could not
 * be written there even if that were acceptable -- a yes/no gate at the door
 * cannot express "this project admin sees their own project", which needs the
 * visible set folded into the WHERE clause the way `listProjects` does.
 *
 * SCOPED IN THE QUERY, never filtered afterwards. A post-filter over "all
 * events" has, at the moment it runs, already loaded rows the actor may not see,
 * and every subsequent addition -- a count, a total, a facet -- is then computed
 * over the wrong set by default. The pagination is the immediate proof: a page
 * of 50 filtered down to 3 would report a cursor derived from rows the caller
 * was never entitled to.
 *
 * Paginates on the UUIDv7 primary key (`WHERE id < :cursor ORDER BY id DESC`)
 * and NEVER on OFFSET. The log is append-only and grows under the reader, so
 * every insert between two OFFSET pages shifts the window by one and makes the
 * reader silently skip a row -- a paginator that loses audit entries only while
 * something is actively happening is worse than one that fails outright.
 *
 * This is the whole reason ids are v7 rather than `crypto.randomUUID()`: v4 ids
 * have no temporal order, so `id < cursor` would select an arbitrary subset.
 */
export async function queryAudit(ctx: CoreContext, query: AuditQuery): Promise<AuditPage> {
  const view = await resolveAuditView(ctx);

  const conditions: SQL[] = [];

  if (view.kind === "scoped") {
    const scoped = coversAnyOf(view.projectIds, view.environmentIds);

    // `resolveAuditView` only returns `scoped` when at least one admin grant
    // produced an id, so this is never the whole log unfiltered.
    /* istanbul ignore next -- unreachable; a scoped view always has one id */
    if (scoped === undefined) return { entries: [], cursor: null };

    conditions.push(scoped);
  }

  let projectId: string | null = null;

  if (query.project !== undefined) {
    projectId = await resolveProjectFilter(ctx, view, query.project);

    // The project's own rows AND its environments'. Anything else would hide an
    // environment-scoped denial from the admin of the project it happened in.
    const environmentRows = await ctx.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, projectId));

    const covered = coversAnyOf(
      [projectId],
      environmentRows.map((row) => row.id),
    );

    /* istanbul ignore else -- the project id alone always produces a condition */
    if (covered !== undefined) conditions.push(covered);
  }

  if (query.environment !== undefined) {
    const ids = await resolveEnvironmentFilter(ctx, view, projectId, query.environment);
    conditions.push(inArray(auditLog.environmentId, ids));
  }

  if (query.actor !== undefined) conditions.push(eq(auditLog.actorSubject, query.actor));
  if (query.action !== undefined) conditions.push(eq(auditLog.action, query.action));
  if (query.outcome !== undefined) conditions.push(eq(auditLog.outcome, query.outcome));
  if (query.since !== undefined) conditions.push(gte(auditLog.ts, query.since));
  if (query.until !== undefined) conditions.push(lte(auditLog.ts, query.until));
  if (query.cursor !== undefined) conditions.push(lt(auditLog.id, query.cursor));

  // One row over the page size, so "is there a next page" is answered without a
  // second COUNT query against a table that only grows.
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;

  return {
    entries: page.map((row) => ({
      id: row.id,
      ts: row.ts,
      requestId: row.requestId,
      actorKind: row.actorKind,
      actorSubject: row.actorSubject,
      action: row.action,
      outcome: row.outcome,
      projectId: row.projectId,
      environmentId: row.environmentId,
      targetKey: row.targetKey,
      detail: parseDetail(row.detail),
    })),
    cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Parse a stored `detail` blob.
 *
 * Returns `null` rather than throwing on malformed JSON. This is the one place
 * in the codebase where swallowing is right: the audit log is append-only and
 * historical, so a row written by an older build with a shape this one cannot
 * parse must still be listable. Refusing the whole page because one historical
 * row is odd would make the log unreadable exactly when it is being consulted.
 */
function parseDetail(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
