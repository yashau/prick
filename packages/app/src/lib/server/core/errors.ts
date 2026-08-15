/**
 * The one error type `core/*` throws.
 *
 * `core` knows nothing about HTTP. It throws `PrickError` with a stable machine
 * code; the Hono transport and the SvelteKit transport each map that code to
 * their own representation. Neither maps it twice, and neither invents codes of
 * its own -- the CLI's error taxonomy is built on these strings, so they are
 * part of the public contract.
 */

export const ERROR_STATUS = {
  VALIDATION_FAILED: 422,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LAST_ADMIN: 409,
  VERSION_CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DECRYPT_FAILED: 500,
  NOT_IMPLEMENTED: 501,
  NO_ADMINS_CONFIGURED: 503,
  MISCONFIGURED: 503,
} as const satisfies Record<string, number>;

export type PrickErrorCode = keyof typeof ERROR_STATUS;

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
}

export function isPrickError(value: unknown): value is PrickError {
  return value instanceof PrickError;
}

/** Placeholder thrown by every not-yet-written stub in this tree. */
export function notImplemented(what: string): never {
  throw new PrickError("NOT_IMPLEMENTED", `${what} is not implemented yet`);
}
