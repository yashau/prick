// action/plan.mjs — which of the store's keys become environment variables.
//
// Two things live here because the second is the only consumer of the first:
// the NAME RULES (the POSIX grammar, plus the denylist of names that are
// interpreted before a program's own code runs), and the PLAN that applies them
// to a fetched secret set.
//
// It is pure. Nothing here reads the environment, spawns anything, writes
// anywhere or touches a clock -- it takes the secret set and the inputs and
// returns a description of what should happen. All the masking and file writing
// happens afterwards, against that description, which is what makes the
// ordering in `commandInject` checkable.

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
