#!/usr/bin/env node
// action/inject.mjs — the entry point of the composite action in `action/`.
//
//   node inject.mjs install     validate the inputs, resolve and install the CLI
//   node inject.mjs inject      fetch the secrets and expose them to later steps
//
// THE RULE THIS ACTION EXISTS TO ENFORCE
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
// The action is structured so that this is checkable rather than promised.
// Both destinations, and the escaping that makes each safe, live in ./io.mjs:
// every write to a stream funnels through exactly one function each
// (`command()` for stdout, `log()` for stderr), both defined in `realIo()`, and
// inject.test.mjs reads every source file in this directory and asserts there
// is no second one anywhere.
//
// THE ORDER IN `commandInject` IS THE OTHER HALF OF THE RULE. Nothing is
// written until every value has been masked, and the CLI's stdout is never
// printed on any path, including the failure paths.
//
// THE REST OF THE ACTION
//
//   ./cli.mjs      the `prk` boundary: version, argv, exit codes, output
//   ./inputs.mjs   the `PRICK_INPUT_*` variables, validated
//   ./io.mjs       the mask command, the heredoc writer, the only stream writes
//   ./plan.mjs     the name rules and the injection plan
//   ./errors.mjs   ActionError

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLI_ARGS,
  CLI_BINARY,
  CLI_PACKAGE,
  cliEnvironment,
  describeExit,
  installArgs,
  parseSecrets,
  resolveVersionSpec,
  run,
  stagingArgs,
  verifiedVersion,
  verifyArgs,
} from "./cli.mjs";
import { ActionError } from "./errors.mjs";
import { readInputs } from "./inputs.mjs";
import { chooseDelimiter, maskPayloads, realIo, renderAssignment, renderBlock } from "./io.mjs";
import { planInjection } from "./plan.mjs";

/**
 * A fresh directory to stage and verify a candidate version in.
 *
 * `RUNNER_TEMP` in preference to the operating system's temporary directory: the
 * runner empties it at the start of every job, so the staged tree needs no
 * cleanup here -- and leaving it in place is what makes a verification failure
 * something a maintainer can go and look at rather than only read about.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function stagingDirectory(env) {
  const base = String(env.RUNNER_TEMP ?? "").trim();
  return mkdtempSync(join(base === "" ? tmpdir() : base, "prick-verify-"));
}

/**
 * `install`: validate the inputs, resolve the version, VERIFY it, install it.
 *
 * Validation happens here rather than in `inject` so that a plaintext URL or a
 * missing token fails in a second instead of after an npm install.
 *
 * Three npm invocations, in an order that matters -- see the Provenance section
 * of cli.mjs for why the version is staged and audited before it is installed,
 * and why the global install below names an exact version rather than the spec
 * that was resolved.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.env
 * @param {import('./io.mjs').Io} options.io
 * @param {typeof spawnSync} [options.spawn]
 * @param {(env: NodeJS.ProcessEnv) => string} [options.staging]
 * @returns {number} exit code
 */
export function commandInstall({ env, io, spawn = spawnSync, staging = stagingDirectory }) {
  const inputs = readInputs(env);
  const { spec, source } = resolveVersionSpec(inputs);

  io.log(`Resolving ${CLI_PACKAGE}@${spec} (from ${source}).`);

  const directory = staging(env);
  const staged = run("npm", stagingArgs(spec), env, spawn, directory);

  if (staged.error || staged.status !== 0) {
    if (staged.stderr !== "") {
      io.log(staged.stderr.trimEnd());
    }
    throw new ActionError(
      `fetching ${CLI_PACKAGE}@${spec} failed`,
      spec === "latest"
        ? "Check that the runner can reach the npm registry."
        : `Check that ${spec} is a published version of ${CLI_PACKAGE}.`,
    );
  }

  const audited = run("npm", verifyArgs(), env, spawn, directory);

  if (audited.error) {
    throw new ActionError(
      "could not run `npm audit signatures`",
      "The runner's npm is too old to verify provenance. npm 9.5 or newer is needed, " +
        "and every supported runner image ships one.",
    );
  }
  // A non-zero status is npm saying it would not or could not verify something.
  // Its stderr says which, and carries no secret: nothing has been fetched yet.
  if (audited.status !== 0 && audited.stderr.trim() !== "") {
    io.log(audited.stderr.trimEnd());
  }

  // Throws unless this exact version verified. Never falls through to the
  // install on a check that merely failed to run.
  const version = verifiedVersion(audited.stdout);
  io.log(`Verified ${CLI_PACKAGE}@${version}: registry signature and provenance attestation.`);

  const result = run("npm", installArgs(version), env, spawn);

  if (result.error || result.status !== 0) {
    if (result.stderr !== "") {
      io.log(result.stderr.trimEnd());
    }
    throw new ActionError(
      `installing ${CLI_PACKAGE}@${version} failed`,
      "The version verified but would not install. Re-run with ACTIONS_STEP_DEBUG " +
        "enabled to see the npm output.",
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
 * @param {import('./io.mjs').Io} options.io
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
 * @param {import('./io.mjs').Io} [options.io]
 * @param {typeof spawnSync} [options.spawn]
 * @param {(size: number) => Buffer} [options.random]
 * @param {(env: NodeJS.ProcessEnv) => string} [options.staging]
 * @returns {number} exit code
 */
export function main(argv, { env = process.env, io = realIo(env), spawn, random, staging } = {}) {
  const subcommand = argv[0] ?? "";
  try {
    if (subcommand === "install") {
      return commandInstall({ env, io, spawn, staging });
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
