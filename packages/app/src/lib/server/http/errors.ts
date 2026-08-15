import type { ApiErrorBody } from "@prick/shared";
import type { ZodError } from "zod";

import { INTERNAL_MESSAGE, PrickError, isPrickError, toPrickError } from "../core/errors.js";

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
 *
 * The path is stringified with `String(segment)`, which is safe: a path segment
 * is a property NAME or an array index, and for `SecretsMap` the name is the
 * secret's KEY. Key names are plaintext metadata throughout this system. It is
 * the sibling field, `input`, that holds the value -- and it is never read.
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
 * Three layers, in order:
 *
 *   PrickError    used as-is, with its code folded to the canonical spelling.
 *   CryptoError   mapped by `toPrickError`, which preserves the message -- a
 *                 crypto message is already written to the "names the row,
 *                 never the value" rule, and `UnknownKeyError`'s text contains
 *                 the entire operator instruction.
 *   anything else a bare INTERNAL with a CONSTANT message. The original text
 *                 may embed anything at all, and "include the error, it's
 *                 useful" is how a value ends up in a 500 body.
 */
export function toErrorBody(error: unknown, requestId: string): ApiErrorBody {
  const normalised = toPrickError(error);

  const body: ApiErrorBody = {
    code: normalised.wireCode,
    // A PrickError we did not classify carries the constant message by
    // construction; this is belt and braces for a hand-built one.
    message: normalised.code === "INTERNAL" ? INTERNAL_MESSAGE : normalised.message,
    request_id: requestId,
  };

  if (normalised.hint !== undefined) body.hint = normalised.hint;

  return body;
}

export function statusFor(error: unknown): number {
  return isPrickError(error) ? error.status : toPrickError(error).status;
}

export { PrickError };
