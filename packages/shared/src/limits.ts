/**
 * Hard limits shared by the Worker, the UI and (by documentation) the CLI.
 *
 * These are DEFAULTS. The Worker re-reads the effective values from its
 * `vars` (`SECRET_MAX_BYTES`, `ENV_MAX_SECRETS`, `BODY_MAX_BYTES`) so an
 * operator can lower them without a code change; the constants here are what
 * the schemas validate against when no override is supplied, and what the UI
 * uses to show a character/byte counter before a request is made.
 */

/** Maximum length of a secret key name, in UTF-8 bytes. */
export const SECRET_KEY_MAX_LENGTH = 256;

/** Maximum size of a single decrypted secret value, in UTF-8 bytes. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

/** Maximum length of a project/environment slug. */
export const SLUG_MAX_LENGTH = 64;

/**
 * Maximum number of secrets in one environment.
 *
 * A full-environment replace must fit in a single D1 `batch()` because
 * splitting it across batches would forfeit atomicity, and `batch()` has a
 * documented 30 s ceiling on the whole call. 500 is derived from that ceiling
 * against an undocumented per-batch statement limit and MUST be load-tested
 * before it is trusted; if the test says otherwise, lower this number rather
 * than splitting the batch.
 */
export const ENV_MAX_SECRETS = 500;

/** Maximum request body size accepted by the API, in bytes. */
export const BODY_MAX_BYTES = 1024 * 1024;

/** Maximum length of a free-text description attached to a project/env/secret. */
export const DESCRIPTION_MAX_LENGTH = 1024;

/** Maximum length of the operator-supplied `reason` recorded in the audit log. */
export const REASON_MAX_LENGTH = 512;
