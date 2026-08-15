import { z } from "zod";

import {
  DESCRIPTION_MAX_LENGTH,
  SECRET_KEY_MAX_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  SLUG_MAX_LENGTH,
} from "./limits.js";

/**
 * Byte length of a string once encoded as UTF-8.
 *
 * Computed rather than delegated to `TextEncoder` on purpose: this package is
 * imported by the Worker, by the browser bundle and by tooling, and it declares
 * no ambient platform lib at all (`lib: ["ES2022"]`, `types: []`). Reaching for
 * a global here would mean asserting a runtime this package deliberately does
 * not assume.
 *
 * Matches `TextEncoder` semantics exactly, including the lone-surrogate case:
 * an unpaired surrogate is encoded as U+FFFD, which is three bytes.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A well-formed surrogate pair is one code point in the supplementary
        // planes: four bytes, and the low half must not be counted again.
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

/**
 * A POSIX environment variable name.
 *
 * POSIX (IEEE 1003.1, "Environment Variables") allows uppercase letters,
 * digits and underscore, and forbids a leading digit. Lowercase is permitted
 * here because it is universally supported and people do use it; what is NOT
 * permitted is anything that cannot be `export`ed by a shell, because every
 * output format this project emits ends up in one.
 *
 * `=` is impossible by construction, which is what makes the `env` output
 * format unambiguous.
 */
export const SecretKey = z
  .string()
  .min(1, "must not be empty")
  .max(SECRET_KEY_MAX_LENGTH, `must be at most ${SECRET_KEY_MAX_LENGTH} characters`)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "must be a POSIX environment variable name: a letter or underscore followed by letters, digits or underscores",
  );
export type SecretKey = z.infer<typeof SecretKey>;

/**
 * A URL-safe identifier for a project or an environment.
 *
 * Lowercase, digits and single interior hyphens. No leading/trailing hyphen,
 * so a slug is never ambiguous with a CLI flag, and no `/` or `:` so the
 * `/p/:slug/e/:slug` alias routes and the CLI's `project:environment` scope
 * syntax both parse without escaping.
 */
export const Slug = z
  .string()
  .min(1, "must not be empty")
  .max(SLUG_MAX_LENGTH, `must be at most ${SLUG_MAX_LENGTH} characters`)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be lowercase alphanumeric with single interior hyphens",
  );
export type Slug = z.infer<typeof Slug>;

/**
 * A decrypted secret value.
 *
 * The bound is on UTF-8 BYTES, not on `String.length`: the limit exists to
 * bound what is stored in D1 and encrypted in memory, and a 4-byte emoji is
 * one JS "character" but four stored bytes. Checking `.length` would let a
 * value four times the intended size through.
 */
export const SecretValue = z
  .string()
  .refine(
    (value) => utf8ByteLength(value) <= SECRET_VALUE_MAX_BYTES,
    `must be at most ${SECRET_VALUE_MAX_BYTES} bytes when encoded as UTF-8`,
  );
export type SecretValue = z.infer<typeof SecretValue>;

/**
 * A whole environment's worth of secrets.
 *
 * NOTE: the record's KEY schema is `SecretKey`, so an invalid key name is a
 * validation error on the map rather than something discovered later at write
 * time. The error path reports the offending key -- never the value.
 */
export const SecretsMap = z.record(SecretKey, SecretValue);
export type SecretsMap = z.infer<typeof SecretsMap>;

/** Free-text description attached to a project, environment or secret. */
export const Description = z.string().max(DESCRIPTION_MAX_LENGTH).nullable();

/** A human-readable display name. */
export const DisplayName = z.string().min(1).max(128);

/** Authorization roles, ordered `reader < writer < admin`. */
export const Role = z.enum(["reader", "writer", "admin"]);
export type Role = z.infer<typeof Role>;

/** The three levels a grant can be scoped to. */
export const ScopeType = z.enum(["global", "project", "environment"]);
export type ScopeType = z.infer<typeof ScopeType>;

/**
 * Identity kind, derived from the Access JWT rather than chosen by a client.
 *
 * A human token has a non-empty `sub` and an `email`; a service token has
 * `common_name`, an EMPTY `sub`, and no `email` and no `nbf`.
 */
export const IdentityKind = z.enum(["user", "service"]);
export type IdentityKind = z.infer<typeof IdentityKind>;

/** Unix epoch milliseconds. Never an ISO string: comparisons and indexes. */
export const EpochMillis = z.number().int().nonnegative();

/**
 * Optimistic-concurrency token for an environment.
 *
 * Sent back by a client as `expected_rev` on a full-replace; a mismatch is a
 * 412 and the environment is left byte-for-byte unchanged.
 */
export const Revision = z.number().int().nonnegative();

/** An opaque server-generated identifier (UUIDv7 -- time-sortable). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;
