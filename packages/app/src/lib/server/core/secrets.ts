import type { BatchBody, ImportBody, RollbackBody } from "@prick/shared";

import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

/**
 * A secret as it appears in a LIST. There is no value here, and there must
 * never be one -- this is what the SSR-rendered screens and the audit views
 * consume.
 */
export interface SecretListEntry {
  key: string;
  description: string | null;
  version: number;
  updatedAt: number;
  updatedBy: string;
  /**
   * `true` when the stored envelope failed to decrypt or failed its AEAD tag.
   *
   * NOT swallowed, NOT skipped. A catch-and-continue around decryption turns a
   * tamper attempt into a QUIETLY SHORTER .env file -- which is how you deploy
   * production without DATABASE_URL and find out from an outage. Here the row
   * is returned marked unreadable, the UI renders it red, and the read is
   * audited with `outcome: 'error'`. A tamper attempt must be the loudest
   * thing in the system.
   */
  unreadable: boolean;
}

export function listSecrets(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
): Promise<SecretListEntry[]> {
  return notImplemented("listSecrets");
}

/**
 * TODO(build order step 13): decrypt and return ONE value.
 *
 * Audited before it returns, with the caller's `reason` ('reveal' | 'copy' |
 * 'export' | 'run'). A decrypt failure here FAILS THE REQUEST with
 * DECRYPT_FAILED -- it is never downgraded to an empty string or an omitted
 * key.
 *
 * Fetches exactly the one row. Upstream's `secrets get` downloaded every secret
 * in the environment to print one of them, which meant reading one value
 * decrypted all of them in memory and audited none of them individually.
 */
export function revealSecret(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _key: string,
  _reason: string,
): Promise<string> {
  return notImplemented("revealSecret");
}

/**
 * TODO(build order step 13): THE write path. Build this first, with its
 * regression test, before reveal/export/versions/rollback.
 *
 * Exactly one D1 `batch()`, which is a real transaction: "if a statement in the
 * sequence fails ... it aborts or rolls back the entire sequence."
 *
 *   1. ONE read for existing keys and versions. It serves four purposes at
 *      once: the AAD version numbers, the delete set, the audit diff, and the
 *      `expected_rev` check.
 *   2. Compute in JS. Encrypt each value under AAD(env_id, key, nextVersion).
 *      NEVER copy an existing ciphertext blob -- a new version is a fresh
 *      encryption.
 *   3. ONE batch(), in this order:
 *        rev guard / bump
 *        multi-row INSERT into secret_versions   (9 cols -> 11 rows per stmt)
 *        multi-row upsert into secrets
 *        tombstone rows for deletions
 *        DELETE FROM secrets WHERE key IN (...)
 *        INSERT INTO audit_log                   <- LAST
 *
 * The audit insert is inside the batch on purpose: if it fails, the data write
 * fails with it, so an un-audited mutation cannot exist.
 *
 * On a `secret_versions` unique violation (a concurrent writer won the race):
 * retry ONCE against the re-read state, then return VERSION_CONFLICT (409).
 *
 * REGRESSION TEST TO WRITE FIRST: seed 5 secrets, issue a full replace whose
 * 3rd row fails, then assert the environment still has exactly the original 5,
 * at the original `rev`, and that NO audit row was written.
 */
export function writeSecrets(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _input: BatchBody,
): Promise<{ rev: number; added: string[]; changed: string[]; removed: string[] }> {
  return notImplemented("writeSecrets");
}

/**
 * TODO(build order step 13): parse a .env/JSON blob and either report the diff
 * (`dry_run`) or apply it through `writeSecrets`.
 *
 * The dry-run response carries KEY names and change kinds only. It must not
 * echo values in either direction, including for "changed" rows -- "old vs new"
 * is exactly the shape that leaks two secrets instead of one.
 */
export function importSecrets(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _input: ImportBody,
): Promise<{ added: string[]; changed: string[]; removed: string[]; applied: boolean }> {
  return notImplemented("importSecrets");
}

/**
 * TODO(build order step 13): decrypt every value in the environment for
 * export.
 *
 * Response gets `Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control:
 * no-store` and `Vary: Cf-Access-Jwt-Assertion`, applied by middleware bound to
 * this route. One audit row for the export as a whole, not one per key.
 */
export function exportSecrets(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
): Promise<Record<string, string>> {
  return notImplemented("exportSecrets");
}

export interface VersionEntry {
  version: number;
  op: string;
  createdAt: number;
  createdBy: string;
  kid: string | null;
  /** A tombstone: this version records the key's deletion. */
  deleted: boolean;
}

export function listVersions(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _key: string,
): Promise<VersionEntry[]> {
  return notImplemented("listVersions");
}

/**
 * TODO(build order step 13): roll a key back to an earlier version.
 *
 * Decrypt version N, re-encrypt as `current + 1` with `op = 'rollback'`. The
 * old envelope is NEVER resurrected: its AAD binds it to version N, so writing
 * it back as the current value would either fail the tag check or, worse,
 * succeed and leave a value whose AAD no longer matches its row.
 */
export function rollbackSecret(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _input: RollbackBody,
): Promise<{ rev: number; version: number }> {
  return notImplemented("rollbackSecret");
}

/**
 * TODO(build order step 13): rename a key.
 *
 * There is no cheap rename. Decrypt under AAD(oldKey, vN), re-encrypt under
 * AAD(newKey, vN+1), and write both in one batch. Moving the ciphertext would
 * break the AEAD binding that makes cross-key transplant impossible -- which is
 * the entire point of having it.
 */
export function renameSecret(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
  _oldKey: string,
  _newKey: string,
): Promise<{ rev: number }> {
  return notImplemented("renameSecret");
}
