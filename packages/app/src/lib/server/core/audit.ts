import type { AuditQuery } from "@prick/shared";

import type { NewAuditEntry } from "../db/schema.js";
import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

export type AuditOutcome = "success" | "denied" | "error";

export interface AuditInput {
  action: string;
  outcome: AuditOutcome;
  projectId?: string | null;
  environmentId?: string | null;
  targetKey?: string | null;
  /** MUST NOT contain a secret value, a ciphertext, or zod's `issue.input`. */
  detail?: Record<string, unknown> | null;
}

/**
 * TODO(build order step 12): build the audit row for a mutation.
 *
 * This returns a ROW, it does not write one. Mutations append it as the LAST
 * statement of the same D1 `batch()` that carries the data, so that a failed
 * audit write fails the mutation. Anything that writes audit rows on their own
 * connection has re-created the un-audited-mutation hole.
 *
 * Build audit BEFORE the write paths (step 12 precedes step 13) so that no
 * route can be written un-audited in the first place.
 */
export function buildAuditRow(_ctx: CoreContext, _input: AuditInput): NewAuditEntry {
  return notImplemented("buildAuditRow");
}

/**
 * TODO(build order step 12): write a standalone audit row.
 *
 * Only for events with no accompanying data write -- reveals, exports,
 * denials, and the bootstrap self-heal. Never for mutations.
 */
export function recordAudit(_ctx: CoreContext, _input: AuditInput): Promise<void> {
  return notImplemented("recordAudit");
}

/**
 * TODO(build order step 12): keyset-paginated audit query.
 *
 * Paginate on the UUIDv7 primary key (`WHERE id < :cursor ORDER BY id DESC`),
 * never on OFFSET: an append-only log grows under the reader, and OFFSET
 * pagination silently repeats and skips rows as it does.
 */
export function queryAudit(
  _ctx: CoreContext,
  _query: AuditQuery,
): Promise<{ entries: unknown[]; cursor: string | null }> {
  return notImplemented("queryAudit");
}
