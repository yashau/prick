import { expect } from "vitest";

import { PrickError, type PrickErrorCode } from "../../src/lib/server/core/errors.js";

/**
 * Assert that an operation REJECTS with a specific `PrickError` code.
 *
 * Every negative case in this suite goes through here rather than through
 * `expect(result).toBeFalsy()`. The distinction is the entire point: a verifier
 * that returned `null` instead of throwing would satisfy a falsy assertion and
 * then be used as `const claims = await verify(...); if (claims) ...` by exactly
 * one caller who forgot the `if`. There is no shape of this function that a
 * silently-permissive verifier can pass.
 */
export async function rejectsWith(
  operation: () => Promise<unknown>,
  code: PrickErrorCode,
): Promise<PrickError> {
  let thrown: unknown;
  let resolvedValue: unknown;
  let resolved = false;

  try {
    resolvedValue = await operation();
    resolved = true;
  } catch (error) {
    thrown = error;
  }

  expect(
    resolved,
    `expected a rejection with code ${code}, but the operation RESOLVED with ${JSON.stringify(resolvedValue)}`,
  ).toBe(false);

  expect(thrown, `expected a PrickError, got ${String(thrown)}`).toBeInstanceOf(PrickError);

  const error = thrown as PrickError;
  expect(error.code).toBe(code);

  return error;
}

/** The same, for a synchronous throw. */
export function throwsWith(operation: () => unknown, code: PrickErrorCode): PrickError {
  let thrown: unknown;
  let resolvedValue: unknown;
  let returned = false;

  try {
    resolvedValue = operation();
    returned = true;
  } catch (error) {
    thrown = error;
  }

  expect(
    returned,
    `expected a throw with code ${code}, but the operation RETURNED ${JSON.stringify(resolvedValue)}`,
  ).toBe(false);

  expect(thrown, `expected a PrickError, got ${String(thrown)}`).toBeInstanceOf(PrickError);

  const error = thrown as PrickError;
  expect(error.code).toBe(code);

  return error;
}
