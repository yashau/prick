#!/usr/bin/env node
// scripts/cli-release.mjs — cut a release of the `prk` CLI.
//
//   node scripts/cli-release.mjs next             what the next release would be
//   node scripts/cli-release.mjs dry              dispatch with dry_run=true
//   node scripts/cli-release.mjs cut [--yes]      tag and push — this releases
//   node scripts/cli-release.mjs status           follow the most recent run
//
// CUTTING THE VERSION IS WHAT RELEASES.
//
// `cut` computes the CalVer version, requires a typed confirmation of the tag,
// then creates an annotated tag and pushes it. That push is the trigger for
// cli-release.yml; nothing else starts a release. The workflow computes no
// version — it builds, publishes and releases the commit it was handed.
//
// The tag is still the lock. git refuses to push a ref that already exists, so
// two people cutting in the same second cannot both take the same N; the loser's
// push bounces and `claimTag` recomputes N against the tags that now exist. That
// retry used to live in the workflow and now lives in scripts/version.mjs, which
// is where the docs line gets it from too.
//
// The version is therefore a decision a human makes, at cut time, recorded in
// git before any CI runs — rather than something CI derives and the human finds
// out about afterwards.
//
// `dry` is the one thing that still dispatches: it builds all eight platform
// binaries and stages the ten npm packages without claiming a version, so it
// needs a workflow_dispatch and no tag.
//
// The pure parts (package list, summary formatting, confirmation matching,
// argument construction) are exported for scripts/cli-release.test.mjs, and every
// side effect is injectable, so the tests never invoke gh, git or a terminal.

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { MCP_PACKAGE, PARENT_PACKAGE, PLATFORMS } from './npm-package.mjs';
import { CLI_TAG_PREFIX, claimTag, gitTags, planVersion, tagGlob } from './version.mjs';

/** The workflow this release line drives. */
export const WORKFLOW = 'cli-release.yml';

/** The tag prefix that identifies this release line. */
export const TAG_PREFIX = CLI_TAG_PREFIX;

/** The `on.push.tags` glob cli-release.yml triggers on. */
export const TAG_GLOB = tagGlob(TAG_PREFIX);

/**
 * The ten packages a real release publishes, in publish order.
 *
 * The parent is LAST on purpose. Everything publishes under `--tag next`, and
 * `latest` only moves once all ten verify and a real `npm install && prk
 * --version` smoke test passes — parent last, so `latest` never points at a
 * shim whose platform packages are not yet resolvable.
 *
 * The MCP server sits between the two groups: nothing depends on it, so its
 * position is only a matter of keeping the parent's flip the final act.
 *
 * @returns {string[]}
 */
export function publishedPackages() {
  return [...PLATFORMS.map((p) => p.name), MCP_PACKAGE, PARENT_PACKAGE];
}

/**
 * The exact string a human must type to confirm a real release.
 *
 * The tag, not "yes": it cannot be typed by muscle memory, and typing it means
 * you read the version you are about to make permanent.
 *
 * @param {{ tag: string }} plan
 * @returns {string}
 */
export function confirmationToken(plan) {
  return plan.tag;
}

/**
 * @param {string} input
 * @param {{ tag: string }} plan
 * @returns {boolean}
 */
export function isConfirmed(input, plan) {
  return String(input ?? '').trim() === confirmationToken(plan);
}

/**
 * @param {boolean} dryRun
 * @returns {string[]} argv for `gh`
 */
export function workflowRunArgs(dryRun) {
  return ['workflow', 'run', WORKFLOW, '-f', `dry_run=${dryRun ? 'true' : 'false'}`];
}

/**
 * The annotation carried by the tag `cut` pushes.
 *
 * @param {object} plan
 * @returns {string}
 */
export function tagMessage(plan) {
  return `${plan.tag}\n\nprk ${plan.calver} — release ${plan.patch} of ${plan.date} (UTC).`;
}

/**
 * @param {object} plan
 * @returns {string[]}
 */
export function formatPlanSummary(plan) {
  return [
    `  version   ${plan.version}`,
    `  calver    ${plan.calver}`,
    `  tag       ${plan.tag}`,
    `  date      ${plan.date} (UTC)`,
    `  N         ${plan.patch}${plan.patch === 0 ? '  (first release today)' : ''}`,
  ];
}

/**
 * Everything a human needs in front of them before typing the confirmation.
 *
 * @param {object} plan
 * @returns {string[]}
 */
export function formatCutSummary(plan) {
  const packages = publishedPackages();
  return [
    'About to cut a REAL release.',
    '',
    ...formatPlanSummary(plan),
    '',
    `  publishes ${packages.length} packages to npm:`,
    ...packages.map((name, i) => `    ${String(i + 1).padStart(2)}. ${name}`),
    '',
    'This is not undoable. npm versions are immutable: a mistake can only be',
    'rolled back by moving the `latest` dist-tag and deprecating, never deleted.',
    'Recovery is roll-forward — cut the next N. Never delete and re-push a tag.',
    '',
    `Confirming pushes the tag ${plan.tag}, and that push is what starts`,
    `${WORKFLOW}. Nothing else does.`,
    '',
    'If somebody else claims this N between now and the push, the tag is',
    'recomputed against the tags that then exist and the claimed tag is printed.',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Effects (all injectable)
// ---------------------------------------------------------------------------

/**
 * @param {string} program
 * @param {readonly string[]} args
 * @param {{ capture?: boolean, cwd?: string, hint: string }} options
 * @returns {string}
 */
function run(program, args, { capture = false, cwd, hint }) {
  try {
    if (capture) {
      return execFileSync(program, [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const result = spawnSync(program, [...args], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${program} ${args.join(' ')} exited with status ${result.status}`);
    }
    return '';
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(hint);
    throw error;
  }
}

/**
 * @param {readonly string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {string}
 */
function runGh(args, { capture = false } = {}) {
  return run('gh', args, {
    capture,
    hint: 'the GitHub CLI (gh) was not found. It is pinned in mise.toml — run `mise install`.',
  });
}

/**
 * git, always captured: `git fetch` and `git push` write progress to stderr, and
 * a claim attempt that loses a race is expected rather than exceptional, so its
 * noise must not reach the operator's terminal.
 *
 * @param {string} root
 * @returns {(args: readonly string[]) => string}
 */
function makeGit(root) {
  return (args) =>
    run('git', args, {
      capture: true,
      cwd: root,
      hint: 'git was not found on PATH.',
    });
}

/**
 * @param {string} question
 * @returns {Promise<string>}
 */
async function promptTty(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** @param {object} ctx */
function cmdNext({ plan, log }) {
  log('Next CLI release:');
  log('');
  for (const line of formatPlanSummary(plan)) log(line);
  log('');
  log(`Dry run:  mise run cli:dry`);
  log(`Cut it:   mise run cli:cut`);
  return 0;
}

/** @param {object} ctx */
function cmdDry({ plan, gh, log }) {
  log(`Dispatching ${WORKFLOW} with dry_run=true (today's next version is ${plan.tag}).`);
  log(`Builds all 8 platform binaries and stages the ${publishedPackages().length} npm packages.`);
  log('Publishes nothing, pushes no tag, claims no version.');
  log('');
  gh(workflowRunArgs(true));
  log('');
  log('Dispatched. Follow it with: mise run cli:status');
  return 0;
}

/** @param {object} ctx */
async function cmdCut({ plan, git, log, logErr, prompt, assumeYes, interactive, now, sleep }) {
  for (const line of formatCutSummary(plan)) log(line);

  if (!assumeYes) {
    if (!interactive) {
      logErr('refusing to cut a release without a confirmation.');
      logErr('Re-run attached to a terminal, or pass --yes for automation:');
      logErr('  mise run cli:cut -- --yes');
      return 1;
    }
    const answer = await prompt(`Type ${confirmationToken(plan)} to confirm: `);
    if (!isConfirmed(answer, plan)) {
      logErr('aborted — no tag was created and nothing was pushed.');
      return 1;
    }
  }

  const claimed = await claimTag({
    git,
    tagPrefix: TAG_PREFIX,
    now,
    message: tagMessage,
    log,
    ...(sleep ? { sleep } : {}),
  });

  log('');
  if (claimed.plan.tag !== plan.tag) {
    log(`NOTE: ${plan.tag} was taken while you were reading. Claimed ${claimed.plan.tag} instead.`);
  }
  log(`Pushed ${claimed.plan.tag}. That push started ${WORKFLOW}.`);
  log('Follow it with: mise run cli:status');
  return 0;
}

/** @param {object} ctx */
function cmdStatus({ gh, log, logErr }) {
  const fields = 'databaseId,status,conclusion,displayTitle,headBranch,createdAt,url';
  const raw = gh(['run', 'list', '--workflow', WORKFLOW, '--limit', '1', '--json', fields], {
    capture: true,
  });

  let runs;
  try {
    runs = JSON.parse(raw || '[]');
  } catch {
    logErr(`could not parse the run list returned by gh: ${String(raw).slice(0, 200)}`);
    return 1;
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    log(`no ${WORKFLOW} runs yet.`);
    return 0;
  }

  const [entry] = runs;
  log(`${WORKFLOW} #${entry.databaseId} — ${entry.displayTitle}`);
  log(`  ref        ${entry.headBranch}`);
  log(`  started    ${entry.createdAt}`);
  log(`  status     ${entry.status}${entry.conclusion ? ` (${entry.conclusion})` : ''}`);
  log(`  url        ${entry.url}`);
  log('');

  if (entry.status !== 'completed') {
    // --exit-status makes a failed run a failed command, so this is usable as a
    // gate. Still read-only: watching mutates nothing.
    gh(['run', 'watch', String(entry.databaseId), '--exit-status']);
    return 0;
  }

  if (entry.conclusion !== 'success') {
    logErr(`the most recent run finished with: ${entry.conclusion}`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/cli-release.mjs <command>

  next             print the version the next cut would take. Read-only.
  dry              dispatch ${WORKFLOW} with dry_run=true — publishes nothing
  cut [--yes]      tag and push — the push is what releases
  status           follow the most recent ${WORKFLOW} run. Read-only.

options:
  --yes            skip the typed confirmation (cut only, for automation)
  --root <dir>     repository root (default: the parent of scripts/)

Cutting the version is what deploys it: ${WORKFLOW} triggers on a
${TAG_GLOB} tag push and on nothing else, and computes no version of its own.
`;

/**
 * @param {readonly string[]} argv
 * @param {object} [io] injection points: log, logErr, gh, git, prompt, tags,
 *   now, sleep, interactive, root
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const logErr = io.logErr ?? ((s) => process.stderr.write(`${s}\n`));
  const gh = io.gh ?? runGh;
  const prompt = io.prompt ?? promptTty;
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY);

  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = path.resolve(io.root ?? values.root ?? defaultRoot);
  const [command] = positionals;

  if (values.help || !command) {
    log(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'status') return cmdStatus({ gh, log, logErr });

  // next/dry/cut all need today's version. `status` deliberately does not, so it
  // keeps working in a checkout where tags are unavailable.
  const now = io.now ?? new Date();
  const tags = io.tags ?? gitTags(root);
  const plan = planVersion({ tags, now, tagPrefix: TAG_PREFIX });

  switch (command) {
    case 'next':
      return cmdNext({ plan, log });
    case 'dry':
      return cmdDry({ plan, gh, log });
    case 'cut':
      return cmdCut({
        plan,
        git: io.git ?? makeGit(root),
        log,
        logErr,
        prompt,
        assumeYes: values.yes,
        interactive,
        now,
        sleep: io.sleep,
      });
    default:
      logErr(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
