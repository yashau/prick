import { zValidator } from "@hono/zod-validator";
import type { Env, MiddlewareHandler, ValidationTargets } from "hono";
import type { z, ZodType } from "zod";

import { formatZodIssues, ValidationError } from "./errors.js";

/**
 * The ONE place `@hono/zod-validator` is configured, and the only way a route in
 * this tree is allowed to validate anything.
 *
 * ---------------------------------------------------------------------------
 * THE ERROR HOOK IS THE WHOLE REASON THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `zValidator(target, schema)` without a hook answers 400 with zod's own
 * `error.flatten()`-shaped body, and that body contains `issue.input`. On a
 * secret write, `issue.input` IS the secret value: a request that fails
 * validation is by definition one whose body carried a plaintext value, so the
 * default hook publishes it to the HTTP response, the Worker log line that
 * records the response, and -- if a caller ever copied the body into a `detail`
 * -- the audit row, all from the error path of a request that was REFUSED.
 *
 * So the hook here maps issues through `formatZodIssues`, which reads
 * `issue.path` and `issue.message` and nothing else, and throws a
 * `ValidationError`. Routes never see a `result` object and cannot opt out:
 * there is no `zValidator` import anywhere else in this tree, and the sentinel
 * test in `test/http/validation.test.ts` asserts that.
 *
 * `issue.path` is safe and is deliberately kept. For a `SecretsMap` the path
 * segment is the secret's KEY, which is plaintext metadata stored unencrypted in
 * `secrets.key` and rendered in the UI. It is the sibling field that holds the
 * value.
 *
 * ---------------------------------------------------------------------------
 * WHY 422 AND NOT 400
 * ---------------------------------------------------------------------------
 * The request is syntactically well-formed JSON; it is the CONTENT that was
 * rejected. `VALIDATION_FAILED` is 422 in the taxonomy, and the CLI's error
 * table distinguishes it from `BAD_REQUEST` (400), which is reserved for a
 * request this layer could not even interpret -- a malformed `If-Match`, a body
 * that is not JSON at all.
 */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
): MiddlewareHandler<
  Env,
  string,
  { in: { [K in Target]: z.input<T> }; out: { [K in Target]: z.output<T> } }
> {
  // The cast is confined to this one line. `zValidator`'s generics infer the
  // in/out shapes from the schema, and re-deriving them on the signature above
  // (which has to stay generic over `Target` so a route can validate `json`,
  // `query` and `param` through the same helper) does not reproduce them
  // exactly. Behaviour is unaffected: the hook below is what runs.
  return zValidator(target, schema, (result) => {
    if (result.success) return;

    throw new ValidationError(
      `The request ${describeTarget(target)} did not match the expected shape.`,
      formatZodIssues(result.error),
      HINTS[target] ?? "Check the field paths in `issues`. Values are never echoed back.",
    );
  }) as unknown as MiddlewareHandler<
    Env,
    string,
    { in: { [K in Target]: z.input<T> }; out: { [K in Target]: z.output<T> } }
  >;
}

function describeTarget(target: keyof ValidationTargets): string {
  switch (target) {
    case "json":
      return "body";
    case "query":
      return "query string";
    case "param":
      return "path";
    default:
      return String(target);
  }
}

/**
 * Hints, per target.
 *
 * The `json` one names the strictness rule explicitly because it is the failure
 * an integrator hits first and the one that looks most like a server bug: every
 * object schema in `@prick/shared` is `.strict()`, so `{"expectedRev": 3}`
 * instead of `{"expected_rev": 3}` is a 422 rather than a 200 with the
 * concurrency guard silently missing.
 */
const HINTS: Partial<Record<keyof ValidationTargets, string>> = {
  json: "Every object schema is strict: an unknown or misspelled field is rejected rather than ignored. `issues` names the field paths; it never contains the values you sent.",
  query:
    "Unknown query parameters are rejected. `issues` names the parameters; it never contains their values.",
};
