#!/usr/bin/env node
// scripts/npm-package.mjs — render the ten publishable npm packages.
//
//   node scripts/npm-package.mjs --version <v> --bin-dir <dir> --out <dir>
//
// Emits into <out>:
//
//   prick/                    the parent, @yashau/prick — the Node shim only
//   prick-darwin-arm64/       …
//   prick-darwin-x64/         eight per-platform packages, each one binary
//   prick-linux-arm64-gnu/
//   prick-linux-arm64-musl/
//   prick-linux-x64-gnu/
//   prick-linux-x64-musl/
//   prick-win32-arm64-msvc/
//   prick-win32-x64-msvc/
//   prick-mcp/                the MCP server, @yashau/prick-mcp
//
// The MCP server is NOT a platform package and deliberately does not appear in
// the parent's `optionalDependencies`: it is an independent Node program with
// its own runtime dependencies, and nobody installing the CLI should be made to
// download an MCP server. It rides the same release only because its version is
// stamped from the same tag.
//
// Three invariants this script exists to hold:
//
//   1. The parent has NO `scripts` key. Nothing runs, and nothing downloads, at
//      install time. `npm install --ignore-scripts` — the flag a careful user of
//      a secrets manager actually passes — must behave like a normal install.
//   2. The parent's optionalDependencies are pinned to the EXACT version, never
//      a range. A range would let npm pair a shim from one release with a
//      binary from another.
//   3. No rendered manifest carries a dependency spec npm cannot resolve. The
//      workspace manifests use pnpm-only protocols (`workspace:`, `catalog:`)
//      and we publish with `npm`, which uploads them verbatim rather than
//      rewriting them the way `pnpm publish` would.
//
// The parent is rendered from the checked-in template at packages/npm/prick and
// the MCP package from packages/mcp, so neither the launcher shim nor the MCP
// manifest has a second copy here to drift from.
//
// The pure parts (the platform table, the manifest builders, binary lookup) are
// exported for scripts/npm-package.test.mjs.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { assertVersion } from './version.mjs';

/** The parent package. Its directory name in --out is the unscoped tail. */
export const PARENT_PACKAGE = '@yashau/prick';

/**
 * The MCP server package.
 *
 * Published by the same pipeline, but structurally unrelated to the CLI: it has
 * no platform variants, no binary of ours inside it, and no entry in the
 * parent's optionalDependencies.
 */
export const MCP_PACKAGE = '@yashau/prick-mcp';

/** The unscoped binary name. */
export const BIN_BASENAME = 'prk';

/**
 * Dependency-spec prefixes pnpm understands and npm does not.
 *
 * `pnpm publish` rewrites these into real ranges on the way out; `npm publish`
 * does not. The release publishes with npm, for the OIDC trusted-publishing
 * path, so any of these surviving into a rendered manifest would be uploaded
 * verbatim and be unresolvable for everyone downstream.
 */
export const PNPM_ONLY_PROTOCOLS = ['workspace:', 'catalog:', 'catalogs:', 'link:', 'portal:'];

/**
 * Every platform package, in the order they appear in the parent's manifest.
 *
 * `target` is the Rust target triple the binary is built for; it is also the
 * primary directory name this script looks for under --bin-dir.
 *
 * `libc` is emitted even though npm's support for the field is only partial —
 * pnpm honours it, and the launcher shim calls detect-libc itself to cover the
 * npm case. Emitting it costs nothing and helps the resolver that does read it.
 */
export const PLATFORMS = [
  {
    name: '@yashau/prick-darwin-arm64',
    target: 'aarch64-apple-darwin',
    os: 'darwin',
    cpu: 'arm64',
  },
  { name: '@yashau/prick-darwin-x64', target: 'x86_64-apple-darwin', os: 'darwin', cpu: 'x64' },
  {
    name: '@yashau/prick-linux-arm64-gnu',
    target: 'aarch64-unknown-linux-gnu',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
  },
  {
    name: '@yashau/prick-linux-arm64-musl',
    target: 'aarch64-unknown-linux-musl',
    os: 'linux',
    cpu: 'arm64',
    libc: 'musl',
  },
  {
    name: '@yashau/prick-linux-x64-gnu',
    target: 'x86_64-unknown-linux-gnu',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
  },
  {
    name: '@yashau/prick-linux-x64-musl',
    target: 'x86_64-unknown-linux-musl',
    os: 'linux',
    cpu: 'x64',
    libc: 'musl',
  },
  {
    name: '@yashau/prick-win32-arm64-msvc',
    target: 'aarch64-pc-windows-msvc',
    os: 'win32',
    cpu: 'arm64',
  },
  {
    name: '@yashau/prick-win32-x64-msvc',
    target: 'x86_64-pc-windows-msvc',
    os: 'win32',
    cpu: 'x64',
  },
];

/**
 * How many package directories a complete render emits: the eight platform
 * packages, the MCP server, and the parent.
 */
export const PACKAGE_COUNT = PLATFORMS.length + 2;

/**
 * @param {{ os: string }} platform
 * @returns {string} `prk.exe` on Windows, `prk` everywhere else
 */
export function binaryName(platform) {
  return platform.os === 'win32' ? `${BIN_BASENAME}.exe` : BIN_BASENAME;
}

/**
 * The unscoped directory name a package is rendered into.
 *
 * @param {string} packageName
 * @returns {string}
 */
export function packageDirName(packageName) {
  return packageName.replace(/^@[^/]+\//, '');
}

/**
 * Where a built binary might be found under --bin-dir, most specific first.
 *
 * The release matrix uploads one artefact per target and the download layout
 * has changed shape more than once across GitHub Actions versions, so the
 * lookup is tolerant and the error names every path it tried.
 *
 * @param {string} binDir
 * @param {{ target: string, name: string, os: string }} platform
 * @returns {string[]}
 */
export function candidateBinaryPaths(binDir, platform) {
  const bin = binaryName(platform);
  const dir = packageDirName(platform.name);
  return [
    path.join(binDir, platform.target, bin),
    path.join(binDir, platform.target, 'bin', bin),
    path.join(binDir, platform.target, 'release', bin),
    path.join(binDir, platform.target, 'dist', bin),
    path.join(binDir, dir, bin),
    path.join(binDir, dir, 'bin', bin),
    path.join(binDir, `${BIN_BASENAME}-${platform.target}${platform.os === 'win32' ? '.exe' : ''}`),
    path.join(binDir, platform.target, `${BIN_BASENAME}-${platform.target}`),
  ];
}

/**
 * @param {string} binDir
 * @param {{ target: string, name: string, os: string }} platform
 * @returns {string|null}
 */
export function findBinary(binDir, platform) {
  for (const candidate of candidateBinaryPaths(binDir, platform)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The package.json for one platform package.
 *
 * `bin` is declared here as well as on the parent. That is deliberate: a direct
 * `npm i -g @yashau/prick-linux-x64-gnu` then gets the native binary on PATH
 * with no Node process in front of it, which matters for `prk run`, where a live
 * Node parent would defeat the exec() the binary performs.
 *
 * @param {typeof PLATFORMS[number]} platform
 * @param {string} version
 * @param {object} [inherit] fields copied from the parent template
 * @returns {object}
 */
export function platformManifest(platform, version, inherit = {}) {
  assertVersion(version);
  const bin = binaryName(platform);

  /** @type {Record<string, unknown>} */
  const manifest = {
    name: platform.name,
    version,
    description: `Prebuilt ${BIN_BASENAME} binary for ${platform.os} ${platform.cpu}${
      platform.libc ? ` (${platform.libc})` : ''
    }.`,
    license: inherit.license ?? 'MIT',
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    bin: { [BIN_BASENAME]: `bin/${bin}` },
    files: ['bin/'],
    ...(inherit.repository ? { repository: { ...inherit.repository, directory: undefined } } : {}),
    ...(inherit.homepage ? { homepage: inherit.homepage } : {}),
    ...(inherit.bugs ? { bugs: inherit.bugs } : {}),
    publishConfig: { access: 'public' },
  };

  if (manifest.repository) delete manifest.repository.directory;
  return manifest;
}

/**
 * Invariant 3: reject a manifest carrying a spec npm cannot resolve.
 *
 * This is a publish-time check rather than a lint, because the workspace
 * manifests are *supposed* to use `workspace:` and `catalog:` — the mistake
 * would be letting one reach the registry.
 *
 * @param {object} manifest
 * @param {string} [label] the package name, for the message
 */
export function assertPublishableSpecs(manifest, label = manifest?.name ?? '(unnamed)') {
  const offending = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
      if (typeof spec !== 'string') continue;
      if (PNPM_ONLY_PROTOCOLS.some((protocol) => spec.startsWith(protocol))) {
        offending.push(`  ${field}["${name}"]: ${JSON.stringify(spec)}`);
      }
    }
  }

  if (offending.length > 0) {
    throw new Error(
      `${label} would be published with dependency specs npm cannot resolve:\n` +
        `${offending.join('\n')}\n` +
        'These are pnpm-only protocols. `npm publish` uploads them verbatim. ' +
        'Move the dependency to devDependencies (which are stripped here) or ' +
        'give it a real version range.',
    );
  }
}

/**
 * The parent package.json, rendered from the checked-in template.
 *
 * @param {object} template  the parsed packages/npm/prick/package.json
 * @param {string} version
 * @returns {object}
 */
export function parentManifest(template, version) {
  assertVersion(version);

  const manifest = structuredClone(template);
  manifest.version = version;

  // Rebuilt from PLATFORMS rather than edited in place, so the published set
  // can never drift from what this script actually emits. The MCP package is
  // deliberately absent: it is not a platform of the CLI.
  manifest.optionalDependencies = Object.fromEntries(PLATFORMS.map((p) => [p.name, version]));

  // Invariant 1. Delete rather than empty: an empty object still shows up in
  // `npm view` as a scripts field and invites someone to add one.
  delete manifest.scripts;

  assertPublishableSpecs(manifest, PARENT_PACKAGE);
  return manifest;
}

/**
 * The MCP server's package.json, rendered from packages/mcp/package.json.
 *
 * `devDependencies` are deleted rather than rewritten. They are never installed
 * downstream, so nothing is lost — and the workspace manifest carries
 * `@prick/shared: workspace:*` and `typescript: catalog:` there, which npm
 * would publish verbatim (invariant 3). A published manifest whose specs cannot
 * resolve is a trap for anybody who reads it, even when nothing installs them.
 *
 * `scripts` go for the same reason one level up: every one of them
 * (`tsc -p tsconfig.build.json`, the test runner) refers to files the package
 * does not ship, so they can only fail for a consumer who tries one.
 *
 * @param {object} template  the parsed packages/mcp/package.json
 * @param {string} version
 * @returns {object}
 */
export function mcpManifest(template, version) {
  assertVersion(version);

  const manifest = structuredClone(template);
  manifest.version = version;

  delete manifest.devDependencies;
  delete manifest.scripts;

  assertPublishableSpecs(manifest, MCP_PACKAGE);
  return manifest;
}

/**
 * Fail loudly if the checked-in template and this script disagree about which
 * platform packages exist. Catches the case where someone adds a target to one
 * and not the other.
 *
 * @param {object} template
 */
export function assertTemplateMatchesPlatforms(template) {
  const declared = Object.keys(template.optionalDependencies ?? {}).sort();
  const expected = PLATFORMS.map((p) => p.name).sort();
  if (declared.join('\n') !== expected.join('\n')) {
    throw new Error(
      'the parent template and PLATFORMS disagree about the platform packages.\n' +
        `  template:  ${declared.join(', ') || '(none)'}\n` +
        `  this file: ${expected.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const JSON_INDENT = 2;

/** @param {string} file @param {object} value */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, JSON_INDENT)}\n`, 'utf8');
}

/**
 * @param {{
 *   version: string,
 *   binDir: string,
 *   outDir: string,
 *   templateDir: string,
 *   root: string,
 *   mcpDir?: string,
 *   allowMissing: boolean,
 *   log: (s: string) => void,
 * }} options
 */
export function renderPackages({
  version,
  binDir,
  outDir,
  templateDir,
  root,
  mcpDir,
  allowMissing,
  log,
}) {
  assertVersion(version);

  const templateManifestPath = path.join(templateDir, 'package.json');
  if (!existsSync(templateManifestPath)) {
    throw new Error(`parent template not found at ${templateManifestPath}`);
  }
  const template = JSON.parse(readFileSync(templateManifestPath, 'utf8'));
  assertTemplateMatchesPlatforms(template);

  const mcpSource = mcpDir ?? path.join(root, 'packages', 'mcp');
  const mcpManifestPath = path.join(mcpSource, 'package.json');
  if (!existsSync(mcpManifestPath)) {
    throw new Error(`MCP package manifest not found at ${mcpManifestPath}`);
  }
  const mcpTemplate = JSON.parse(readFileSync(mcpManifestPath, 'utf8'));
  if (mcpTemplate.name !== MCP_PACKAGE) {
    throw new Error(
      `${mcpManifestPath} declares ${JSON.stringify(mcpTemplate.name)}, expected ${MCP_PACKAGE}`,
    );
  }

  if (!existsSync(binDir)) throw new Error(`--bin-dir does not exist: ${binDir}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const licenseSource = path.join(root, 'LICENSE');
  const emitted = [];

  // --- the eight platform packages -----------------------------------------
  for (const platform of PLATFORMS) {
    const dir = path.join(outDir, packageDirName(platform.name));
    const source = findBinary(binDir, platform);

    if (source === null) {
      const tried = candidateBinaryPaths(binDir, platform)
        .map((p) => `    ${p}`)
        .join('\n');
      const message = `no binary found for ${platform.name} (${platform.target}); tried:\n${tried}`;
      if (!allowMissing) throw new Error(message);
      log(`SKIP  ${platform.name} — ${message.split('\n')[0]}`);
      continue;
    }

    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const bin = binaryName(platform);
    const destination = path.join(dir, 'bin', bin);
    copyFileSync(source, destination);

    // npm packs the mode it finds on disk. A binary without the executable bit
    // installs as a non-executable file and every invocation fails with EACCES.
    if (platform.os !== 'win32') chmodSync(destination, 0o755);

    writeJson(path.join(dir, 'package.json'), platformManifest(platform, version, template));
    if (existsSync(licenseSource)) copyFileSync(licenseSource, path.join(dir, 'LICENSE'));
    writeFileSync(
      path.join(dir, 'README.md'),
      `# ${platform.name}\n\n` +
        `The prebuilt \`${BIN_BASENAME}\` binary for ${platform.os} ${platform.cpu}` +
        `${platform.libc ? ` (${platform.libc})` : ''}, built for \`${platform.target}\`.\n\n` +
        `This package is installed automatically as an optional dependency of ` +
        `[\`${PARENT_PACKAGE}\`](https://www.npmjs.com/package/${PARENT_PACKAGE}). ` +
        `Install that instead.\n`,
      'utf8',
    );

    emitted.push({ name: platform.name, dir, from: source });
    log(`  ${platform.name.padEnd(34)} <- ${path.relative(binDir, source)}`);
  }

  // --- the MCP server ------------------------------------------------------
  //
  // Rendered before the parent so that `emitted` is in publish order: the
  // parent's dist-tag flip is what makes a release live, and it goes last.
  const mcpDist = path.join(mcpSource, 'dist');
  if (!existsSync(mcpDist)) {
    const message =
      `${MCP_PACKAGE} has not been built: ${mcpDist} does not exist. ` +
      'Run `mise run build:mcp` first.';
    if (!allowMissing) throw new Error(message);
    log(`SKIP  ${MCP_PACKAGE} — not built`);
  } else {
    const mcpOut = path.join(outDir, packageDirName(MCP_PACKAGE));
    mkdirSync(mcpOut, { recursive: true });
    cpSync(mcpDist, path.join(mcpOut, 'dist'), { recursive: true });

    // tsc writes its output 0644, and the manifest's `bin` points into dist/.
    // npm does set the mode when it links a bin, but a package whose entry
    // point is not executable in the tarball is one `node_modules/.bin`
    // implementation away from failing, and the fix costs one call.
    const mcpBin = typeof mcpTemplate.bin === 'object' ? Object.values(mcpTemplate.bin) : [];
    for (const relative of mcpBin) {
      const target = path.join(mcpOut, relative);
      if (existsSync(target)) chmodSync(target, 0o755);
    }

    writeJson(path.join(mcpOut, 'package.json'), mcpManifest(mcpTemplate, version));

    for (const extra of ['README.md', 'LICENSE']) {
      const fromPackage = path.join(mcpSource, extra);
      const fromRoot = path.join(root, extra);
      const source = existsSync(fromPackage)
        ? fromPackage
        : existsSync(fromRoot)
          ? fromRoot
          : null;
      if (source) copyFileSync(source, path.join(mcpOut, extra));
    }

    emitted.push({ name: MCP_PACKAGE, dir: mcpOut, from: mcpSource });
    log(`  ${MCP_PACKAGE.padEnd(34)} <- ${path.relative(root, mcpSource)}`);
  }

  // --- the parent ----------------------------------------------------------
  const parentDir = path.join(outDir, packageDirName(PARENT_PACKAGE));
  mkdirSync(parentDir, { recursive: true });

  // Reuse the checked-in shim rather than regenerating it.
  cpSync(path.join(templateDir, 'bin'), path.join(parentDir, 'bin'), { recursive: true });

  writeJson(path.join(parentDir, 'package.json'), parentManifest(template, version));

  for (const extra of ['README.md', 'LICENSE']) {
    const fromTemplate = path.join(templateDir, extra);
    const fromRoot = path.join(root, extra);
    const source = existsSync(fromTemplate) ? fromTemplate : existsSync(fromRoot) ? fromRoot : null;
    if (source) copyFileSync(source, path.join(parentDir, extra));
  }

  emitted.push({ name: PARENT_PACKAGE, dir: parentDir, from: templateDir });
  log(`  ${PARENT_PACKAGE.padEnd(34)} <- ${path.relative(root, templateDir)}`);

  return emitted;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/npm-package.mjs --version <v> --bin-dir <dir> --out <dir>

  --version <v>     the CalVer version to stamp into all ten manifests
  --bin-dir <dir>   directory holding the built binaries, one per target triple
  --out <dir>       directory to render the ten packages into (recreated)

  --template <dir>  parent template (default: packages/npm/prick)
  --mcp <dir>       MCP server package, already built (default: packages/mcp)
  --root <dir>      repository root (default: the parent of scripts/)
  --allow-missing   skip platforms with no binary, and the MCP server if it has
                    not been built, instead of failing.
                    For local dry runs only — never in a release.
`;

/**
 * @param {readonly string[]} argv
 * @param {{ log?: (s: string) => void, logErr?: (s: string) => void }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const logErr = io.logErr ?? ((s) => process.stderr.write(`${s}\n`));

  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: 'string' },
      'bin-dir': { type: 'string' },
      out: { type: 'string' },
      template: { type: 'string' },
      mcp: { type: 'string' },
      root: { type: 'string' },
      'allow-missing': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    log(USAGE);
    return 0;
  }

  const missing = ['version', 'bin-dir', 'out'].filter((k) => !values[k]);
  if (missing.length > 0) {
    logErr(`missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}\n\n${USAGE}`);
    return 1;
  }

  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = path.resolve(values.root ?? defaultRoot);
  const outDir = path.resolve(values.out);

  log(`rendering ${PACKAGE_COUNT} packages at ${values.version} into ${outDir}`);

  const emitted = renderPackages({
    version: values.version,
    binDir: path.resolve(values['bin-dir']),
    outDir,
    templateDir: path.resolve(values.template ?? path.join(root, 'packages', 'npm', 'prick')),
    root,
    mcpDir: path.resolve(values.mcp ?? path.join(root, 'packages', 'mcp')),
    allowMissing: values['allow-missing'],
    log,
  });

  log(`rendered ${emitted.length} package(s)`);

  const expected = PACKAGE_COUNT;
  if (emitted.length !== expected) {
    // Only reachable under --allow-missing; without it a missing binary already
    // threw. A release must never publish a short set, so this is still an error
    // unless the caller opted in to the incomplete run.
    const message = `expected ${expected} packages, rendered ${emitted.length}`;
    if (!values['allow-missing']) {
      logErr(message);
      return 1;
    }
    logErr(`${message} (--allow-missing: do not publish this)`);
  }
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
