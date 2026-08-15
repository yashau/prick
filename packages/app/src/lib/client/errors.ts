/**
 * The error every screen renders.
 *
 * Kept in its own module so that `api.ts` and `fixtures.ts` can both throw it
 * without an import cycle: `api.ts` picks a backend at module scope, so it
 * imports `fixtures.ts` for real rather than for types, and `fixtures.ts`
 * importing `ApiError` back out of `api.ts` would close the loop.
 */

export interface ApiErrorIssue {
  path: string;
  message: string;
}

/**
 * A non-2xx from `/api/v1`, decoded.
 *
 * `requestId` is the reason this is a class rather than a string: the same id
 * is echoed as `X-Request-Id` and stored on the audit row, so a user can paste
 * it out of an error toast and an admin can find the exact event. Every error
 * surface in this app therefore shows it with a copy button.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly hint: string | null;
  readonly issues: ApiErrorIssue[];

  constructor(init: {
    code: string;
    message: string;
    status: number;
    requestId?: string | null;
    hint?: string | null;
    issues?: ApiErrorIssue[];
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.hint = init.hint ?? null;
    this.issues = init.issues ?? [];
  }

  /**
   * A failed AEAD tag, or a `kid` the ring no longer holds.
   *
   * Never downgraded to an empty cell or a skipped row anywhere in the UI: a
   * tamper attempt has to be the loudest thing on the screen, and "you removed
   * MASTER_KEY_OLD too early" and "this row has been altered" need opposite
   * responses from the operator.
   */
  get isCryptoFailure(): boolean {
    return this.code === "DECRYPT_FAILED" || this.code === "UNKNOWN_KID";
  }
}

/** Narrow an unknown throwable to something with a code and a request id. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError({ code: "NETWORK", message: error.message, status: 0 });
  }
  return new ApiError({ code: "INTERNAL", message: "Something went wrong.", status: 0 });
}
