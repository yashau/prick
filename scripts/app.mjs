#!/usr/bin/env node
// scripts/app.mjs — version the web app (the Worker in packages/app).
//
//   node scripts/app.mjs next             what the next app release would be
//   node scripts/app.mjs cut [--yes]      tag and push an app-v* tag
//   node scripts/app.mjs set [<version>]  stamp a version into the app
//
// The web app is versioned with the same CalVer scheme as the CLI and the docs
// site, on its own tag prefix: `app-v2026.815.0`. The three lines count N
// independently.
//
// THERE IS NO APP WORKFLOW, AND THAT IS THE DIFFERENCE.
//
// This repository never deploys the Worker; every self-hoster deploys it from
// their own checkout to their own account. So an `app-v*` tag does not ship
// anything — it NAMES a known-good state of the Worker. Cutting one is the same
// claim-and-push as cli:cut and docs:cut (git refuses a duplicate tag, so two
// people cannot both take N), and it starts no workflow: neither `v*` nor
// `docs-v*` matches an `app-v` tag, which version.test.mjs asserts.
//
// `set` is how a version reaches a running Worker. It rewrites the one constant
// in packages/app/src/lib/version.js, which `/api/v1/health`, the OpenAPI
// document and SvelteKit's `version.name` all read. With no argument it takes the
// version from the `app-v*` tag on HEAD, so the deploy recipe is:
//
//   git checkout app-v2026.815.0
//   mise run app:set
//   pnpm --dir packages/app exec wrangler deploy
//
// The stamped file is a working-tree change, exactly like `version:set` for the
// CLI: never commit it. The committed value is always `0.0.0-dev`.
//
// Every side effect is injectable, so scripts/app.test.mjs never invokes git, a
// terminal or the filesystem outside a temporary directory.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  APP_TAG_PREFIX,
  DEV_VERSION,
  VERSION_RE,
  claimTag,
  gitTags,
  planVersion,
  tagGlob,
} from './version.mjs';

/** The tag prefix that identifies this release line. */
export const TAG_PREFIX = APP_TAG_PREFIX;

/** The glob an `app-v*` tag matches. No workflow triggers on it. */
export const TAG_GLOB = tagGlob(TAG_PREFIX);

/** The one file `set` writes, relative to the repository root. */
export const VERSION_FILE = 'packages/app/src/lib/version.js';

/** The single line `set` rewrites. Anchored, so a comment cannot be stamped. */
const VERSION_LINE = /^export const APP_VERSION = "[^"\n]*";$/m;

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
 * The annotation carried by the tag `cut` pushes.
 *
 * @param {object} plan
 * @returns {string}
 */
export function tagMessage(plan) {
  return [
    plan.tag,
    '',
    `Web app ${plan.calver} — release ${plan.patch} of ${plan.date} (UTC).`,
    '',
    'Nothing deploys from this tag. Check it out, run `mise run app:set`, and',
    'deploy the Worker to your own account.',
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
    `  N         ${plan.patch}${plan.patch === 0 ? '  (first app release today)' : ''}`,
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
    'About to cut a web app release.',
    '',
    ...formatPlanSummary(plan),
    '',
    `Confirming pushes the tag ${plan.tag}. It starts no workflow and deploys`,
    'nothing: it names this commit as a release of the Worker, and',
    '`mise run app:set` on a checkout of it stamps the version.',
    '',
    'A tag is permanent. Never delete and re-push one — roll forward.',
    '',
    'If somebody else claims this N between now and the push, the tag is',
    'recomputed against the tags that then exist and the claimed tag is printed.',
    '',
  ];
}

/**
 * The version an `app-v*` tag on HEAD names, or `null` if there is none.
 *
 * Two app tags on one commit is legal (a re-cut on the same day), and the later
 * one wins. Later means higher N, compared numerically: `.10` follows `.9`.
 *
 * @param {readonly string[]} tagsAtHead
 * @returns {string | null}
 */
export function versionFromHeadTags(tagsAtHead) {
  const versions = tagsAtHead
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length))
    .filter((version) => VERSION_RE.test(version));

  if (versions.length === 0) return null;

  const parts = (version) => version.split('.').map(Number);
  versions.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return versions.at(-1);
}

/**
 * Rewrite the `APP_VERSION` constant in the version module's source.
 *
 * @param {string} source
 * @param {string} version
 * @returns {string}
 */
export function stampSource(source, version) {
  if (version !== DEV_VERSION && !VERSION_RE.test(version)) {
    throw new Error(
      `${JSON.stringify(version)} is not a CalVer version like 2026.815.0 (or ${DEV_VERSION}).`,
    );
  }
  const matches = source.match(new RegExp(VERSION_LINE.source, 'gm')) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `${VERSION_FILE} must contain exactly one \`export const APP_VERSION = "...";\` line; found ${matches.length}.`,
    );
  }
  return source.replace(VERSION_LINE, `export const APP_VERSION = "${version}";`);
}

// ---------------------------------------------------------------------------
// Effects (all injectable)
// ---------------------------------------------------------------------------

/**
 * git, always captured: a claim attempt that loses a race is expected rather
 * than exceptional, so its progress output must not reach the terminal.
 *
 * @param {string} root
 * @returns {(args: readonly string[]) => string}
 */
function makeGit(root) {
  return (args) => {
    try {
      return execFileSync('git', [...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error('git was not found on PATH.');
      throw error;
    }
  };
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
  log('Next web app release:');
  log('');
  for (const line of formatPlanSummary(plan)) log(line);
  log('');
  log('Cut it:   mise run app:cut');
  return 0;
}

/** @param {object} ctx */
async function cmdCut({ plan, git, log, logErr, prompt, assumeYes, interactive, now, sleep }) {
  for (const line of formatCutSummary(plan)) log(line);

  if (!assumeYes) {
    if (!interactive) {
      logErr('refusing to cut an app release without a confirmation.');
      logErr('Re-run attached to a terminal, or pass --yes for automation:');
      logErr('  mise run app:cut -- --yes');
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
  log(`Pushed ${claimed.plan.tag}. Nothing deploys from it.`);
  log(`Deploy it:  git checkout ${claimed.plan.tag} && mise run app:set`);
  return 0;
}

/** @param {object} ctx */
function cmdSet({ version, git, readFile, writeFile, root, log, logErr }) {
  let target = version;

  if (target === undefined) {
    const raw = git(['tag', '--points-at', 'HEAD', '--list', TAG_GLOB]);
    target = versionFromHeadTags(raw.split('\n').filter(Boolean));
    if (target === null) {
      logErr(`HEAD carries no ${TAG_GLOB} tag, so there is no version to take from it.`);
      logErr('Check out a release (`git checkout app-v<version>`), or name one:');
      logErr('  mise run app:set -- 2026.815.0');
      return 1;
    }
  }

  const file = path.join(root, VERSION_FILE);
  const stamped = stampSource(readFile(file), target);
  writeFile(file, stamped);
  log(`Stamped ${target} into ${VERSION_FILE}.`);
  if (target !== DEV_VERSION) {
    log('This is a working-tree change for the deploy. Do not commit it.');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/app.mjs <command>

  next             print the version the next cut would take. Read-only.
  cut [--yes]      tag and push an ${TAG_GLOB} tag. Deploys nothing.
  set [<version>]  stamp a version into ${VERSION_FILE}.
                   With no version, takes it from the ${TAG_GLOB} tag on HEAD.

options:
  --yes            skip the typed confirmation (cut only, for automation)
  --root <dir>     repository root (default: the parent of scripts/)
`;

/**
 * @param {readonly string[]} argv
 * @param {object} [io] injection points: log, logErr, git, prompt, tags, now,
 *   sleep, interactive, root, readFile, writeFile
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const logErr = io.logErr ?? ((s) => process.stderr.write(`${s}\n`));
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
  const [command, ...rest] = positionals;
  const git = io.git ?? makeGit(root);

  if (values.help || !command) {
    log(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'set') {
    return cmdSet({
      version: rest[0],
      git,
      readFile: io.readFile ?? ((file) => readFileSync(file, 'utf8')),
      writeFile: io.writeFile ?? ((file, contents) => writeFileSync(file, contents, 'utf8')),
      root,
      log,
      logErr,
    });
  }

  const now = io.now ?? new Date();
  const tags = io.tags ?? gitTags(root);
  const plan = planVersion({ tags, now, tagPrefix: TAG_PREFIX });

  switch (command) {
    case 'next':
      return cmdNext({ plan, log });
    case 'cut':
      return cmdCut({
        plan,
        git,
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
