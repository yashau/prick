import type { AuditQuery } from "@prick/shared";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";

import { uuidv7 } from "../db/ids.js";
import { auditLog, environments, projects, type NewAuditEntry } from "../db/schema.js";
import type { CoreContext, Scope } from "./context.js";

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
    detail: input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
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
 * Keyset-paginated audit query.
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
  const conditions = [];

  if (query.project !== undefined) {
    const rows = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, query.project))
      .limit(1);

    // A filter naming a project that does not exist (or that this actor cannot
    // see) yields an EMPTY PAGE, not a 404. The alternative distinguishes
    // "no such project" from "no events", which is the same existence oracle
    // the NOT_FOUND rule closes everywhere else.
    if (rows[0] === undefined) return { entries: [], cursor: null };
    conditions.push(eq(auditLog.projectId, rows[0].id));
  }

  if (query.environment !== undefined) {
    const rows = await ctx.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.slug, query.environment))
      .limit(1);

    if (rows[0] === undefined) return { entries: [], cursor: null };
    conditions.push(eq(auditLog.environmentId, rows[0].id));
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
