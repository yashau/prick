#!/usr/bin/env node
// scripts/version.mjs — the single writer of every version string in this repo.
//
// Versioning is CalVer: YYYY.MMDD.N
//
//   major = YYYY
//   minor = MM * 100 + DD     Jan 5 -> 105,  Oct 1 -> 1001,  Dec 31 -> 1231
//   patch = N                 zero-based, = the number of tags already claiming
//                             today's YYYY.MMDD
//
// The arithmetic on `minor` (rather than string concatenation) is what keeps the
// result valid semver: "0105" would be a leading zero and therefore not a semver
// number, while 105 is. It is also strictly monotonic within a year, which
// string forms are not: 105 < 815 < 930 < 1001 < 1231.
//
// UTC is mandatory. A maintainer in UTC+5 running this after 19:00 local would
// otherwise compute tomorrow's date and be a day ahead of CI.
//
// Subcommands:
//   plan  [--github-output]      compute today's version, tag and human CalVer
//   set   <version>              stamp <version> into every manifest that exists
//   check                        assert every manifest carries the same version
//
// Everything above the CLI layer is a pure function so it can be unit-tested
// without a git repository or a filesystem. See scripts/version.test.mjs.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The npm scope for packages this repo publishes. */
export const INTERNAL_SCOPE = '@yashau/';

/** Semver with no leading zeros in any position. */
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The placeholder every in-repo manifest carries; the git tag is the truth. */
export const DEV_VERSION = '0.0.0-dev';

// ---------------------------------------------------------------------------
// Date -> version
// ---------------------------------------------------------------------------

/**
 * Today's date in UTC as `YYYY-MM-DD`.
 *
 * `toISOString()` is always UTC by definition, which is the entire point: no
 * `getFullYear()`, no `toLocaleDateString`, no `TZ` dependency.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function utcDateString(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('utcDateString expects a valid Date');
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Map an ISO `YYYY-MM-DD` date onto the CalVer major/minor pair.
 *
 * @param {string} isoDate
 * @returns {{ major: number, minor: number, month: number, day: number, date: string }}
 */
export function dateToCalver(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) {
    throw new Error(`expected an ISO date YYYY-MM-DD, got ${JSON.stringify(isoDate)}`);
  }
  const major = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new Error(`month out of range in ${isoDate}`);
  if (day < 1 || day > 31) throw new Error(`day out of range in ${isoDate}`);
  return { major, minor: month * 100 + day, month, day, date: m[0] };
}

/**
 * The next zero-based N for `v<major>.<minor>.*`.
 *
 * N is the *count* of tags that already claim today's YYYY.MMDD — no `+1`, so
 * the first release of a day is `.0` and N is self-describing ("this is the
 * Nth release today", counting from zero).
 *
 * Counting is cross-checked against `max(patch) + 1`. The two only disagree
 * when the tag sequence has a hole or a duplicate — a deleted tag, a partial
 * fetch, a hand-made tag. Silently reusing an already-published version is the
 * one failure this script must never produce, so a disagreement is fatal.
 *
 * @param {readonly string[]} tags  every tag known to the repository
 * @param {{ major: number, minor: number }} parts
 * @returns {number}
 */
export function computePatch(tags, { major, minor }) {
  const prefix = `v${major}.${minor}.`;
  const patches = [];
  for (const raw of tags ?? []) {
    const tag = String(raw).trim();
    if (!tag.startsWith(prefix)) continue;
    const rest = tag.slice(prefix.length);
    // Ignore anything that is not a bare non-negative integer, so pre-release
    // or build-metadata tags never influence N.
    if (!/^(0|[1-9]\d*)$/.test(rest)) continue;
    patches.push(Number(rest));
  }

  const next = patches.length;
  const highest = patches.length === 0 ? -1 : Math.max(...patches);

  if (next !== highest + 1) {
    const sorted = [...patches].sort((a, b) => a - b);
    throw new Error(
      `refusing to compute N for ${major}.${minor}: ` +
        `found ${next} tag(s) ${JSON.stringify(sorted)} but the highest is ${highest}, ` +
        `so the next free N is ${highest + 1}, not ${next}. ` +
        'The tag sequence has a hole or a duplicate. ' +
        'Fetch all tags (git fetch --tags --force); if the sequence really is broken, ' +
        'roll forward by tagging the next free N by hand — never delete and re-push a tag.',
    );
  }

  return next;
}

/**
 * @param {{ major: number, minor: number, patch: number }} parts
 * @returns {string} e.g. "2026.815.0"
 */
export function formatVersion({ major, minor, patch }) {
  const version = `${major}.${minor}.${patch}`;
  assertVersion(version);
  return version;
}

/**
 * @param {string} version
 * @returns {string} e.g. "v2026.815.0"
 */
export function formatTag(version) {
  assertVersion(version);
  return `v${version}`;
}

/**
 * The human-readable form: zero-padded date components, for changelogs and
 * release titles. Never written into a manifest — it is not valid semver.
 *
 * @param {{ major: number, month: number, day: number, patch: number }} parts
 * @returns {string} e.g. "2026.08.15.0"
 */
export function formatCalver({ major, month, day, patch }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${major}.${pad(month)}.${pad(day)}.${patch}`;
}

/**
 * @param {string} version
 * @returns {string} the same version, for chaining
 */
export function assertVersion(version) {
  if (!VERSION_RE.test(String(version))) {
    throw new Error(
      `${JSON.stringify(version)} is not a valid CalVer version ` +
        '(expected YYYY.MMDD.N with no leading zeros, e.g. 2026.815.0)',
    );
  }
  return version;
}

/**
 * The whole plan, from a date and the repository's tags.
 *
 * @param {{ tags?: readonly string[], now?: Date, date?: string }} [input]
 */
export function planVersion({ tags = [], now = new Date(), date } = {}) {
  const isoDate = date ?? utcDateString(now);
  const { major, minor, month, day } = dateToCalver(isoDate);
  const patch = computePatch(tags, { major, minor });
  const version = formatVersion({ major, minor, patch });
  return {
    date: isoDate,
    major,
    minor,
    month,
    day,
    patch,
    version,
    tag: formatTag(version),
    calver: formatCalver({ major, month, day, patch }),
  };
}

// ---------------------------------------------------------------------------
// Manifest rewriting — Cargo.toml
// ---------------------------------------------------------------------------

/**
 * Rewrite the workspace version and every `[workspace.dependencies]` path
 * dependency's `version` in a root Cargo.toml.
 *
 * Hand-rolled rather than parse-and-reserialise: there is no TOML parser in the
 * standard library, and a reserialised Cargo.toml would lose comments and key
 * order. The rewrite is line-oriented and section-aware, which is exact enough
 * for the two shapes cargo actually produces.
 *
 * @param {string} text
 * @param {string} version
 * @returns {{ text: string, changes: string[] }}
 */
export function setCargoVersion(text, version) {
  assertVersion(version);

  const lines = String(text).split('\n');
  const changes = [];
  let section = null;
  let subTablePathSeen = false;
  let subTableVersionSeen = false;
  let subTablePathLine = -1;

  const flushSubTable = () => {
    if (
      section?.startsWith('workspace.dependencies.') &&
      subTablePathSeen &&
      !subTableVersionSeen
    ) {
      const name = section.slice('workspace.dependencies.'.length);
      lines.splice(subTablePathLine + 1, 0, `version = "${version}"`);
      changes.push(`[workspace.dependencies.${name}] version (inserted)`);
    }
    subTablePathSeen = false;
    subTableVersionSeen = false;
    subTablePathLine = -1;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      flushSubTable();
      section = header[1].trim();
      continue;
    }

    if (section === 'workspace.package') {
      const m = /^(\s*version\s*=\s*)"[^"]*"(.*)$/.exec(line);
      if (m) {
        lines[i] = `${m[1]}"${version}"${m[2]}`;
        changes.push('[workspace.package] version');
      }
      continue;
    }

    if (section === 'workspace.dependencies') {
      // Inline table:  prick-core = { path = "crates/prick-core", version = "…" }
      const dep = /^(\s*)((?:"[^"]+"|[A-Za-z0-9_.-]+))(\s*=\s*)\{(.*)\}(\s*)$/.exec(line);
      if (!dep) continue;
      let inner = dep[4];
      if (!/(^|[{,\s])path\s*=/.test(inner)) continue; // only path dependencies
      const name = dep[2].replace(/^"|"$/g, '');
      if (/(^|[{,\s])version\s*=\s*"[^"]*"/.test(inner)) {
        inner = inner.replace(/((?:^|[{,\s])version\s*=\s*)"[^"]*"/, `$1"${version}"`);
        changes.push(`[workspace.dependencies] ${name}.version`);
      } else {
        inner = `${inner.replace(/\s+$/, '')}, version = "${version}" `;
        changes.push(`[workspace.dependencies] ${name}.version (inserted)`);
      }
      lines[i] = `${dep[1]}${dep[2]}${dep[3]}{${inner}}${dep[5]}`;
      continue;
    }

    if (section?.startsWith('workspace.dependencies.')) {
      // Sub-table:  [workspace.dependencies.prick-core]
      //             path = "crates/prick-core"
      //             version = "…"
      if (/^\s*path\s*=/.test(line)) {
        subTablePathSeen = true;
        subTablePathLine = i;
        continue;
      }
      const m = /^(\s*version\s*=\s*)"[^"]*"(.*)$/.exec(line);
      if (m) {
        subTableVersionSeen = true;
        lines[i] = `${m[1]}"${version}"${m[2]}`;
        changes.push(
          `[workspace.dependencies.${section.slice('workspace.dependencies.'.length)}] version`,
        );
      }
    }
  }

  flushSubTable();

  return { text: lines.join('\n'), changes };
}

/**
 * Every version string a Cargo.toml is expected to carry, for `check`.
 *
 * @param {string} text
 * @returns {{ label: string, version: string }[]}
 */
export function readCargoVersions(text) {
  const found = [];
  let section = null;

  for (const line of String(text).split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }

    if (section === 'workspace.package') {
      const m = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
      if (m) found.push({ label: '[workspace.package] version', version: m[1] });
      continue;
    }

    if (section === 'workspace.dependencies') {
      const dep = /^\s*((?:"[^"]+"|[A-Za-z0-9_.-]+))\s*=\s*\{(.*)\}\s*$/.exec(line);
      if (!dep) continue;
      const inner = dep[2];
      if (!/(^|[{,\s])path\s*=/.test(inner)) continue;
      const m = /(?:^|[{,\s])version\s*=\s*"([^"]*)"/.exec(inner);
      if (m) {
        found.push({
          label: `[workspace.dependencies] ${dep[1].replace(/^"|"$/g, '')}.version`,
          version: m[1],
        });
      }
      continue;
    }

    if (section?.startsWith('workspace.dependencies.')) {
      const m = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
      if (m) found.push({ label: `[${section}] version`, version: m[1] });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Manifest rewriting — package.json
// ---------------------------------------------------------------------------

/**
 * Detect the indentation and trailing newline of an existing JSON document so a
 * rewrite produces a one-line diff rather than a whole-file reformat.
 *
 * @param {string} text
 */
function jsonStyle(text) {
  const m = /\n([ \t]+)"/.exec(text);
  return { indent: m ? m[1] : '  ', eof: text.endsWith('\n') ? '\n' : '' };
}

/**
 * Set `version`, and pin every internal `optionalDependencies` entry to exactly
 * that version.
 *
 * The pin matters: the parent npm package's optionalDependencies are the
 * per-platform binary packages. A range there would let npm resolve a platform
 * package from a different release than the shim that loads it.
 *
 * Only entries in {@link INTERNAL_SCOPE} are touched, so a third-party optional
 * dependency is never rewritten, and workspace/catalog protocol values on
 * non-internal packages are left exactly as they are.
 *
 * @param {string} text
 * @param {string} version
 * @returns {{ text: string, changes: string[] }}
 */
export function setPackageJsonVersion(text, version) {
  assertVersion(version);

  const { indent, eof } = jsonStyle(text);
  const pkg = JSON.parse(text);
  const changes = [];

  if (pkg.version !== version) changes.push('version');
  pkg.version = version;

  const optional = pkg.optionalDependencies;
  if (optional && typeof optional === 'object') {
    for (const name of Object.keys(optional)) {
      if (!name.startsWith(INTERNAL_SCOPE)) continue;
      if (optional[name] !== version) changes.push(`optionalDependencies["${name}"]`);
      optional[name] = version;
    }
  }

  return { text: JSON.stringify(pkg, null, indent) + eof, changes };
}

/**
 * Every version string a package.json is expected to carry, for `check`.
 *
 * @param {string} text
 * @returns {{ label: string, version: string }[]}
 */
export function readPackageJsonVersions(text) {
  const pkg = JSON.parse(text);
  const found = [];
  if (typeof pkg.version === 'string') found.push({ label: 'version', version: pkg.version });
  const optional = pkg.optionalDependencies;
  if (optional && typeof optional === 'object') {
    for (const [name, range] of Object.entries(optional)) {
      if (!name.startsWith(INTERNAL_SCOPE)) continue;
      found.push({ label: `optionalDependencies["${name}"]`, version: String(range) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Target discovery
// ---------------------------------------------------------------------------

/**
 * Every manifest this script owns, relative to the repo root, in a stable
 * order. Only paths that exist are returned — this repo is built up in stages
 * and `set` must not crash because `e2e/` has not been created yet.
 *
 * @param {string} root
 * @returns {{ path: string, kind: 'cargo' | 'package' }[]}
 */
export function discoverManifests(root) {
  /** @type {{ path: string, kind: 'cargo' | 'package' }[]} */
  const targets = [];
  const add = (rel, kind) => {
    if (existsSync(path.join(root, rel)) && !targets.some((t) => t.path === rel)) {
      targets.push({ path: rel, kind });
    }
  };

  add('Cargo.toml', 'cargo');
  add('package.json', 'package');

  // packages/*/package.json and packages/*/*/package.json (packages/npm/* lives
  // one level deeper than the rest).
  const packagesDir = path.join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      add(`packages/${entry.name}/package.json`, 'package');
      const nested = path.join(packagesDir, entry.name);
      for (const child of readdirSync(nested, { withFileTypes: true })) {
        if (!child.isDirectory() || child.name === 'node_modules') continue;
        add(`packages/${entry.name}/${child.name}/package.json`, 'package');
      }
    }
  }

  add('e2e/package.json', 'package');

  return targets;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * Every tag the repository knows about.
 *
 * A repository with no tags yields `[]`, which is the normal first-release case
 * and must not be an error — `computePatch` turns it into N = 0.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function gitTags(root) {
  let out;
  try {
    out = execFileSync('git', ['tag', '--list'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `could not read git tags in ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return out
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * @param {{ root: string, githubOutput: boolean, log: (s: string) => void }} ctx
 */
function cmdPlan({ root, githubOutput, log }) {
  const plan = planVersion({ tags: gitTags(root), now: new Date() });

  log(`version ${plan.version}`);
  log(`tag     ${plan.tag}`);
  log(`calver  ${plan.calver}`);
  log(`date    ${plan.date} (UTC)`);

  if (githubOutput) {
    const target = process.env.GITHUB_OUTPUT;
    if (!target) throw new Error('--github-output was passed but $GITHUB_OUTPUT is not set');
    appendFileSync(
      target,
      `version=${plan.version}\ntag=${plan.tag}\ncalver=${plan.calver}\n`,
      'utf8',
    );
  }

  return 0;
}

/**
 * @param {{ root: string, version: string, log: (s: string) => void }} ctx
 */
function cmdSet({ root, version, log }) {
  assertVersion(version);

  const targets = discoverManifests(root);
  if (targets.length === 0) {
    log('no manifests found — nothing to stamp');
    return 0;
  }

  let touched = 0;
  for (const target of targets) {
    const abs = path.join(root, target.path);
    const before = readFileSync(abs, 'utf8');
    const { text, changes } =
      target.kind === 'cargo'
        ? setCargoVersion(before, version)
        : setPackageJsonVersion(before, version);

    if (text === before) {
      log(`  ${target.path}: already ${version}`);
      continue;
    }
    writeFileSync(abs, text, 'utf8');
    touched += 1;
    log(`  ${target.path}: ${changes.join(', ')} -> ${version}`);
  }

  log(`stamped ${version} into ${touched} of ${targets.length} manifest(s)`);
  return 0;
}

/**
 * @param {{ root: string, log: (s: string) => void, logErr: (s: string) => void }} ctx
 */
function cmdCheck({ root, log, logErr }) {
  const targets = discoverManifests(root);
  if (targets.length === 0) {
    log('no manifests found — nothing to check');
    return 0;
  }

  /** @type {{ file: string, label: string, version: string }[]} */
  const observed = [];
  for (const target of targets) {
    const text = readFileSync(path.join(root, target.path), 'utf8');
    const versions =
      target.kind === 'cargo' ? readCargoVersions(text) : readPackageJsonVersions(text);
    for (const v of versions) observed.push({ file: target.path, ...v });
  }

  if (observed.length === 0) {
    log('no version strings found — nothing to check');
    return 0;
  }

  const distinct = [...new Set(observed.map((o) => o.version))];
  if (distinct.length === 1) {
    log(`all ${observed.length} version string(s) agree: ${distinct[0]}`);
    return 0;
  }

  logErr(`version drift: ${distinct.length} distinct versions across ${observed.length} strings`);
  for (const o of observed) logErr(`  ${o.version.padEnd(16)} ${o.file} ${o.label}`);
  logErr('Run `mise run version:set <version>` to make them agree.');
  return 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/version.mjs <command>

  plan [--github-output]   compute today's CalVer from the UTC date and the tags
  set <version>            stamp <version> into every manifest that exists
  check                    assert every manifest carries the same version

options:
  --root <dir>             repository root (default: the parent of scripts/)
  --github-output          also append version/tag/calver to $GITHUB_OUTPUT
`;

/**
 * @param {readonly string[]} argv
 * @param {{ log?: (s: string) => void, logErr?: (s: string) => void, root?: string }} [io]
 * @returns {number} process exit code
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const logErr = io.logErr ?? ((s) => process.stderr.write(`${s}\n`));

  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'github-output': { type: 'boolean', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = path.resolve(io.root ?? values.root ?? defaultRoot);
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'plan':
      return cmdPlan({ root, githubOutput: values['github-output'], log });
    case 'set': {
      const version = rest[0];
      if (!version)
        throw new Error('set requires a version, e.g. `mise run version:set 2026.815.0`');
      return cmdSet({ root, version, log });
    }
    case 'check':
      return cmdCheck({ root, log, logErr });
    default:
      logErr(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
