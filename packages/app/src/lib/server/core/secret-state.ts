import { sql } from "drizzle-orm";

import type { CoreContext } from "./context.js";

/**
 * The prior state of an environment's keys, read ONCE per mutation.
 *
 * This lives on its own because it is the shared PRECONDITION of every path
 * that writes: the bulk write in `secrets.ts` and the rename/rollback pair in
 * `secret-moves.ts` all begin by asking the same question -- what version
 * number does this key continue from, and is it live? -- and all of them are
 * wrong in the same way if the answer is computed from the live table alone.
 *
 * Nothing here decrypts anything. It reads plaintext metadata (key names and
 * version numbers) and no ciphertext at all.
 */

export interface KeyState {
  /** Highest version ever issued for this key, INCLUDING tombstones. */
  maxVersion: number;
  /** Whether a live `secrets` row exists. A tombstoned key is not live. */
  live: boolean;
}

/**
 * ONE query for the entire prior state of an environment's keys.
 *
 * It serves four purposes simultaneously, which is why it is one query and not
 * four:
 *
 *   the AAD version numbers   nextVersion = maxVersion + 1
 *   the delete set            every live key not named in a full replace
 *   the audit diff            added / changed / removed
 *   the write plan            which keys are inserts and which are updates
 *
 * (The fifth thing the design note attributed to it, the `expected_rev` check,
 * comes from the environment row that resolving the slug pair already loaded.
 * It is not a separate read either.)
 *
 * THE UNION IS LOAD-BEARING, and the design note's `SELECT key, version, kid
 * FROM secrets` is not sufficient for two independent reasons:
 *
 *   1. `secrets` HAS NO `kid` COLUMN. The key id lives on `secret_versions`,
 *      deliberately -- it belongs to a version, not to a key, and that is what
 *      makes rekeying a version-preserving operation.
 *
 *   2. Reading only `secrets` misses DELETED keys entirely, and their history is
 *      still there. `secret_versions` has no foreign key on `key` precisely so
 *      that deleting `API_TOKEN` and recreating it CONTINUES the version
 *      sequence. Computing `nextVersion` from the live table alone would issue
 *      version 1 for the recreated key, collide with the surviving history on
 *      `UNIQUE(environment_id, key, version)`, and abort the batch -- forever,
 *      since the retry recomputes the same 1. The key would be permanently
 *      uncreatable, and the error would say "version conflict", which is true
 *      and useless.
 *
 * So the state comes from the union of both tables, aggregated once.
 */
export async function readKeyState(
  ctx: CoreContext,
  environmentId: string,
): Promise<Map<string, KeyState>> {
  const rows = await ctx.db.all<{ key: string; max_version: number; live: number }>(sql`
    SELECT key, MAX(version) AS max_version, MAX(live) AS live
    FROM (
      SELECT key, version, 0 AS live
        FROM secret_versions WHERE environment_id = ${environmentId}
      UNION ALL
      SELECT key, current_version AS version, 1 AS live
        FROM secrets WHERE environment_id = ${environmentId}
    )
    GROUP BY key
  `);

  const state = new Map<string, KeyState>();
  for (const row of rows) {
    state.set(row.key, { maxVersion: Number(row.max_version), live: Number(row.live) === 1 });
  }

  return state;
}
