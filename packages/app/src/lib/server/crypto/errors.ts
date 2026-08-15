/**
 * The crypto layer's own error taxonomy.
 *
 * It is deliberately independent of `core/errors.ts`. `core` throws
 * `PrickError`, which carries an HTTP status, and this module must be usable
 * from places that have no request at all -- an import script, a cron-driven
 * rekey, a unit test. Keeping the two apart also means the crypto layer can
 * distinguish failures that `core`'s taxonomy does not model, and the transport
 * decides how loud each one is.
 *
 * Every class below is exported so that a test can assert on the SHAPE of a
 * rejection rather than on a substring of a message. "It threw something" is
 * not the property the tamper suite needs to establish.
 *
 * Intended transport mapping (the transport owns this, not us):
 *
 *   SERVER_MISCONFIGURED  500  fail closed, EVERY route including /health
 *   DECRYPT_FAILED        500  surfaced loudly, never swallowed
 *   UNKNOWN_KID           500  names the kid; it is an operator error, not a
 *                              client error, and the kid is not secret
 *   CRYPTO_FORMAT         500  a stored blob is not parseable
 *   CRYPTO_INPUT          422  a caller handed us an unencodable identity
 *   PAYLOAD_TOO_LARGE     413
 *
 * RULE FOR EVERY MESSAGE IN THIS FILE AND EVERY CALLER OF IT: a message may
 * name a key, an environment id, a version, a kid, a byte count limit or a
 * format byte. It may never contain a plaintext value, a ciphertext, or master
 * key material -- these strings reach logs, HTTP responses and audit rows.
 */

export type CryptoErrorCode =
  | "SERVER_MISCONFIGURED"
  | "DECRYPT_FAILED"
  | "UNKNOWN_KID"
  | "CRYPTO_FORMAT"
  | "CRYPTO_INPUT"
  | "PAYLOAD_TOO_LARGE";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The master key material is absent, malformed, or internally inconsistent.
 *
 * This is the fail-closed error. It is raised while PARSING configuration, not
 * on first use, so a Worker with a bad `MASTER_KEY` refuses every route --
 * including `/health` -- rather than serving happily until the first secret is
 * read and then failing in a way nobody connects to the deploy.
 */
export class MasterKeyConfigError extends CryptoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("SERVER_MISCONFIGURED", message, options);
  }
}

/** A stored envelope is not in a format this build can parse. */
export class CryptoFormatError extends CryptoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CRYPTO_FORMAT", message, options);
  }
}

/** A caller supplied an identity or parameter that cannot be encoded. */
export class CryptoInputError extends CryptoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CRYPTO_INPUT", message, options);
  }
}

/**
 * The envelope names a key id the loaded keyring does not hold.
 *
 * NAMES THE KID, and lists the ones that ARE loaded. A generic "decryption
 * failed" cannot distinguish "you removed MASTER_KEY_OLD too early" from "this
 * row has been tampered with", and those two need opposite responses: put the
 * key back, versus investigate a compromise.
 */
export class UnknownKeyError extends CryptoError {
  readonly kid: string;
  readonly knownKids: readonly string[];

  constructor(kid: string, knownKids: readonly string[]) {
    super(
      "UNKNOWN_KID",
      `No master key with id ${kid} is loaded. The keyring holds: ${
        knownKids.length > 0 ? knownKids.join(", ") : "(none)"
      }. If ${kid} is a key you have retired, restore it in MASTER_KEY_OLD; ` +
        "if it is not, this row did not come from this deployment.",
    );
    this.kid = kid;
    this.knownKids = knownKids;
  }
}

/**
 * Authenticated decryption failed.
 *
 * Which means one of: the ciphertext was altered, the tag was altered, the IV
 * was altered, or the row is being presented under an identity it was not
 * sealed against -- a different environment, a different key name, a different
 * version. All of those are the same event to AES-GCM and all of them are
 * loud. Nothing in this codebase may catch this and continue with a shorter
 * result set.
 */
export class DecryptFailedError extends CryptoError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("DECRYPT_FAILED", message, options);
  }
}

/** The plaintext exceeds the configured per-value byte ceiling. */
export class SecretTooLargeError extends CryptoError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    // The LIMIT is named; the actual size is not. A value's exact byte length
    // is the most revealing metadata a value has, and this message travels to
    // an HTTP response and a log line.
    super("PAYLOAD_TOO_LARGE", `Secret value exceeds the ${maxBytes}-byte limit.`);
    this.maxBytes = maxBytes;
  }
}
