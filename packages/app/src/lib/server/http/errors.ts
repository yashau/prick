import type { ApiErrorBody } from "@prick/shared";

import { INTERNAL_MESSAGE, PrickError, isPrickError, toPrickError } from "../core/errors.js";

export interface ApiErrorIssue {
  path: string;
  message: string;
}

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
/**
 * Typed STRUCTURALLY rather than as `ZodError`, and that is not incidental.
 *
 * zod v4 has two error classes that both reach this function: the classic
 * `ZodError` a `safeParse` returns, and the `$ZodError` from `zod/v4/core` that
 * the validator hook receives. They are not assignable to one another -- the
 * classic one carries `format`/`flatten`/`addIssue`, which the core one does
 * not -- so naming either concretely would force a cast at one of the two call
 * sites.
 *
 * Naming the two fields this function is ALLOWED to read is a better shape
 * anyway: the parameter type is now the enforcement. There is no `input` on it
 * to reach for, so widening this function to echo one would require widening
 * the signature first, which is a visible edit rather than a slip.
 */
export interface RedactableIssues {
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

export function formatZodIssues(error: RedactableIssues): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * A `PrickError` that carries the redacted issue list.
 *
 * A SUBCLASS rather than a `detail` payload, and the distinction is the point.
 * `PrickError.detail` is `Record<string, unknown>`, which would type-check for
 * `{ issues, input }` exactly as happily as for `{ issues }` -- and `detail` is
 * also what a mutation copies into an audit row. Issues live on their own field,
 * on their own class, populated by exactly one function (`formatZodIssues`),
 * whose whole contract is that it reads `issue.path` and `issue.message` and
 * NOTHING else.
 *
 * Constructed only by `http/validate.ts`. Nothing in `core` knows this type
 * exists, which is correct: `core` throws `VALIDATION_FAILED` with a written
 * message, and the transport is what turns a schema rejection into a list.
 */
export class ValidationError extends PrickError {
  readonly issues: readonly ApiErrorIssue[];

  constructor(message: string, issues: readonly ApiErrorIssue[], hint?: string) {
    super("VALIDATION_FAILED", message, hint === undefined ? {} : { hint });
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function isValidationError(value: unknown): value is ValidationError {
  return value instanceof ValidationError;
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

  // Only ever the redacted `{path, message}` pairs, and only from a
  // `ValidationError`. There is no branch here that reads `detail`, so no route
  // can smuggle a rejected value into the envelope by putting it there.
  if (isValidationError(error) && error.issues.length > 0) {
    body.issues = error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
  }

  return body;
}

export function statusFor(error: unknown): number {
  return isPrickError(error) ? error.status : toPrickError(error).status;
}

export { PrickError };
