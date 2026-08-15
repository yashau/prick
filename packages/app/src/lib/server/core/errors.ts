/**
 * The one error type `core/*` throws.
 *
 * `core` knows nothing about HTTP. It throws `PrickError` with a stable machine
 * code; the Hono transport and the SvelteKit transport each map that code to
 * their own representation. Neither maps it twice, and neither invents codes of
 * its own -- the CLI's error taxonomy is built on these strings, so they are
 * part of the public contract.
 *
 * TWO TAXONOMIES WERE RECONCILED INTO THIS ONE.
 *
 * `crypto/errors.ts` deliberately does NOT depend on this module -- it has to be
 * usable from an import script or a cron rekey, where there is no request and no
 * status code to speak of. It therefore throws `CryptoError` with its own codes.
 * That independence is correct, but it left two names for one condition: crypto
 * raised `SERVER_MISCONFIGURED` while this file called the same thing
 * `MISCONFIGURED`, and gave it 503.
 *
 * Resolved in favour of crypto's name and 500:
 *
 *   - `SERVER_MISCONFIGURED` is the canonical code. It is what appears on the
 *     wire, in the CLI's taxonomy, and in the audit row.
 *   - The status is 500, not 503. A 503 says "come back later"; a `MASTER_KEY`
 *     that decodes to 31 bytes will never come good on its own, and a client
 *     that retries on it is being told to wait for something that cannot happen.
 *   - `toPrickError()` maps every `CryptoError` onto a member of this taxonomy,
 *     so a crypto failure crossing into a transport is never an unrecognised
 *     throwable that degrades to a bare INTERNAL.
 *
 * `MISCONFIGURED` briefly survived as a deprecated alias while `auth/**` still
 * constructed it by that literal. It has since been DELETED rather than carried:
 * a deprecated code nobody emits is just a second name lying in wait. The
 * aliasing machinery stays (`CODE_ALIASES` is empty, `canonicalCode()` still
 * folds) so the next alias is handled from the moment it is added.
 *
 * ONE THING THAT MERGE GOT WRONG, AND WHY IT IS NOW SPLIT BACK OUT.
 *
 * Folding everything into `SERVER_MISCONFIGURED` also swept up JWKS fetch
 * failures, and those are the opposite kind of problem. A `MASTER_KEY` that
 * decodes to 31 bytes never comes good; Access returning 502 for thirty seconds
 * resolves on its own. Reporting the second as the first tells a client to give
 * up on something it should retry, and sends a human to check settings that were
 * never wrong. Hence `IDENTITY_PROVIDER_UNAVAILABLE` (503), reserved for network
 * failure and upstream 5xx -- a 4xx from the certs endpoint really is
 * misconfiguration and stays at 500.
 */

import { CryptoError } from "../crypto/errors.js";

export const ERROR_STATUS = {
  /** Zod rejected the body. `issue.input` is stripped before this is built. */
  VALIDATION_FAILED: 422,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  /**
   * Absent AND invisible resources, with no way to tell them apart.
   *
   * A reader with one environment-scoped grant asking for a project they cannot
   * see gets exactly what they get for a project that does not exist. Returning
   * 403 for the first and 404 for the second turns the API into an oracle for
   * "which project names are in use", which is information the actor was denied
   * by design.
   */
  NOT_FOUND: 404,
  CONFLICT: 409,
  LAST_ADMIN: 409,
  /** Lost a race on `UNIQUE(environment_id, key, version)`, twice. */
  VERSION_CONFLICT: 409,
  /** `expected_rev` did not match. The environment is byte-for-byte unchanged. */
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  /** Constant message. The original text may embed anything at all. */
  INTERNAL: 500,
  /**
   * Authenticated decryption failed: altered bytes, or a row presented under an
   * identity it was not sealed against.
   *
   * NEVER swallowed. On reveal it fails the request; on list the row comes back
   * marked `unreadable`. Both write an audit row with `outcome: 'error'`.
   */
  DECRYPT_FAILED: 500,
  /**
   * The envelope names a key id the ring does not hold.
   *
   * Distinct from DECRYPT_FAILED on purpose, and the distinction has to survive
   * all the way to the operator: "you removed MASTER_KEY_OLD too early" and
   * "this row has been tampered with" need opposite responses, and a single
   * generic failure code cannot tell them apart.
   */
  UNKNOWN_KID: 500,
  /** Fail closed. Every route, including `/health`. */
  SERVER_MISCONFIGURED: 500,
  /**
   * The identity provider is unreachable or degraded RIGHT NOW.
   *
   * Deliberately distinct from `SERVER_MISCONFIGURED`, which they were briefly
   * merged into. The two look alike at the throw site and are opposites to a
   * caller: a `MASTER_KEY` that decodes to 31 bytes never comes good, whereas
   * Access returning 502 for thirty seconds resolves on its own. Folding them
   * tells a client to give up on a failure it should have retried -- and tells
   * a human that a transient blip is a configuration error, sending them to
   * check settings that were never wrong.
   *
   * Only network failure and an upstream 5xx qualify. A 4xx from the certs
   * endpoint means we are pointed at the wrong place, which is misconfiguration.
   */
  IDENTITY_PROVIDER_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
  /**
   * Neither `BOOTSTRAP_ADMINS` nor a usable global admin grant exists.
   *
   * 503 and not 500: unlike a bad master key this IS recoverable without a code
   * change -- set the var, redeploy -- so "the service is not ready" is the
   * honest reading.
   */
  NO_ADMINS_CONFIGURED: 503,
} as const satisfies Record<string, number>;

export type PrickErrorCode = keyof typeof ERROR_STATUS;

/**
 * Deprecated code -> canonical code. Applied at the transport boundary.
 *
 * EXPORTED so the invariant "no deprecated code ever reaches a response body"
 * can be asserted over every entry rather than over the one entry somebody
 * remembered. Adding an alias here without extending the fold would be caught by
 * `test/http/errors.test.ts`, which enumerates this map.
 */
export const CODE_ALIASES: Partial<Record<PrickErrorCode, PrickErrorCode>> = {
  // Empty by design. `MISCONFIGURED` lived here until `auth/**` stopped
  // constructing it; the alias was then deleted rather than carried, because a
  // deprecated code nobody emits is just a second name waiting to be picked up
  // again. The machinery stays so the next alias is folded from the moment it
  // is added, and the enumeration test keeps working against an empty map.
};

/** Every code that must never appear on the wire. Derived, not listed twice. */
export const DEPRECATED_ERROR_CODES = Object.keys(CODE_ALIASES) as PrickErrorCode[];

/**
 * The code as it appears on the wire.
 *
 * Constructors keep whatever literal they were given -- rewriting `error.code`
 * in the constructor would break every existing assertion in `test/auth` -- but
 * nothing outside this module ever sees an alias.
 */
export function canonicalCode(code: PrickErrorCode): PrickErrorCode {
  return CODE_ALIASES[code] ?? code;
}

export interface PrickErrorOptions {
  /**
   * An actionable next step, rendered by the CLI in miette's `help()` channel
   * and by the UI under the error message. "Set BOOTSTRAP_ADMINS in
   * wrangler.jsonc and redeploy", not "check your configuration".
   */
  hint?: string;
  /**
   * Structured detail for the response body and the audit row.
   *
   * MUST NOT contain a secret value, a ciphertext, or zod's `issue.input`.
   */
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class PrickError extends Error {
  readonly code: PrickErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: PrickErrorCode, message: string, options: PrickErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "PrickError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.hint = options.hint;
    this.detail = options.detail;
  }

  /** The code as it appears on the wire, with deprecated aliases folded away. */
  get wireCode(): PrickErrorCode {
    return canonicalCode(this.code);
  }
}

export function isPrickError(value: unknown): value is PrickError {
  return value instanceof PrickError;
}

/** Placeholder thrown by every not-yet-written stub in this tree. */
export function notImplemented(what: string): never {
  throw new PrickError("NOT_IMPLEMENTED", `${what} is not implemented yet`);
}

// ---------------------------------------------------------------------------
// Constructors for the cases that recur
// ---------------------------------------------------------------------------

/**
 * ONE function for "absent" and "invisible", and it takes no argument that
 * could distinguish them.
 *
 * The shape is the enforcement: there is no `notFound(kind, becauseHidden)`
 * overload for a caller to reach for, so a handler cannot accidentally leak the
 * difference by picking the wrong one under time pressure. The message names
 * the KIND of thing ("project") and never the identifier that was looked up --
 * echoing the slug back is a smaller leak than a 403/404 split, but it is still
 * a confirmation that the caller's guess was well-formed.
 */
export function notFound(kind: string): PrickError {
  return new PrickError("NOT_FOUND", `No such ${kind}.`, {
    hint: "It may not exist, or it may not be visible to you. Ask an administrator for a grant if you expected to see it.",
  });
}

/**
 * Map a `CryptoError` onto this taxonomy.
 *
 * Every crypto message is already written to the rule that it may name a key, an
 * environment, a version, a kid or a byte limit and never a plaintext value or a
 * ciphertext -- so the message is carried across verbatim. That is deliberate:
 * `UnknownKeyError`'s message contains the entire operator instruction ("restore
 * it in MASTER_KEY_OLD"), and replacing it with a generic string would throw
 * away the one thing that makes the failure actionable.
 */
export function toPrickError(error: unknown): PrickError {
  if (isPrickError(error)) return error;

  if (error instanceof CryptoError) {
    switch (error.code) {
      case "SERVER_MISCONFIGURED":
        return new PrickError("SERVER_MISCONFIGURED", error.message, {
          hint: "The Worker cannot serve any request until its master key configuration is valid.",
          cause: error,
        });
      case "DECRYPT_FAILED":
        return new PrickError("DECRYPT_FAILED", error.message, {
          hint: "This row was not sealed against the identity it is being read under. Treat it as a tamper attempt until proven otherwise.",
          cause: error,
        });
      case "UNKNOWN_KID":
        return new PrickError("UNKNOWN_KID", error.message, {
          hint: "Restore the retired key in MASTER_KEY_OLD and redeploy, or investigate where this row came from.",
          cause: error,
        });
      case "CRYPTO_FORMAT":
        return new PrickError("DECRYPT_FAILED", error.message, {
          hint: "A stored envelope is not in a format this build can parse.",
          cause: error,
        });
      case "CRYPTO_INPUT":
        return new PrickError("VALIDATION_FAILED", error.message, { cause: error });
      case "PAYLOAD_TOO_LARGE":
        return new PrickError("PAYLOAD_TOO_LARGE", error.message, { cause: error });
    }
  }

  return new PrickError("INTERNAL", INTERNAL_MESSAGE, { cause: error });
}

/**
 * The ONLY message a 500 with no better classification may carry.
 *
 * A constant, not a template. "Include the underlying message, it's useful for
 * debugging" is how a plaintext value reaches a response body: the throwable
 * that reached here is by definition one nothing classified, so nothing has
 * established what its `message` contains.
 */
export const INTERNAL_MESSAGE = "An unexpected error occurred.";

// ---------------------------------------------------------------------------
// D1 constraint classification
// ---------------------------------------------------------------------------

/**
 * Which constraint a failed `batch()` tripped.
 *
 * D1 surfaces SQLite constraint failures as an `Error` whose message embeds the
 * SQLite text:
 *
 *   D1_ERROR: UNIQUE constraint failed: secret_versions.environment_id,
 *   secret_versions.key, secret_versions.version: SQLITE_CONSTRAINT
 *
 * The write path needs to tell three of these apart, because they mean entirely
 * different things to the caller:
 *
 *   environments.*      the `expected_rev` guard fired        -> 412
 *   secret_versions.*   a concurrent writer took the version  -> retry, then 409
 *   anything else       a real bug                            -> 500
 *
 * MATCHED ON THE TABLE, NOT ON A COLUMN, and that is a correction rather than
 * laziness. The design note describes the `expected_rev` guard as producing "a
 * PK collision", so the obvious classifier looks for `environments.id`. It does
 * not fire. SQLite evaluates unique indexes in creation order and reports the
 * FIRST one violated, and `environments` carries
 * `environments_project_slug_uniq` on `(project_id, slug)` -- which the
 * re-inserted row also violates, and which is checked first. The real message
 * is:
 *
 *   UNIQUE constraint failed: environments.project_id, environments.slug
 *
 * The guard still works exactly as designed: the row still collides, the
 * statement still errors, the batch is still rolled back. Only the reported
 * column differs -- so the classifier keys on the table, which is sound because
 * the ONLY statement in a secrets batch that inserts into `environments` is the
 * guard. A classifier written against `environments.id` would have mapped every
 * `expected_rev` mismatch to a 500 while looking correct.
 *
 * Matching on a message string is unpleasant and it is the only signal D1
 * gives -- the error carries no `code` field and no structured cause. It is
 * contained here, in one function, with a test for each branch, rather than
 * smeared across the write path as three `String(error).includes(...)` checks.
 */
export type D1ConstraintKind = "environment-rev" | "secret-version" | "other";

export function classifyD1Constraint(error: unknown): D1ConstraintKind {
  const message = error instanceof Error ? error.message : String(error);

  if (!/constraint failed/i.test(message)) return "other";

  if (/\benvironments\./i.test(message)) return "environment-rev";
  if (/\bsecret_versions\./i.test(message)) return "secret-version";

  return "other";
}
