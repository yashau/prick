import type { BatchItem } from "drizzle-orm/batch";

import type { Database } from "../db/index.js";

/**
 * The D1 batch primitive, and the parameter arithmetic that keeps a bulk write
 * inside ONE of them.
 *
 * `batch()` is a real transaction: "if a statement in the sequence fails ... it
 * aborts or rolls back the entire sequence." Everything in this file exists to
 * make sure a large write remains ONE call to it -- because the moment a write
 * spans two batches, the failure of the second leaves the first committed, which
 * is precisely the defect this whole design is a response to.
 */

export type Statement = BatchItem<"sqlite">;

/**
 * D1's hard limit on BOUND PARAMETERS PER QUERY.
 *
 * Not per batch, and not a statement count -- one query may carry at most this
 * many `?` placeholders. It is what forces a 500-row write to become a sequence
 * of multi-row INSERTs rather than one enormous one, and it is why `rowsPerChunk`
 * below is a division rather than a constant somebody picked.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * How many rows of a `columns`-wide table fit in one multi-row INSERT.
 *
 * VERIFIED AGAINST THE COMMITTED SCHEMA, not against the numbers in the design
 * note, one of which was wrong:
 *
 *   secret_versions   9 columns  -> floor(100/9)  = 11 rows  (99 params)
 *   secrets           8 columns  -> floor(100/8)  = 12 rows  (96 params)
 *
 * The design note said `secrets` had 10 columns and therefore 10 rows per
 * statement. It has EIGHT -- id, environment_id, key, current_version,
 * description, created_at, updated_at, updated_by -- so the true chunk is 12.
 * Deriving the number here rather than writing it down means adding a column to
 * either table re-derives it instead of silently overflowing the limit on the
 * first write large enough to notice.
 *
 * `extraParams` covers statements that bind something in addition to the rows --
 * a `DELETE ... WHERE environment_id = ? AND key IN (...)` spends one parameter
 * before the first key. An upsert's `ON CONFLICT DO UPDATE SET x = excluded.x`
 * spends NONE, which is the reason those clauses reference `excluded` rather
 * than binding the same values a second time.
 */
export function rowsPerChunk(columns: number, extraParams = 0): number {
  const available = D1_MAX_BOUND_PARAMS - extraParams;
  const rows = Math.floor(available / columns);

  /* istanbul ignore next -- unreachable for every table in this schema */
  if (rows < 1) {
    throw new Error(
      `A single row of a ${String(columns)}-column table cannot fit in ${String(
        D1_MAX_BOUND_PARAMS,
      )} bound parameters.`,
    );
  }

  return rows;
}

/** Split `items` into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run a batch.
 *
 * The only reason this wrapper exists is drizzle's signature: `batch()` takes a
 * non-empty TUPLE (`Readonly<[U, ...U[]]>`), so an ordinary `Statement[]` --
 * which is what building a variable number of chunks produces -- does not
 * satisfy it. The cast is confined here, next to the emptiness check that makes
 * it true.
 *
 * An empty array resolves rather than calling `batch([])`, which D1 rejects.
 * Callers reach that case only when a request turned out to be a no-op, and a
 * no-op is not an error.
 */
export async function runBatch(db: Database, statements: Statement[]): Promise<unknown[]> {
  if (statements.length === 0) return [];

  return db.batch(statements as [Statement, ...Statement[]]);
}
