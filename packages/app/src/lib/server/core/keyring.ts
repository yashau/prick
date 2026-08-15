import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

export interface KeyringStatus {
  activeKid: string;
  entries: {
    kid: string;
    status: "active" | "retiring" | "retired";
    rowsRemaining: number;
    lastRekeyAt: number | null;
  }[];
  /**
   * True only when every non-active kid has `rowsRemaining === 0`.
   *
   * The settings screen renders this as the "safe to remove MASTER_KEY_OLD"
   * indicator. Removing the old key while rows still reference a retired kid
   * is the ONE irreversible mistake available in this design -- those values
   * can never be decrypted again -- so the UI has to be what tells you, and it
   * only goes green at zero.
   */
  safeToRemoveOldKey: boolean;
}

export function getKeyringStatus(_ctx: CoreContext): Promise<KeyringStatus> {
  return notImplemented("getKeyringStatus");
}

/**
 * TODO(build order step 8+): re-encrypt a bounded page of rows onto the active
 * key.
 *
 * Re-encrypt under the IDENTICAL AAD with the new `kid`; the version does NOT
 * change. That is exactly why `kid` lives in the envelope and not in the AAD --
 * a rekey must not alter the row's identity, only the key that protects it.
 *
 * Incremental and resumable: driven by a cron trigger and by
 * `POST /api/v1/admin/rekey`, processing a page per invocation so a large
 * database does not need a 30 s batch.
 */
export function rekeyPage(
  _ctx: CoreContext,
  _limit: number,
): Promise<{ rekeyed: number; remaining: number }> {
  return notImplemented("rekeyPage");
}
