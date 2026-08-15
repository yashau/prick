#!/usr/bin/env node
// Cut and follow documentation-site deployments.
//
// The docs site is a separate Worker from the app: it is public, holds no
// secrets and is fronted by no access control, so deploying it is materially
// lower-stakes than cutting a CLI release. It is also idempotent -- a bad
// deploy is fixed by deploying again, whereas an npm version is immutable
// forever. The confirmation here is therefore a simple y/N rather than the
// typed-tag token release:cut demands.
//
// Deployment runs in CI, not locally, because the Cloudflare credentials live
// in GitHub repository secrets and should never need to exist on a laptop.

import { execFileSync, spawnSync } from 'node:child_process';

export const WORKFLOW = 'deploy-docs.yml';

/**
 * Arguments for dispatching the docs deployment.
 *
 * @returns {string[]}
 */
export function workflowRunArgs() {
  return ['workflow', 'run', WORKFLOW];
}

/**
 * Arguments for listing recent runs of the docs workflow.
 *
 * @param {number} limit
 * @returns {string[]}
 */
export function runListArgs(limit = 1) {
  return [
    'run',
    'list',
    '--workflow',
    WORKFLOW,
    '--limit',
    String(limit),
    '--json',
    'databaseId,status,conclusion,headSha,createdAt',
  ];
}

/**
 * A plain y/N confirmation. Deploying docs is reversible, so this exists to
 * stop an accidental keystroke, not to make the operator prove intent.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isConfirmed(input) {
  return /^y(es)?$/i.test(String(input ?? '').trim());
}

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
async function cmdDeploy({ gh, log, logErr, prompt, assumeYes, interactive }) {
  log(`Deploy the documentation site by dispatching ${WORKFLOW}.`);
  log('');
  log('  builds   packages/docs (Astro + Starlight) from the docs/ Markdown');
  log('  deploys  the prick-docs Worker — public, no secrets, no access control');
  log('');
  log('Cloudflare credentials come from the repository secrets, so this runs in');
  log('CI rather than locally. Re-deploying replaces the site, so a bad deploy is');
  log('fixed by fixing the source and deploying again.');
  log('');

  if (!assumeYes) {
    if (!interactive) {
      logErr('refusing to deploy without a confirmation.');
      logErr('Re-run attached to a terminal, or pass --yes for automation:');
      logErr('  mise run docs:deploy -- --yes');
      return 1;
    }
    const answer = await prompt('Deploy the docs site? [y/N] ');
    if (!isConfirmed(answer)) {
      log('Aborted. Nothing was dispatched.');
      return 1;
    }
  }

  gh(workflowRunArgs());
  log('');
  log('Dispatched. Follow it with: mise run docs:status');
  return 0;
}

/** @param {object} ctx */
function cmdStatus({ gh, log, logErr }) {
  const raw = gh(runListArgs(1), { capture: true });
  let runs;
  try {
    runs = JSON.parse(raw || '[]');
  } catch {
    logErr(`could not parse the run list returned by gh: ${raw.slice(0, 200)}`);
    return 1;
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    log(`no ${WORKFLOW} runs yet.`);
    return 0;
  }

  const [run] = runs;
  log(`run ${run.databaseId}  ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`);
  log(`commit ${String(run.headSha ?? '').slice(0, 7)}  started ${run.createdAt}`);

  if (run.status !== 'completed') {
    log('');
    gh(['run', 'watch', String(run.databaseId), '--exit-status']);
    return 0;
  }

  return run.conclusion === 'success' ? 0 : 1;
}

// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} argv
 * @param {object} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const {
    gh = runGh,
    log = (line) => process.stdout.write(`${line}\n`),
    logErr = (line) => process.stderr.write(`${line}\n`),
    prompt = promptTty,
    isTty = Boolean(process.stdin.isTTY),
  } = io;

  const args = [...argv];
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const command = args.find((a) => !a.startsWith('-'));

  const ctx = { gh, log, logErr, prompt, assumeYes, interactive: isTty };

  switch (command) {
    case 'deploy':
      return cmdDeploy(ctx);
    case 'status':
      return cmdStatus(ctx);
    default:
      logErr(`unknown command: ${command ?? '(none)'}`);
      logErr('usage: node scripts/docs.mjs <deploy|status> [--yes]');
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href.replace(/\\/g, '/');

if (invokedDirectly || process.argv[1]?.endsWith('docs.mjs')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
