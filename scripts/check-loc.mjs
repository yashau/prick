#!/usr/bin/env node
// Fail the build if any source file exceeds MAX_LINES.
//
// The limit is about reviewability, not aesthetics. A file nobody will read end
// to end is a file where a subtle change hides, and in this repo the files that
// grow are exactly the ones where that matters -- the write path, the argument
// escaper, the token store.
//
// There is deliberately NO per-file exemption list. An exemption list is where
// this kind of rule goes to die: the first entry is always justified, and by the
// tenth nobody remembers which ones still are. If a file genuinely cannot be
// split, that is a discussion to have on the pull request, not a line to add to
// a config.
//
// Generated files ARE excluded, because "split this" is not advice you can act
// on when a tool writes the file.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 1000;

export const SOURCE_EXTENSIONS = ['.rs', '.ts', '.tsx', '.svelte', '.mjs', '.cjs', '.js'];

/** Directories never worth walking into. */
export const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.svelte-kit',
  '.wrangler',
  '.astro',
  'coverage',
  'test-results',
  'playwright-report',
]);

/**
 * Paths written by a tool. Excluded because the failure message -- "split this
 * file" -- is not something the author can act on.
 *
 * Kept deliberately short and specific. This is not a general escape hatch: a
 * hand-written file does not belong here no matter how long it is.
 */
export const GENERATED = [
  'packages/app/worker-configuration.d.ts', // wrangler types
  'packages/app/src/lib/components/ui/', // shadcn-svelte registry output
];

/**
 * @param {string} path repo-relative, forward slashes
 * @returns {boolean}
 */
export function isGenerated(path) {
  return GENERATED.some((g) => (g.endsWith('/') ? path.startsWith(g) : path === g));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSource(path) {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Count lines the way a reviewer would: newline-separated, with a trailing
 * newline not counting as an extra empty line.
 *
 * @param {string} contents
 * @returns {number}
 */
export function countLines(contents) {
  if (contents === '') return 0;
  const withoutTrailing = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  return withoutTrailing.split('\n').length;
}

/**
 * @param {string} root
 * @returns {string[]} repo-relative paths, forward slashes
 */
export function collectSourceFiles(root) {
  /** @type {string[]} */
  const found = [];

  /** @param {string} dir */
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = relative(root, full).split(sep).join('/');
      if (!isSource(rel) || isGenerated(rel)) continue;
      found.push(rel);
    }
  }

  walk(root);
  return found.sort();
}

/**
 * @param {string} root
 * @param {number} [max]
 * @returns {{ path: string, lines: number }[]} sorted longest first
 */
export function findViolations(root, max = MAX_LINES) {
  return collectSourceFiles(root)
    .map((path) => ({ path, lines: countLines(readFileSync(join(root, path), 'utf8')) }))
    .filter((f) => f.lines > max)
    .sort((a, b) => b.lines - a.lines);
}

/**
 * @param {{ path: string, lines: number }[]} violations
 * @param {number} max
 * @returns {string[]}
 */
export function formatReport(violations, max = MAX_LINES) {
  if (violations.length === 0) return [`All source files are within ${String(max)} lines.`];

  const lines = [`${String(violations.length)} file(s) exceed the ${String(max)}-line limit:`, ''];
  const width = Math.max(...violations.map((v) => String(v.lines).length));
  for (const v of violations) {
    lines.push(`  ${String(v.lines).padStart(width)}  ${v.path}  (+${String(v.lines - max)})`);
  }
  lines.push('');
  lines.push('Split them. A file nobody reads end to end is where a subtle change hides.');
  lines.push('There is no exemption list by design -- if one genuinely cannot be split,');
  lines.push('raise it on the pull request rather than adding a config entry.');
  return lines;
}

/**
 * @param {readonly string[]} argv
 * @param {object} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const {
    root = fileURLToPath(new URL('..', import.meta.url)),
    log = (line) => process.stdout.write(`${line}\n`),
    logErr = (line) => process.stderr.write(`${line}\n`),
  } = io;

  const maxArg = argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? Number(maxArg.slice('--max='.length)) : MAX_LINES;

  if (!Number.isInteger(max) || max <= 0) {
    logErr(`--max must be a positive integer, got ${String(maxArg)}`);
    return 2;
  }

  const violations = findViolations(root, max);
  const report = formatReport(violations, max);

  if (violations.length === 0) {
    for (const line of report) log(line);
    return 0;
  }

  for (const line of report) logErr(line);
  return 1;
}

if (process.argv[1]?.endsWith('check-loc.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
