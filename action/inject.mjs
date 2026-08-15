#!/usr/bin/env node
// action/inject.mjs — the entire body of the composite action in `action/`.
//
//   node inject.mjs install     validate the inputs, resolve and install the CLI
//   node inject.mjs inject      fetch the secrets and expose them to later steps
//
// THE RULE THIS FILE EXISTS TO ENFORCE
//
// A secret value reaches exactly two destinations and no third:
//
//   1. an `::add-mask::` workflow command, which the runner consumes and never
//      echoes, and which must be issued BEFORE the value can appear anywhere
//      else, and
//   2. the file named by $GITHUB_ENV or $GITHUB_OUTPUT, which the runner reads
//      and never prints.
//
// Everything else -- progress lines, warnings, error messages, the CLI's own
// stderr -- names KEYS only. Keys are plaintext by design (only values are
// encrypted), so they are safe to echo; values never are.
//
// The whole file is structured so that this is checkable rather than promised:
// every write to a stream funnels through exactly one function each
// (`command()` for stdout, `log()` for stderr), both defined in `realIo()`, and
// inject.test.mjs asserts by reading this source that there is no second one.
//
// WHY THE HEREDOC FORM, WITH A RANDOM DELIMITER
//
// `$GITHUB_ENV` is a line-oriented file. `KEY=value` cannot carry a value with
// a newline in it, and a fixed heredoc delimiter (`KEY<<EOF`) is an injection
// vector: a value whose own text contains a line equal to the delimiter closes
// the block early, and everything after it is parsed as further assignments. A
// secret store is exactly the place an attacker would put such a value. The
// delimiter is therefore 128 bits of CSPRNG per run, and is additionally
// checked against every value being written -- so the property is unconditional
// rather than merely overwhelmingly likely.
//
// WHY THE CLI IS SPAWNED WITH A STATIC ARGV
//
// Nothing the user supplies is ever placed in an argument vector. The URL, the
// project, the environment and the service token are handed to `prk` through
// the environment (`PRK_API_URL`, `PRK_PROJECT`, `PRK_ENV`,
// `PRK_ACCESS_CLIENT_ID`, `PRK_ACCESS_CLIENT_SECRET` -- see
// crates/prick-auth/src/credential.rs and crates/prk/src/cli.rs). That keeps
// the token out of `ps` output, and it is what makes `shell: true` on Windows
// safe below: there is no user data in the command line to quote wrongly.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The npm package that carries the `prk` binary. */
export const CLI_PACKAGE = "@yashau/prick";

/** The binary the package installs. */
export const CLI_BINARY = "prk";

/**
 * The CLI invocation, in full.
 *
 * `--format json` (not the global `--json`) is what asks for the secret set as
 * a JSON object with sorted keys; see crates/prick-core/src/format.rs.
 * `--no-input` makes the CLI fail rather than prompt, which is what CI wants.
 *
 * Every element is a literal. A test asserts that, because it is the premise
 * the Windows `shell: true` path rests on.
 */
export const CLI_ARGS = ["secrets", "download", "--format", "json", "--no-input"];

/** The longest key name accepted, mirroring `prick_core::keyname::MAX_KEY_LEN`. */
export const MAX_KEY_LEN = 256;

/**
 * The grammar of a POSIX environment variable name.
 *
 * Identical to `prick_core::keyname::validate`: a key that the server accepted
 * will pass this, and a key that will not fit an environment variable is
 * reported and skipped rather than mangled into one.
 */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the dynamic loader or a language runtime interprets before the
 * program's own code runs. Mirrors `UNSAFE_EXACT` in
 * crates/prick-core/src/keyname.rs.
 *
 * In `$GITHUB_ENV` these are worse than they are in `prk run`: the value
 * applies to every subsequent step of the job, so a compromised server that
 * can set `NODE_OPTIONS` gets arbitrary code execution in the workflow.
 */
export const LOADER_CONTROLLED_EXACT = [
  "BASH_ENV",
  "ENV",
  "GIT_SSH_COMMAND",
  "GLIBC_TUNABLES",
  "IFS",
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "PATH",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "RUBYLIB",
  "RUBYOPT",
];

/** Whole families of loader-controlling variables. Mirrors `UNSAFE_PREFIXES`. */
export const LOADER_CONTROLLED_PREFIXES = ["LD_", "DYLD_"];

/**
 * Namespaces the runner owns.
 *
 * Overwriting `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT` or
 * `ACTIONS_RUNTIME_TOKEN` from a secret store is never a legitimate use and is
 * a direct route to controlling later steps.
 */
export const RESERVED_PREFIXES = ["GITHUB_", "RUNNER_", "ACTIONS_"];

/** The heredoc delimiter's fixed part. The random part follows it. */
export const DELIMITER_PREFIX = "__PRICK_EOF_";

/** CalVer, `YYYY.MMDD.N`, optionally `v`-prefixed. See scripts/version.mjs. */
export const CALVER = /^v?\d{4}\.\d{1,4}\.\d+$/;

/**
 * The characters a version spec may contain.
 *
 * Deliberately narrow. It excludes `/` and `:` (which would let a spec name a
 * git remote, a tarball URL or a filesystem path instead of a registry
 * version) and every shell metacharacter (because on Windows the npm
 * invocation goes through `cmd`). Exact versions, a leading `^` or `~` and
 * dist-tags all fit; comparator ranges such as `>=2026.815.0` deliberately do
 * not, since `>` and `|` would be redirection and a pipe there.
 *
 * The leading `^` is safe despite being cmd.exe's escape character: Node quotes
 * every argument it passes through a shell, and inside double quotes cmd's
 * caret escaping is inert.
 */
export const VERSION_SPEC = /^[\^~]?[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failure with an actionable next step. Never carries a secret value. */
export class ActionError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint) {
    super(message);
    this.name = "ActionError";
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Workflow-command encoding
// ---------------------------------------------------------------------------

/**
 * Escapes the data half of a `::command::data` line.
 *
 * This is load-bearing, not cosmetic. A workflow command is one line: if a
 * multi-line value were written after `::add-mask::` unescaped, the runner
 * would treat the first line as the command and PRINT THE REST TO THE LOG.
 * Escaping newlines is what makes masking a multi-line secret possible at all.
 *
 * `%` is replaced first, or the `%0D`/`%0A` introduced below would be escaped
 * a second time.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * The `::add-mask::` payloads for one value.
 *
 * A mask registers a literal string; the runner redacts it wherever it appears
 * in a log line. A multi-line value therefore needs its lines masked
 * individually as well as whole, because no single log line ever equals the
 * whole value.
 *
 * Whitespace-only strings are skipped: the runner ignores them, and masking
 * " " would redact most of the log for no benefit.
 *
 * @param {string} value
 * @returns {string[]} raw payloads, in the order they must be issued
 */
export function maskPayloads(value) {
  const text = String(value);
  if (text.trim() === "") {
    return [];
  }

  const payloads = [text];
  if (/[\r\n]/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() !== "") {
        payloads.push(line);
      }
    }
  }

  return [...new Set(payloads)];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidEnvName(name) {
  return (
    typeof name === "string" && name.length > 0 && name.length <= MAX_KEY_LEN && ENV_NAME.test(name)
  );
}

/**
 * Whether setting this name for every later step in the job hands control of
 * those steps to whoever controls the value.
 *
 * Case-sensitive and exact, like the loader's own comparison.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isUnsafeName(name) {
  return (
    LOADER_CONTROLLED_EXACT.includes(name) ||
    LOADER_CONTROLLED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/**
 * Decides which CLI version to install.
 *
 * The default is the action's own ref, so that `@v2026.815.0` installs exactly
 * `@yashau/prick@2026.815.0` and the action and the CLI cannot drift. A
 * floating ref (`@v1`, a branch, a commit SHA) names no version, so it falls
 * back to the `latest` dist-tag -- pin the action to a CalVer tag, or set
 * `version`, if you need that nailed down.
 *
 * @param {{ version?: unknown, actionRef?: unknown }} options
 * @returns {{ spec: string, source: string }}
 */
export function resolveVersionSpec({ version, actionRef } = {}) {
  const explicit = String(version ?? "").trim();
  if (explicit !== "") {
    return { spec: assertSafeVersionSpec(stripLeadingV(explicit)), source: "the `version` input" };
  }

  const ref = String(actionRef ?? "").trim();
  if (CALVER.test(ref)) {
    return { spec: assertSafeVersionSpec(stripLeadingV(ref)), source: `the action ref ${ref}` };
  }

  return {
    spec: "latest",
    source: ref === "" ? "the latest dist-tag" : `the latest dist-tag (${ref} names no version)`,
  };
}

/**
 * @param {string} spec
 * @returns {string}
 */
function stripLeadingV(spec) {
  return spec.replace(/^v(?=\d)/, "");
}

/**
 * @param {string} spec
 * @returns {string} the same spec, once it is known to be a registry version
 */
export function assertSafeVersionSpec(spec) {
  if (!VERSION_SPEC.test(spec)) {
    throw new ActionError(
      `\`version\` is not a plain registry version: \`${spec}\``,
      "Use an exact version (2026.815.0), a ^ or ~ range, or a dist-tag. " +
        "Paths, git remotes and tarball URLs are refused.",
    );
  }
  return spec;
}

/**
 * The npm invocation.
 *
 * `--ignore-scripts` because none of the nine published packages runs an
 * install script -- the platform packages declare `bin` directly rather than
 * downloading a binary in a postinstall -- so nothing is lost, and a
 * dependency that suddenly wants to run code at install time should fail here
 * rather than run.
 *
 * @param {string} spec
 * @returns {string[]}
 */
export function installArgs(spec) {
  return [
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `${CLI_PACKAGE}@${assertSafeVersionSpec(spec)}`,
  ];
}

// ---------------------------------------------------------------------------
// The CLI's exit-code contract
// ---------------------------------------------------------------------------

/**
 * The exit-code table from `prick_core::classify::ErrorKind::exit_code`, which
 * that module documents as part of the CLI's contract: "scripts branch on it,
 * so a value may never be reassigned to a different meaning". Branching on the
 * code rather than on stderr text is why this mapping is stable.
 *
 * @param {number | null} code  null when the child was killed by a signal
 * @returns {{ title: string, hint: string }}
 */
export function describeExit(code) {
  switch (code) {
    case 2:
      return {
        title: "the CLI rejected its own arguments",
        hint:
          "The installed CLI is older or newer than this action expects. " +
          "Pin both: set the `version` input, or use a CalVer tag of the action.",
      };
    case 3:
      return {
        title: "the service token was not accepted",
        hint:
          "Check `client-id` and `client-secret`. A service token client id ends in " +
          "`.access`; the secret is shown once, when the token is created. Both must " +
          "come from the same token, and the token must not have expired.",
      };
    case 4:
      return {
        title: "the service token has no grant for this project and environment",
        hint:
          "This is the usual first-run failure, and it is fixed in the admin UI, not " +
          'in this workflow: open Access, find the client id under "Seen but not ' +
          'granted" (the denial you just caused puts it there), and grant it the ' +
          "`reader` role on this project or environment.",
      };
    case 5:
      return {
        title: "no such project or environment",
        hint:
          "Names are matched exactly and are case-sensitive. Check `project` and " +
          "`environment` against `prk projects list` and `prk env list`.",
      };
    case 6:
      return {
        title: "the environment changed while it was being read",
        hint: "Re-run the job.",
      };
    case 7:
      return {
        title: "the server could not be reached",
        hint:
          "Check `url`. It must be the Worker hostname, reachable from a GitHub " +
          "runner, and the Access application must be in front of it.",
      };
    case 8:
      return {
        title: "the server failed",
        hint: "Quote the X-Request-Id from the error above when reporting it.",
      };
    case 10:
      return {
        title: "the server is rate limiting this token",
        hint: "Re-run the job after the interval the server asked for.",
      };
    case 11:
      return {
        title: "the server rejected the request as invalid",
        hint: "Check `project` and `environment` for stray whitespace or quoting.",
      };
    default:
      return {
        // `null` means a signal, not status zero. Coercing it to a number would
        // report "exited with status 0" for a job the runner just cancelled.
        title:
          code === null
            ? "the CLI was killed before it finished"
            : `the CLI exited with status ${code}`,
        hint: "Re-run with ACTIONS_STEP_DEBUG enabled to see the CLI diagnostics.",
      };
  }
}

// ---------------------------------------------------------------------------
// The CLI's output
// ---------------------------------------------------------------------------

/**
 * Parses the CLI's JSON document into a Map.
 *
 * A Map, not the parsed object: a JSON document is attacker-influenced in the
 * sense that its keys come from the store, and `obj[key]` on a plain object
 * reaches through to `Object.prototype`. `Object.entries` plus a Map has no
 * such reach.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseSecrets(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The SyntaxError is DISCARDED, deliberately. Node's JSON parse messages
    // quote a slice of the offending input, and the input here is a document of
    // secret values -- so reporting the parse error would leak one. The byte
    // count is the most that can safely be said.
    throw new ActionError(
      `the CLI produced ${Buffer.byteLength(String(text), "utf8")} bytes that are not valid JSON`,
      "The parser error is withheld on purpose: it would quote the secret values. " +
        "Check that the installed `prk` supports `secrets download --format json`.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActionError(
      "the CLI produced JSON that is not an object of key/value pairs",
      "Check that the installed `prk` supports `secrets download --format json`.",
    );
  }

  const secrets = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      // Names the key, never the value.
      throw new ActionError(`the value of \`${key}\` is not a string`);
    }
    secrets.set(key, value);
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * @typedef {object} InjectionPlan
 * @property {{ key: string, name: string, value: string }[]} entries
 * @property {{ key: string, reason: string }[]} skipped
 * @property {string[]} missing  allowlisted keys the environment does not have
 */

/**
 * Decides what to inject, what to skip and what is missing.
 *
 * Pure: it takes the secret set and the inputs and returns a description. All
 * the masking and file writing happens afterwards, against this.
 *
 * @param {object} options
 * @param {Map<string, string>} options.secrets
 * @param {string[] | null} options.allowlist
 * @param {string} options.prefix
 * @param {boolean} options.allowUnsafeNames
 * @returns {InjectionPlan}
 */
export function planInjection({ secrets, allowlist, prefix = "", allowUnsafeNames = false }) {
  /** @type {InjectionPlan} */
  const plan = { entries: [], skipped: [], missing: [] };

  const selected = allowlist ?? [...secrets.keys()];
  for (const key of allowlist ?? []) {
    if (!secrets.has(key)) {
      plan.missing.push(key);
    }
  }

  for (const key of selected) {
    if (!secrets.has(key)) {
      continue; // already recorded as missing
    }

    if (!isValidEnvName(key)) {
      plan.skipped.push({
        key,
        reason: "it is not a valid environment variable name ([A-Za-z_][A-Za-z0-9_]*)",
      });
      continue;
    }

    const name = `${prefix}${key}`;
    if (!isValidEnvName(name)) {
      plan.skipped.push({ key, reason: `\`${name}\` is not a valid environment variable name` });
      continue;
    }

    if (!allowUnsafeNames && isUnsafeName(name)) {
      plan.skipped.push({
        key,
        reason:
          `\`${name}\` is interpreted by the runner, the dynamic loader or a language ` +
          "runtime before a program starts, so setting it from a secret store would " +
          "give the store control of every later step",
      });
      continue;
    }

    plan.entries.push({ key, name, value: /** @type {string} */ (secrets.get(key)) });
  }

  // Sorted so a job's log is diffable run to run.
  plan.entries.sort(byName);
  return plan;
}

/**
 * Byte-order comparison. Not `localeCompare`, which would order differently on
 * differently-configured runners.
 *
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @returns {number}
 */
function byName(a, b) {
  if (a.name < b.name) {
    return -1;
  }
  if (a.name > b.name) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The environment file
// ---------------------------------------------------------------------------

/**
 * A fresh heredoc delimiter.
 *
 * @param {(size: number) => Buffer} random
 * @returns {string}
 */
export function newDelimiter(random = randomBytes) {
  return `${DELIMITER_PREFIX}${random(16).toString("hex")}__`;
}

/**
 * A delimiter that appears in none of the values it will delimit.
 *
 * With 128 random bits the loop is theatre on any real input -- and that is the
 * point. The guarantee is not "a collision is unlikely", it is "a collision
 * cannot be written", which is a different and much easier property to reason
 * about when the values are chosen by whoever can write to the secret store.
 *
 * @param {string[]} values
 * @param {(size: number) => Buffer} random
 * @param {number} attempts
 * @returns {string}
 */
export function chooseDelimiter(values, random = randomBytes, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delimiter = newDelimiter(random);
    if (!values.some((value) => String(value).includes(delimiter))) {
      return delimiter;
    }
  }
  throw new ActionError("could not generate a delimiter that no value contains");
}

/**
 * Renders one heredoc assignment for `$GITHUB_ENV` or `$GITHUB_OUTPUT`.
 *
 * The value is written byte for byte between the delimiters: no trimming, no
 * escaping, no newline normalisation. A secrets manager that alters a value in
 * transit is worse than one that refuses to carry it.
 *
 * @param {string} name
 * @param {string} value
 * @param {string} delimiter
 * @returns {string}
 */
export function renderAssignment(name, value, delimiter) {
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/**
 * Renders the whole file-command block for a plan.
 *
 * @param {{ name: string, value: string }[]} entries
 * @param {string} delimiter
 * @returns {string}
 */
export function renderBlock(entries, delimiter) {
  return entries.map((entry) => renderAssignment(entry.name, entry.value, delimiter)).join("");
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Io
 * @property {(name: string, message: string) => void} command  a `::name::message` line
 * @property {(line: string) => void} log                        a human progress line
 * @property {(text: string) => void} appendEnv
 * @property {(text: string) => void} appendOutput
 */

/**
 * The real effects.
 *
 * This function contains the ONLY write to stdout and the ONLY write to stderr
 * in this file, and inject.test.mjs asserts that by reading the source. Keeping
 * them to one each is what makes "no code path prints a value" something you
 * can check in a few seconds rather than something you have to trust.
 *
 * `command()` escapes unconditionally, so a caller cannot forget to. That
 * matters most for `::add-mask::`: an unescaped newline there would end the
 * command and print the rest of the value into the log.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Io}
 */
export function realIo(env = process.env) {
  return {
    command(name, message) {
      process.stdout.write(`::${name}::${escapeData(message)}\n`);
    },
    log(line) {
      console.error(line);
    },
    appendEnv(text) {
      fs.appendFileSync(requireFile(env, "GITHUB_ENV"), text, "utf8");
    },
    appendOutput(text) {
      fs.appendFileSync(requireFile(env, "GITHUB_OUTPUT"), text, "utf8");
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string}
 */
function requireFile(env, name) {
  const value = env[name];
  if (!value) {
    throw new ActionError(
      `$${name} is not set`,
      "This action only runs inside a GitHub Actions job.",
    );
  }
  return value;
}

/**
 * The environment handed to the CLI.
 *
 * `PRK_*` rather than `CF_ACCESS_*`: both are read by
 * `prick_auth::credential`, but `PRK_*` is checked FIRST, so setting those is
 * what guarantees the action's own inputs win over anything the workflow
 * happens to have in scope. The `CF_ACCESS_*` spelling exists for parity with
 * cloudflared and is what a workflow would already have set; this action does
 * not depend on it.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.base
 * @param {string} options.url
 * @param {string} options.project
 * @param {string} options.environment
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @returns {NodeJS.ProcessEnv}
 */
export function cliEnvironment({ base, url, project, environment, clientId, clientSecret }) {
  return {
    ...base,
    PRK_API_URL: url,
    PRK_PROJECT: project,
    PRK_ENV: environment,
    PRK_ACCESS_CLIENT_ID: clientId,
    PRK_ACCESS_CLIENT_SECRET: clientSecret,
  };
}

/**
 * Spawns a child and returns its result.
 *
 * `shell` on Windows, and only on Windows: npm and the npm-installed `prk` are
 * both `.cmd` shims there, and since the CVE-2024-24576 fix Node refuses to
 * execute a batch file without one. It is safe here because both argument
 * vectors are built from literals plus a version spec that `VERSION_SPEC` has
 * already restricted to `[\^~]?[A-Za-z0-9._+-]+` -- no separator, no
 * redirection, no substitution -- and because Node quotes what it passes to the
 * shell, which makes even the leading caret inert. User data supplied by the
 * workflow never appears in an argv at all; it goes through `env`.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} spawn
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error }}
 */
export function run(file, args, env, spawn = spawnSync) {
  const result = spawn(file, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Reads and validates every input.
 *
 * Inputs arrive as `PRICK_INPUT_*` environment variables rather than through
 * `${{ }}` interpolation into a shell command, which is what keeps a project
 * name containing `$(...)` from being a code-execution vector in the action
 * itself.
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

/**
 * `install`: validate the inputs, resolve the version, install the CLI.
 *
 * Validation happens here rather than in `inject` so that a plaintext URL or a
 * missing token fails in a second instead of after an npm install.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.env
 * @param {Io} options.io
 * @param {typeof spawnSync} [options.spawn]
 * @returns {number} exit code
 */
export function commandInstall({ env, io, spawn = spawnSync }) {
  const inputs = readInputs(env);
  const { spec, source } = resolveVersionSpec(inputs);

  io.log(`Installing ${CLI_PACKAGE}@${spec} (from ${source}).`);
  const result = run("npm", installArgs(spec), env, spawn);

  if (result.error || result.status !== 0) {
    if (result.stderr !== "") {
      io.log(result.stderr.trimEnd());
    }
    throw new ActionError(
      `installing ${CLI_PACKAGE}@${spec} failed`,
      spec === "latest"
        ? "Check that the runner can reach the npm registry."
        : `Check that ${spec} is a published version of ${CLI_PACKAGE}.`,
    );
  }

  return 0;
}

/**
 * `inject`: fetch the secrets and expose them.
 *
 * The ordering in here is the security property: every value is masked before
 * anything is written anywhere, and the CLI's stdout is never printed at any
 * point, on any path, including the failure paths.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.env
 * @param {Io} options.io
 * @param {typeof spawnSync} [options.spawn]
 * @param {(size: number) => Buffer} [options.random]
 * @returns {number} exit code
 */
export function commandInject({ env, io, spawn = spawnSync, random = randomBytes }) {
  const inputs = readInputs(env);

  io.log(
    `Reading secrets from project \`${inputs.project}\`, environment \`${inputs.environment}\`.`,
  );

  const result = run(CLI_BINARY, CLI_ARGS, cliEnvironment({ base: env, ...inputs }), spawn);

  if (result.error) {
    throw new ActionError(
      `could not run \`${CLI_BINARY}\``,
      "The install step did not put the CLI on PATH. Re-run with ACTIONS_STEP_DEBUG " +
        "enabled to see the npm output.",
    );
  }

  if (result.status !== 0) {
    // The CLI's stderr is safe to relay: it is a documented invariant of the
    // binary that no secret value appears there on any error path, and clippy's
    // workspace-wide `print_stderr = "deny"` is what enforces it. Its stdout is
    // NOT relayed, here or anywhere.
    if (result.stderr.trim() !== "") {
      io.log(result.stderr.trimEnd());
    }
    const { title, hint } = describeExit(result.status);
    throw new ActionError(`${CLI_BINARY} failed: ${title}`, hint);
  }

  const secrets = parseSecrets(result.stdout);
  const plan = planInjection({ ...inputs, secrets });

  if (plan.missing.length > 0) {
    throw new ActionError(
      `\`keys\` names ${plan.missing.length} secret(s) this environment does not have: ` +
        plan.missing.join(", "),
      "A job that starts without a variable it asked for fails later and less " +
        "clearly. Remove the name from `keys`, or add the secret.",
    );
  }

  for (const skipped of plan.skipped) {
    // Names the key. Never the value -- that is the whole point of this warning
    // existing rather than the action failing.
    io.command("warning", `Skipping \`${skipped.key}\`: ${skipped.reason}.`);
  }

  // ---- Mask first. Nothing below this point can reach a log unredacted. ----
  if (inputs.mask) {
    for (const entry of plan.entries) {
      for (const payload of maskPayloads(entry.value)) {
        io.command("add-mask", payload);
      }
    }
  } else {
    io.command(
      "warning",
      "Masking is disabled (mask: false). Secret values will appear in this job's " +
        "logs in full, and the log is readable by anyone who can read the repository.",
    );
  }

  const values = plan.entries.map((entry) => entry.value);
  const names = plan.entries.map((entry) => entry.name);

  if (inputs.exportTo === "env") {
    const delimiter = chooseDelimiter(values, random);
    io.appendEnv(renderBlock(plan.entries, delimiter));
  } else {
    const document = JSON.stringify(Object.fromEntries(plan.entries.map((e) => [e.name, e.value])));
    const delimiter = chooseDelimiter([...values, document], random);
    io.appendOutput(renderAssignment("secrets", document, delimiter));
  }

  // Names only, so this output is safe to print, log and branch on.
  const nameDelimiter = chooseDelimiter([names.join("\n")], random);
  io.appendOutput(renderAssignment("keys", names.join("\n"), nameDelimiter));

  io.log(
    `Injected ${plan.entries.length} secret(s) into ` +
      `${inputs.exportTo === "env" ? "the job environment" : "the `secrets` output"}` +
      `${plan.skipped.length > 0 ? `, skipped ${plan.skipped.length}` : ""}.`,
  );
  if (plan.entries.length > 0) {
    io.log(`Names: ${names.join(", ")}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Io} [options.io]
 * @param {typeof spawnSync} [options.spawn]
 * @param {(size: number) => Buffer} [options.random]
 * @returns {number} exit code
 */
export function main(argv, { env = process.env, io = realIo(env), spawn, random } = {}) {
  const subcommand = argv[0] ?? "";
  try {
    if (subcommand === "install") {
      return commandInstall({ env, io, spawn });
    }
    if (subcommand === "inject") {
      return commandInject({ env, io, spawn, random });
    }
    throw new ActionError(
      `unknown subcommand \`${subcommand}\``,
      "Expected `install` or `inject`.",
    );
  } catch (error) {
    const failure = /** @type {ActionError} */ (error);
    io.command("error", `prick: ${failure.message}`);
    if (failure.hint) {
      io.log(failure.hint);
    }
    return 1;
  }
}

// `import.meta.main` is Node 24+; this file is only ever run by the action, on
// a runner whose Node is far newer than that, but the fallback keeps the module
// importable by the test suite under any version.
const isEntry = import.meta.main ?? process.argv[1]?.endsWith("inject.mjs");
if (isEntry) {
  process.exitCode = main(process.argv.slice(2));
}
