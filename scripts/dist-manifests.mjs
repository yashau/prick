#!/usr/bin/env node
// scripts/dist-manifests.mjs — render the package-manager manifests for a release.
//
//   node scripts/dist-manifests.mjs --version <v> --checksums <SHA256SUMS> --out <dir>
//
// Emits into <out>:
//
//   scoop/prk.json            the Scoop manifest, for yashau/scoop-bucket
//   homebrew/prk.rb           the Homebrew formula, for yashau/homebrew-prick
//
// WinGet is deliberately absent. Its three-document manifest carries a schema
// version that microsoft/winget-pkgs bumps on its own cadence, so a hand-rolled
// renderer here would be a copy that goes stale silently; cli-release.yml hands
// that submission to komac, which tracks the schema.
//
// Everything this renders is derived from ONE input: the SHA256SUMS the package
// job already writes and attests. No archive is re-hashed here and none is
// downloaded — a manifest that disagreed with the attested checksum would point
// at bytes nobody signed.
//
// The renderers are pure (values in, string out) and exported for
// scripts/dist-manifests.test.mjs. Only `main` touches the filesystem.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { assertVersion } from './version.mjs';

// ---------------------------------------------------------------------------
// Shared facts about a release
// ---------------------------------------------------------------------------

/** The repository the archives are published from. */
export const DEFAULT_REPO = 'yashau/prick';

/** Homepage for every manifest that asks for one. */
export const HOMEPAGE = 'https://github.com/yashau/prick';

/** SPDX identifier, matching `license` in the workspace manifest. */
export const LICENSE = 'MIT';

// The packaging blurb, which is NOT crates/prk/Cargo.toml's `description` and
// must not be wired to it. Cargo's field is prose for a crates.io page; Scoop
// renders its own in a search list, and `brew audit` rejects a `desc` that opens
// with the formula name or an article. One sentence that satisfies both lives
// here, deliberately.
export const DESCRIPTION =
  'Command-line client for a self-hosted, Cloudflare-backed secrets manager';

/**
 * Every target the build matrix produces, and how each one is named.
 *
 * The archive step stages each build under `prk-<version>-<target>/` before it
 * tars or zips it, so both Scoop's `extract_dir` and Homebrew's staging depend
 * on that directory name. It is version-bearing, which is why it is computed
 * here rather than written down.
 */
export const TARGETS = [
  { target: 'x86_64-unknown-linux-gnu', os: 'linux', arch: 'x64', libc: 'gnu', ext: 'tar.gz' },
  { target: 'x86_64-unknown-linux-musl', os: 'linux', arch: 'x64', libc: 'musl', ext: 'tar.gz' },
  { target: 'aarch64-unknown-linux-gnu', os: 'linux', arch: 'arm64', libc: 'gnu', ext: 'tar.gz' },
  { target: 'aarch64-unknown-linux-musl', os: 'linux', arch: 'arm64', libc: 'musl', ext: 'tar.gz' },
  { target: 'x86_64-apple-darwin', os: 'darwin', arch: 'x64', libc: null, ext: 'tar.gz' },
  { target: 'aarch64-apple-darwin', os: 'darwin', arch: 'arm64', libc: null, ext: 'tar.gz' },
  { target: 'x86_64-pc-windows-msvc', os: 'windows', arch: 'x64', libc: null, ext: 'zip' },
  { target: 'aarch64-pc-windows-msvc', os: 'windows', arch: 'arm64', libc: null, ext: 'zip' },
];

/**
 * @param {string} target
 * @returns {{ target: string, os: string, arch: string, libc: string | null, ext: string }}
 */
export function targetInfo(target) {
  const found = TARGETS.find((t) => t.target === target);
  if (!found) throw new Error(`unknown target ${JSON.stringify(target)}`);
  return found;
}

/**
 * The directory an archive unpacks into.
 *
 * @param {string} version
 * @param {string} target
 */
export function stageDir(version, target) {
  return `prk-${version}-${target}`;
}

/**
 * The archive's file name, as it appears in SHA256SUMS and on the release page.
 *
 * @param {string} version
 * @param {string} target
 */
export function archiveName(version, target) {
  return `${stageDir(version, target)}.${targetInfo(target).ext}`;
}

/**
 * @param {string} version
 * @param {string} target
 * @param {string} [repo]
 */
export function archiveUrl(version, target, repo = DEFAULT_REPO) {
  return `https://github.com/${repo}/releases/download/v${version}/${archiveName(version, target)}`;
}

// ---------------------------------------------------------------------------
// SHA256SUMS
// ---------------------------------------------------------------------------

/**
 * Parse `sha256sum` output into a `{ file -> hash }` map.
 *
 * The format is `<64 hex>` then two spaces, or a space and an asterisk in binary
 * mode, then the name. Anything else is rejected rather than skipped: a line
 * this cannot read is a checksum file this script does not understand, and
 * ignoring it quietly would render a manifest that is missing a platform.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseChecksums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  const lines = String(text).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) {
      throw new Error(
        `SHA256SUMS line ${i + 1} is not a sha256sum record: ${JSON.stringify(line)}`,
      );
    }
    const name = m[2].trim();
    if (sums.has(name)) {
      throw new Error(`SHA256SUMS lists ${name} twice`);
    }
    sums.set(name, m[1]);
  }

  if (sums.size === 0) throw new Error('SHA256SUMS is empty');
  return sums;
}

/**
 * The hash for one target, or a failure naming what was missing.
 *
 * A wrong or absent hash is the one defect a package manager cannot recover
 * from on the user's machine, so this never falls back to a default.
 *
 * @param {Map<string, string>} sums
 * @param {string} version
 * @param {string} target
 */
export function hashFor(sums, version, target) {
  const name = archiveName(version, target);
  const hash = sums.get(name);
  if (!hash) {
    throw new Error(
      `SHA256SUMS has no entry for ${name}. It lists: ${[...sums.keys()].sort().join(', ')}`,
    );
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Scoop
// ---------------------------------------------------------------------------

/** Scoop's architecture keys, by our arch name. */
const SCOOP_ARCH = { x64: '64bit', arm64: 'arm64' };

/**
 * The Scoop manifest, as a plain object.
 *
 * `checkver` reads the RELEASE LIST and matches an asset file name rather than
 * reading `releases/latest`. Two release lines share this repository's releases,
 * so a manifest keyed on "the latest release" resolves to a documentation build
 * whenever `docs-v*` is the newer of the two — and a docs release carries no
 * binaries at all. Only a CLI release has a
 * `prk-<version>-x86_64-pc-windows-msvc.zip`, so keying on that asset cannot
 * match the wrong line.
 *
 * @param {{ version: string, sums: Map<string, string>, repo?: string }} options
 */
export function buildScoopManifest({ version, sums, repo = DEFAULT_REPO }) {
  assertVersion(version);

  /** @type {Record<string, unknown>} */
  const architecture = {};
  /** @type {Record<string, unknown>} */
  const autoupdateArchitecture = {};

  for (const { target, os, arch } of TARGETS) {
    if (os !== 'windows') continue;
    const key = SCOOP_ARCH[arch];
    architecture[key] = {
      url: archiveUrl(version, target, repo),
      hash: hashFor(sums, version, target),
      extract_dir: stageDir(version, target),
    };
    // `$version` is Scoop's own placeholder, substituted by `scoop update`.
    autoupdateArchitecture[key] = {
      url: `https://github.com/${repo}/releases/download/v$version/${stageDir('$version', target)}.zip`,
      extract_dir: stageDir('$version', target),
    };
  }

  if (Object.keys(architecture).length === 0) {
    throw new Error('no Windows targets in TARGETS; the Scoop manifest would install nothing');
  }

  return {
    $schema: 'https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json',
    version,
    description: DESCRIPTION,
    homepage: HOMEPAGE,
    license: LICENSE,
    architecture,
    bin: 'prk.exe',
    checkver: {
      url: `https://api.github.com/repos/${repo}/releases`,
      regex: 'prk-([\\d.]+)-x86_64-pc-windows-msvc\\.zip',
    },
    autoupdate: {
      architecture: autoupdateArchitecture,
      // Scoop reads the checksum file and takes the line naming the archive it
      // just resolved, so one URL covers both architectures.
      hash: { url: `https://github.com/${repo}/releases/download/v$version/SHA256SUMS` },
    },
  };
}

/**
 * @param {{ version: string, sums: Map<string, string>, repo?: string }} options
 */
export function renderScoopManifest(options) {
  // Trailing newline: the bucket repository is edited by humans too, and a file
  // without one shows up as a diff the next time anybody touches it.
  return `${JSON.stringify(buildScoopManifest(options), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

/**
 * The Homebrew formula.
 *
 * Only the gnu Linux builds appear. Homebrew on Linux runs against glibc, and
 * offering two candidates per architecture would make the formula pick one
 * arbitrarily — so the musl archives stay a release-page and container concern.
 *
 * The archives stage under `prk-<version>-<target>/`, and Homebrew chdirs into a
 * single top-level directory when it stages a tarball, so `bin.install "prk"`
 * finds the binary without the formula naming a version-bearing path.
 *
 * @param {{ version: string, sums: Map<string, string>, repo?: string }} options
 */
export function renderHomebrewFormula({ version, sums, repo = DEFAULT_REPO }) {
  assertVersion(version);

  const pick = (os, arch) => {
    const found = TARGETS.find(
      (t) => t.os === os && t.arch === arch && (t.libc === null || t.libc === 'gnu'),
    );
    if (!found) throw new Error(`no ${os}/${arch} target to build a Homebrew formula from`);
    return found.target;
  };

  const block = (os, arch, indent) => {
    const target = pick(os, arch);
    const pad = ' '.repeat(indent);
    return [
      `${pad}url "${archiveUrl(version, target, repo)}"`,
      `${pad}sha256 "${hashFor(sums, version, target)}"`,
    ].join('\n');
  };

  // `#{bin}` below is Ruby interpolation evaluated by Homebrew, not by us; it is
  // escaped here so the template literal leaves it intact.
  return [
    '# typed: false',
    '# frozen_string_literal: true',
    '',
    '# Generated by scripts/dist-manifests.mjs on every CLI release. Do not edit',
    '# by hand: the next release overwrites this file wholesale.',
    'class Prk < Formula',
    `  desc "${DESCRIPTION}"`,
    `  homepage "${HOMEPAGE}"`,
    `  version "${version}"`,
    `  license "${LICENSE}"`,
    '',
    '  on_macos do',
    '    on_arm do',
    block('darwin', 'arm64', 6),
    '    end',
    '    on_intel do',
    block('darwin', 'x64', 6),
    '    end',
    '  end',
    '',
    '  on_linux do',
    '    on_arm do',
    block('linux', 'arm64', 6),
    '    end',
    '    on_intel do',
    block('linux', 'x64', 6),
    '    end',
    '  end',
    '',
    '  def install',
    '    bin.install "prk"',
    '    # Generated from the same clap command tree the binary parses with, so',
    '    # the completions cannot describe a flag this build does not have.',
    '    generate_completions_from_executable(bin/"prk", "completions", shells: [:bash, :zsh, :fish])',
    '  end',
    '',
    '  test do',
    '    assert_match version.to_s, shell_output("#{bin}/prk version")',
    '  end',
    'end',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rendering to disk
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string,
 *   sums: Map<string, string>,
 *   outDir: string,
 *   repo?: string,
 *   log?: (s: string) => void,
 * }} options
 * @returns {string[]} the paths written, relative to outDir
 */
export function renderManifests({ version, sums, outDir, repo = DEFAULT_REPO, log = () => {} }) {
  /** @type {{ rel: string, text: string }[]} */
  const files = [
    { rel: path.join('scoop', 'prk.json'), text: renderScoopManifest({ version, sums, repo }) },
    { rel: path.join('homebrew', 'prk.rb'), text: renderHomebrewFormula({ version, sums, repo }) },
  ];

  for (const file of files) {
    const full = path.join(outDir, file.rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, file.text);
    log(`wrote ${file.rel}`);
  }

  return files.map((f) => f.rel);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/dist-manifests.mjs --version <v> --checksums <path> --out <dir>

  --version    <v>      the released CalVer version, without a leading v
  --checksums  <path>   the SHA256SUMS the package job wrote
  --out        <dir>    directory to render scoop/ and homebrew/ into
  --repo       <o/r>    override the source repository (default ${DEFAULT_REPO})
  -h, --help`;

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, logErr?: (s: string) => void }} [io]
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const logErr = io.logErr ?? ((s) => process.stderr.write(`${s}\n`));

  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      checksums: { type: 'string' },
      out: { type: 'string' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    log(USAGE);
    return 0;
  }

  const missing = ['version', 'checksums', 'out'].filter((k) => !values[k]);
  if (missing.length > 0) {
    logErr(`missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}\n\n${USAGE}`);
    return 1;
  }

  const version = assertVersion(values.version);
  const sums = parseChecksums(readFileSync(path.resolve(values.checksums), 'utf8'));
  const outDir = path.resolve(values.out);

  log(`rendering manifests for ${version} into ${outDir}`);
  const written = renderManifests({
    version,
    sums,
    outDir,
    repo: values.repo ?? DEFAULT_REPO,
    log,
  });
  log(`rendered ${written.length} manifest(s)`);
  return 0;
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
