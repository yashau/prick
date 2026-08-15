// action/cli.mjs — the boundary with the `prk` binary: which version to
// install, how to invoke it, what its exit codes mean, and how to read what it
// prints.
//
// The four belong together because they are one contract with one program, and
// changing any of them without the others is how an action and a CLI drift
// apart. Reading the CLI's output is part of that contract too, which is why
// `parseSecrets` is here rather than in its own file -- it exists to consume
// exactly what `CLI_ARGS` asks for.
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

import { ActionError } from "./errors.mjs";

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
// Invocation
// ---------------------------------------------------------------------------

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
