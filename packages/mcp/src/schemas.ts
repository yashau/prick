import { z } from "zod";

/**
 * Input schemas for the tools.
 *
 * These mirror the primitives in the Worker's shared schema package. They are
 * RESTATED here rather than imported, for one reason: that package is a private
 * workspace package and this one is published to npm. A `workspace:*` dependency
 * on something that is never published makes this package uninstallable.
 *
 * The duplication is bounded and mechanical -- a POSIX name pattern, a slug
 * pattern and three byte limits -- and it is checked on the far side anyway: the
 * server validates every one of these again before it writes anything. Validating
 * here is about giving the model a usable error in one round-trip, not about
 * being the authority.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VALUE SCHEMA IS AS LOOSE AS IT IS
 * ---------------------------------------------------------------------------
 * `SecretValueInput` is `z.string()` plus a byte-length refinement whose message
 * names only the limit. It deliberately carries no pattern, no format and no
 * transform.
 *
 * Everything a zod schema rejects becomes an issue, and every issue becomes a
 * message that the MCP SDK renders back to the model. Verified against the
 * pinned zod and SDK: zod v4 issue messages never quote the offending input, and
 * the SDK's formatter reads `message` and `path` and nothing else. That holds
 * today. It holds more robustly if the schema that guards the one field
 * containing a credential is the simplest schema in the file.
 */

export const SLUG_MAX_LENGTH = 64;
export const SECRET_KEY_MAX_LENGTH = 256;
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;
export const REASON_MAX_LENGTH = 512;
/** Cap on a local `.env` handed to `secrets_diff`. */
export const DOTENV_MAX_BYTES = 1024 * 1024;

/** UTF-8 byte length, computed without assuming a `TextEncoder` global. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export const SlugInput = z
  .string()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be lowercase alphanumeric with single interior hyphens",
  );

export const SecretKeyInput = z
  .string()
  .min(1)
  .max(SECRET_KEY_MAX_LENGTH)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "must be a POSIX environment variable name: a letter or underscore, then letters, digits or underscores",
  );

export const SecretValueInput = z
  .string()
  .refine(
    (value) => utf8ByteLength(value) <= SECRET_VALUE_MAX_BYTES,
    `must be at most ${String(SECRET_VALUE_MAX_BYTES)} bytes when encoded as UTF-8`,
  );

export const ReasonInput = z.string().min(1).max(REASON_MAX_LENGTH);

/**
 * Why a value is being revealed. Recorded verbatim in the server's audit log.
 *
 * The point of the enum is that an auditor can tell "an assistant looked at
 * this" from "an assistant took a copy of it into a running process".
 */
export const RevealReasonInput = z.enum(["reveal", "copy", "export", "run"]);
