#!/usr/bin/env node
// scripts/release.mjs — cut a release by dispatching release.yml.
//
//   node scripts/release.mjs preview          what the next release would be
//   node scripts/release.mjs dry              dispatch with dry_run=true
//   node scripts/release.mjs cut [--yes]      dispatch with dry_run=false
//   node scripts/release.mjs status           follow the most recent run
//
// WHY THIS DISPATCHES A WORKFLOW INSTEAD OF TAGGING LOCALLY
//
// release.yml's `plan` job computes the CalVer version and pushes the tag
// itself, and that push IS the concurrency lock: git refuses a duplicate ref, so
// two racing runs cannot both claim the same N. There is no external mutex.
// Creating the tag here would take the lock the workflow depends on and make the
// `plan` job fail against its own release — so `cut` never touches a ref. The
// version this script prints is a *prediction*, computed the same way `plan`
// computes it; the workflow remains the authority.
//
// The pure parts (package list, summary formatting, confirmation matching,
// argument construction) are exported for scripts/release.test.mjs, and every
// side effect is injectable, so the tests never invoke gh or git.

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { PARENT_PACKAGE, PLATFORMS } from './npm-package.mjs';
import { gitTags, planVersion } from './version.mjs';

/** The workflow this script drives. */
export const WORKFLOW = 'release.yml';

/**
 * The nine packages a real release publishes, in publish order.
 *
 * The parent is LAST on purpose. Everything publishes under `--tag next`, and
 * `latest` only moves once all nine verify and a real `npm install && prk
 * --version` smoke test passes — parent last, so `latest` never points at a
 * shim whose platform packages are not yet resolvable.
 *
 * @returns {string[]}
 */
export function publishedPackages() {
  return [...PLATFORMS.map((p) => p.name), PARENT_PACKAGE];
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
    `The tag ${plan.tag} is pushed by the workflow, not by this command.`,
    'The version above is a prediction; release.yml recomputes it and wins.',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Effects (all injectable)
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {string}
 */
function runGh(args, { capture = false } = {}) {
  try {
    if (capture) {
      return execFileSync('gh', [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const result = spawnSync('gh', [...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`gh ${args.join(' ')} exited with status ${result.status}`);
    }
    return '';
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(
        'the GitHub CLI (gh) was not found. It is pinned in mise.toml — run `mise install`.',
      );
    }
    throw error;
  }
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
function cmdPreview({ plan, log }) {
  log('Next release:');
  log('');
  for (const line of formatPlanSummary(plan)) log(line);
  log('');
  log(`Dry run:  mise run release:dry`);
  log(`Cut it:   mise run release:cut`);
  return 0;
}

/** @param {object} ctx */
function cmdDry({ plan, gh, log }) {
  log(`Dispatching ${WORKFLOW} with dry_run=true (predicted ${plan.tag}).`);
  log('Builds all 8 platform binaries and stages the 9 npm packages.');
  log('Publishes nothing, pushes no tag.');
  log('');
  gh(workflowRunArgs(true));
  log('');
  log('Dispatched. Follow it with: mise run release:status');
  return 0;
}

/** @param {object} ctx */
async function cmdCut({ plan, gh, log, logErr, prompt, assumeYes, interactive }) {
  for (const line of formatCutSummary(plan)) log(line);

  if (!assumeYes) {
    if (!interactive) {
      logErr('refusing to cut a release without a confirmation.');
      logErr('Re-run attached to a terminal, or pass --yes for automation:');
      logErr('  mise run release:cut -- --yes');
      return 1;
    }
    const answer = await prompt(`Type ${confirmationToken(plan)} to confirm: `);
    if (!isConfirmed(answer, plan)) {
      logErr('aborted — nothing was dispatched.');
      return 1;
    }
  }

  gh(workflowRunArgs(false));
  log('');
  log('Dispatched. Follow it with: mise run release:status');
  return 0;
}

/** @param {object} ctx */
function cmdStatus({ gh, log, logErr }) {
  const fields = 'databaseId,status,conclusion,displayTitle,headBranch,createdAt,url';
  const raw = gh(['run', 'list', '--workflow', WORKFLOW, '--limit', '1', '--json', fields], {
    capture: true,
  });

  const runs = JSON.parse(raw || '[]');
  if (runs.length === 0) {
    log(`no ${WORKFLOW} runs yet.`);
    return 0;
  }

  const [run] = runs;
  log(`${WORKFLOW} #${run.databaseId} — ${run.displayTitle}`);
  log(`  branch     ${run.headBranch}`);
  log(`  started    ${run.createdAt}`);
  log(`  status     ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`);
  log(`  url        ${run.url}`);
  log('');

  if (run.status !== 'completed') {
    // --exit-status makes a failed run a failed command, so this is usable as a
    // gate. Still read-only: watching mutates nothing.
    gh(['run', 'watch', String(run.databaseId), '--exit-status']);
    return 0;
  }

  if (run.conclusion !== 'success') {
    logErr(`the most recent run finished with: ${run.conclusion}`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/release.mjs <command>

  preview          print the version the next release would take. Read-only.
  dry              dispatch ${WORKFLOW} with dry_run=true
  cut [--yes]      dispatch ${WORKFLOW} with dry_run=false — publishes for real
  status           follow the most recent ${WORKFLOW} run. Read-only.

options:
  --yes            skip the typed confirmation (cut only, for automation)
  --root <dir>     repository root (default: the parent of scripts/)

The git tag is pushed by the workflow, never by this command: that push is the
concurrency lock the workflow depends on.
`;

/**
 * @param {readonly string[]} argv
 * @param {object} [io] injection points: log, logErr, gh, prompt, tags, now,
 *   interactive, root
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

  // preview/dry/cut all need the predicted version. `status` deliberately does
  // not, so it keeps working in a checkout where tags are unavailable.
  const tags = io.tags ?? gitTags(root);
  const plan = planVersion({ tags, now: io.now ?? new Date() });

  switch (command) {
    case 'preview':
      return cmdPreview({ plan, log });
    case 'dry':
      return cmdDry({ plan, gh, log });
    case 'cut':
      return cmdCut({
        plan,
        gh,
        log,
        logErr,
        prompt,
        assumeYes: values.yes,
        interactive,
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
