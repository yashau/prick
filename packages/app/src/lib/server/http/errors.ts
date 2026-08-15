import type { ApiErrorBody } from "@prick/shared";
import type { ZodError } from "zod";

import { PrickError, isPrickError } from "../core/errors.js";

/**
 * Map a zod failure onto the API error envelope.
 *
 * FRAMEWORK-LEVEL RULE, NOT A STYLE PREFERENCE: this function reads
 * `issue.path` and `issue.message` and NOTHING ELSE. `issue.input` is dropped
 * on the floor.
 *
 * A `VALIDATION_FAILED` on a secret write is, by definition, a request whose
 * body contained a secret value. If the formatter echoed the rejected input,
 * that value would land in the HTTP response, the Worker log, and the audit
 * detail simultaneously -- three copies of a plaintext secret produced by the
 * error path of a request that was refused.
 */
export function formatZodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * Normalise anything thrown into the single API error envelope.
 *
 * An unrecognised throwable becomes a bare INTERNAL with a generic message: the
 * original text may embed anything, and "include the error message, it's
 * useful" is how a value ends up in a 500 body.
 */
export function toErrorBody(error: unknown, requestId: string): ApiErrorBody {
  if (isPrickError(error)) {
    const body: ApiErrorBody = {
      code: error.code,
      message: error.message,
      request_id: requestId,
    };
    if (error.hint !== undefined) body.hint = error.hint;
    return body;
  }

  return {
    code: "INTERNAL",
    message: "An unexpected error occurred.",
    request_id: requestId,
  };
}

export function statusFor(error: unknown): number {
  return isPrickError(error) ? error.status : 500;
}

export { PrickError };
