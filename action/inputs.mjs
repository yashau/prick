// action/inputs.mjs — reading and validating the action's own inputs.
//
// Inputs arrive as `PRICK_INPUT_*` environment variables rather than through
// `${{ }}` interpolation into a shell command, which is what keeps a project
// name containing `$(...)` from being a code-execution vector in the action
// itself. Everything here turns one of those strings into a value the rest of
// the action can use, or refuses it.
//
// Nothing here is ever lenient about an unrecognised value: `mask: enabled`
// silently disabling masking -- a spelling that plainly means "on", treated as
// "off" because it is not in the list -- is precisely the class of bug this
// file exists to make impossible.

import { ActionError } from "./errors.mjs";
import { isValidEnvName } from "./plan.mjs";

/**
 * Parses the `keys` allowlist.
 *
 * Newline- or comma-separated, so both YAML block scalars and one-liners work.
 * An empty input means "no allowlist", which is not the same as "an empty
 * allowlist" -- hence `null` rather than `[]`.
 *
 * @param {unknown} raw
 * @returns {string[] | null}
 */
export function parseKeyList(raw) {
  const items = String(raw ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length === 0 ? null : [...new Set(items)];
}

/**
 * Parses a boolean input.
 *
 * An unrecognised value is an ERROR, never a falsy default. `mask: enabled`
 * silently disabling masking -- a spelling that plainly means "on", treated as
 * "off" because it is not in the list -- is precisely the bug this refuses to
 * have.
 *
 * @param {unknown} raw
 * @param {string} name  the input's name, for the message
 * @param {boolean} fallback  used only when the input is absent or empty
 * @returns {boolean}
 */
export function parseBoolean(raw, name, fallback) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (text === "") {
    return fallback;
  }
  if (["true", "1", "yes", "on"].includes(text)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(text)) {
    return false;
  }
  throw new ActionError(
    `\`${name}\` must be true or false, but was \`${text}\``,
    "Leave it unset to take the default.",
  );
}

/**
 * Validates the server URL.
 *
 * https only: an Access service token is a bearer credential sent in a request
 * header, so a plaintext URL puts it on the wire in the clear. The URL itself
 * is never echoed back -- it is commonly stored as a repository secret, and an
 * error message is not the place to find out whether the runner is masking it.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function validateUrl(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") {
    throw new ActionError("`url` is required", "Set it to the base URL of your prick server.");
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new ActionError(
      "`url` is not a URL",
      "It must be an absolute URL, for example https://prick.example.com.",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new ActionError(
      `\`url\` uses the ${parsed.protocol} scheme; only https is accepted`,
      "The Access service token is sent as a request header. Over plaintext it is " +
        "readable by anything on the path.",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new ActionError(
      "`url` carries userinfo credentials",
      "Remove the user:password@ part. Authentication is the service token, " +
        "passed through the client-id and client-secret inputs.",
    );
  }

  return text;
}

/**
 * @param {unknown} raw
 * @returns {string} the validated prefix, possibly empty
 */
export function validatePrefix(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") {
    return "";
  }
  // A bad prefix is operator configuration, not data: it would make EVERY key
  // invalid, so failing is far more useful than warning about each one.
  if (!isValidEnvName(text)) {
    throw new ActionError(
      `\`prefix\` is not a valid environment variable name fragment: \`${text}\``,
      "It must match [A-Za-z_][A-Za-z0-9_]*, for example `APP_`.",
    );
  }
  return text;
}

/**
 * @param {unknown} raw
 * @returns {'env' | 'outputs'}
 */
export function validateExportTo(raw) {
  const text = String(raw ?? "").trim() || "env";
  if (text !== "env" && text !== "outputs") {
    throw new ActionError(
      `\`export-to\` must be \`env\` or \`outputs\`, but was \`${text}\``,
      "Leave it unset for `env`, which is what almost every workflow wants.",
    );
  }
  return text;
}

/**
 * Reads and validates every input.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {object}
 */
export function readInputs(env) {
  const url = validateUrl(env.PRICK_INPUT_URL);
  const project = String(env.PRICK_INPUT_PROJECT ?? "").trim();
  if (project === "") {
    throw new ActionError("`project` is required");
  }

  const environment = String(env.PRICK_INPUT_ENVIRONMENT ?? "").trim() || "production";
  // Trimmed: a trailing newline picked up when the token was pasted into the
  // repository secret is otherwise an authentication failure with no visible
  // cause. Neither half of an Access service token contains whitespace.
  const clientId = String(env.PRICK_INPUT_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.PRICK_INPUT_CLIENT_SECRET ?? "").trim();
  if (clientId === "" || clientSecret === "") {
    throw new ActionError(
      "`client-id` and `client-secret` are both required",
      "They come from an Access SERVICE TOKEN, not from an SSO session. " +
        "See the README for how to create one.",
    );
  }

  return {
    url,
    project,
    environment,
    clientId,
    clientSecret,
    allowlist: parseKeyList(env.PRICK_INPUT_KEYS),
    prefix: validatePrefix(env.PRICK_INPUT_PREFIX),
    exportTo: validateExportTo(env.PRICK_INPUT_EXPORT_TO),
    mask: parseBoolean(env.PRICK_INPUT_MASK, "mask", true),
    allowUnsafeNames: parseBoolean(env.PRICK_INPUT_ALLOW_UNSAFE_NAMES, "allow-unsafe-names", false),
    version: String(env.PRICK_INPUT_VERSION ?? "").trim(),
    actionRef: String(env.GITHUB_ACTION_REF ?? "").trim(),
  };
}
