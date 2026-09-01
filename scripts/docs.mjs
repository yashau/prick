#!/usr/bin/env node
// scripts/docs.mjs — cut a release of the documentation site.
//
//   node scripts/docs.mjs next             what the next docs release would be
//   node scripts/docs.mjs cut [--yes]      tag and push — this releases
//   node scripts/docs.mjs status           follow the most recent run
//
// The docs site is versioned with the same CalVer scheme as the CLI, on its own
// tag prefix: `docs-v2026.815.0`. The two lines count N independently, so cutting
// docs three times in a day does not make the next CLI release `.3`.
//
// CUTTING THE VERSION IS WHAT DEPLOYS IT.
//
// docs-release.yml triggers on a `docs-v*` tag push and on nothing else — not on
// a push to main, not on a docs edit. So there is exactly one way the site ships,
// every shipped state has a version, and `git show docs-v2026.815.0` says who
// shipped it and when.
//
// HOW THIS DIFFERS FROM cli:cut — AND WHY IT DOES NOT
//
// It no longer differs. Both lines cut the same way: the tag is created and
// pushed locally, and that push is the workflow trigger. (Until this rework the
// CLI release was a `workflow_dispatch` whose `plan` job pushed the tag from
// inside CI, so cli:cut had to be careful NOT to touch a ref — it would have
// taken the lock the workflow depended on. That inversion is gone; there is one
// mechanism to understand instead of two that differed for no reason.)
//
// The lock property survives the move unchanged: git refuses to push a tag that
// already exists, so two people cutting simultaneously cannot both take the same
// N. The loser's push is rejected, and scripts/version.mjs `claimTag` recomputes
// N against the tags that then exist rather than merely incrementing.
//
// The confirmation is the typed tag, exactly as cli:cut demands, and for the same
// reason: it cannot be typed from muscle memory, so typing it means you read the
// version. A docs deploy is more reversible than an npm publish, but the *tag* is
// not — a tag is permanent, and recovery from a wrong one is roll-forward only.
//
// Cloudflare credentials live in GitHub repository secrets, so the build and
// deploy still run in CI. Nothing here needs a Cloudflare token on a laptop.
//
// Every side effect is injectable, so scripts/docs.test.mjs never invokes gh, git
// or a terminal.

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DOCS_TAG_PREFIX, claimTag, gitTags, planVersion, tagGlob } from './version.mjs';

/** The workflow this release line drives. */
export const WORKFLOW = 'docs-release.yml';

/** The tag prefix that identifies this release line. */
export const TAG_PREFIX = DOCS_TAG_PREFIX;

/** The `on.push.tags` glob docs-release.yml triggers on. */
export const TAG_GLOB = tagGlob(TAG_PREFIX);

/**
 * Where the site is served from.
 *
 * Three files have to agree on this, and each states it in a different
 * language: the `routes` block in packages/docs/wrangler.jsonc is what puts
 * the Worker on the hostname, `site` in packages/docs/astro.config.ts is what
 * the built pages advertise as canonical, and this is what a cut prints and
 * writes into the tag annotation.
 *
 * scripts/docs.test.mjs asserts all three, so a hostname change that misses
 * one fails the suite rather than shipping half done.
 */
export const DOCS_URL = 'https://docs.getprick.dev';

/**
 * The exact string a human must type to confirm a cut.
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
 * Arguments for listing recent runs of the docs workflow.
 *
 * @param {number} [limit]
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
    'databaseId,status,conclusion,headSha,headBranch,createdAt,url',
  ];
}

/**
 * The annotation carried by the tag `cut` pushes.
 *
 * @param {object} plan
 * @returns {string}
 */
export function tagMessage(plan) {
  return [
    plan.tag,
    '',
    `Documentation site ${plan.calver} — release ${plan.patch} of ${plan.date} (UTC).`,
    `Serving ${DOCS_URL} from this commit.`,
    '',
    `Pushing this tag is what deployed it; ${WORKFLOW} computes no version.`,
  ].join('\n');
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
    `  N         ${plan.patch}${plan.patch === 0 ? '  (first docs release today)' : ''}`,
  ];
}

/**
 * Everything a human needs in front of them before typing the confirmation.
 *
 * @param {object} plan
 * @returns {string[]}
 */
export function formatCutSummary(plan) {
  return [
    'About to cut a documentation release.',
    '',
    ...formatPlanSummary(plan),
    '',
    '  builds    packages/docs (Astro + Starlight) from the docs/ Markdown',
    '  deploys   the prick-docs Worker — public, no secrets, no access control',
    `  serves    ${DOCS_URL}`,
    `  releases  a GitHub Release for ${plan.tag}`,
    '',
    `Confirming pushes the tag ${plan.tag}, and that push is what starts`,
    `${WORKFLOW}. Nothing else does — not a push to main, not a docs edit.`,
    '',
    'The deploy itself is reversible: fix the source and cut the next N. The tag',
    'is not. Never delete and re-push a tag — roll forward.',
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
 * git, always captured: a claim attempt that loses a race is expected rather
 * than exceptional, so the progress `git fetch` and `git push` write to stderr
 * must not reach the operator's terminal.
 *
 * @param {string} root
 * @returns {(args: readonly string[]) => string}
 */
function makeGit(root) {
  return (args) =>
    run('git', args, { capture: true, cwd: root, hint: 'git was not found on PATH.' });
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
  log('Next documentation release:');
  log('');
  for (const line of formatPlanSummary(plan)) log(line);
  log('');
  log(`Cut it:   mise run docs:cut`);
  return 0;
}

/** @param {object} ctx */
async function cmdCut({ plan, git, log, logErr, prompt, assumeYes, interactive, now, sleep }) {
  for (const line of formatCutSummary(plan)) log(line);

  if (!assumeYes) {
    if (!interactive) {
      logErr('refusing to cut a docs release without a confirmation.');
      logErr('Re-run attached to a terminal, or pass --yes for automation:');
      logErr('  mise run docs:cut -- --yes');
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
  log('Follow it with: mise run docs:status');
  return 0;
}

/** @param {object} ctx */
function cmdStatus({ gh, log, logErr }) {
  const raw = gh(runListArgs(1), { capture: true });
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
  log(
    `${WORKFLOW} #${entry.databaseId}  ${entry.status}${entry.conclusion ? ` (${entry.conclusion})` : ''}`,
  );
  log(`  ref        ${entry.headBranch}`);
  log(`  commit     ${String(entry.headSha ?? '').slice(0, 7)}`);
  log(`  started    ${entry.createdAt}`);
  log(`  url        ${entry.url}`);

  if (entry.status !== 'completed') {
    log('');
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

const USAGE = `usage: node scripts/docs.mjs <command>

  next             print the version the next cut would take. Read-only.
  cut [--yes]      tag and push — the push is what deploys
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

  // next/cut need today's version. `status` deliberately does not, so it keeps
  // working in a checkout where tags are unavailable.
  const now = io.now ?? new Date();
  const tags = io.tags ?? gitTags(root);
  const plan = planVersion({ tags, now, tagPrefix: TAG_PREFIX });

  switch (command) {
    case 'next':
      return cmdNext({ plan, log });
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
