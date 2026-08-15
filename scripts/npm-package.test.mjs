// scripts/npm-package.test.mjs — node:test + node:assert only.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BIN_BASENAME,
  MCP_PACKAGE,
  PACKAGE_COUNT,
  PARENT_PACKAGE,
  PLATFORMS,
  assertPublishableSpecs,
  assertTemplateMatchesPlatforms,
  binaryName,
  candidateBinaryPaths,
  findBinary,
  mcpManifest,
  packageDirName,
  parentManifest,
  platformManifest,
  renderPackages,
} from './npm-package.mjs';

const VERSION = '2026.815.0';

const TEMPLATE = {
  name: PARENT_PACKAGE,
  version: '0.0.0-dev',
  license: 'MIT',
  bin: { prk: 'bin/prk.js' },
  files: ['bin/'],
  repository: {
    type: 'git',
    url: 'git+https://github.com/yashau/prick.git',
    directory: 'packages/npm/prick',
  },
  homepage: 'https://github.com/yashau/prick',
  bugs: { url: 'https://github.com/yashau/prick/issues' },
  dependencies: { 'detect-libc': '^2.1.2' },
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [p.name, '0.0.0-dev'])),
};

/**
 * A stand-in for packages/mcp/package.json, carrying the pnpm-only protocols
 * the real one has in devDependencies. Those are the reason this manifest is
 * rewritten rather than published as-is.
 */
const MCP_TEMPLATE = {
  name: MCP_PACKAGE,
  version: '0.0.0-dev',
  license: 'MIT',
  type: 'module',
  bin: { 'prick-mcp': './dist/main.js' },
  files: ['dist/', 'README.md'],
  scripts: { build: 'tsc -p tsconfig.build.json', test: 'node --test' },
  dependencies: { '@modelcontextprotocol/sdk': '1.30.0', zod: '^4.4.3' },
  devDependencies: {
    '@prick/shared': 'workspace:*',
    '@types/node': '^26.2.0',
    typescript: 'catalog:',
  },
  engines: { node: '>=22' },
};

describe('the platform table', () => {
  test('eight platform packages, plus the MCP server and the parent makes ten', () => {
    assert.equal(PLATFORMS.length, 8);
    assert.equal(PACKAGE_COUNT, 10);
    assert.equal(PLATFORMS.length + 2, PACKAGE_COUNT);
  });

  test('the MCP server is not a platform package', () => {
    // It carries no binary of ours and belongs in no optionalDependencies map;
    // listing it here would put it into the parent's manifest.
    assert.equal(
      PLATFORMS.some((p) => p.name === MCP_PACKAGE),
      false,
    );
    assert.equal(packageDirName(MCP_PACKAGE), 'prick-mcp');
  });

  test('names, targets and directories are all unique', () => {
    for (const key of ['name', 'target']) {
      const values = PLATFORMS.map((p) => p[key]);
      assert.equal(new Set(values).size, 8, `duplicate ${key}`);
    }
    assert.equal(new Set(PLATFORMS.map((p) => packageDirName(p.name))).size, 8);
  });

  test('every os/cpu is a value npm actually understands', () => {
    for (const p of PLATFORMS) {
      assert.ok(['darwin', 'linux', 'win32'].includes(p.os), p.os);
      assert.ok(['x64', 'arm64'].includes(p.cpu), p.cpu);
      if (p.libc) assert.ok(['glibc', 'musl'].includes(p.libc), p.libc);
    }
  });

  test('libc is set for linux and only for linux', () => {
    for (const p of PLATFORMS) {
      assert.equal(Boolean(p.libc), p.os === 'linux', `${p.name} libc`);
    }
  });

  test('Windows packages ship prk.exe, everything else ships prk', () => {
    for (const p of PLATFORMS) {
      assert.equal(binaryName(p), p.os === 'win32' ? 'prk.exe' : 'prk');
    }
  });

  test('the directory name is the unscoped tail', () => {
    assert.equal(packageDirName('@yashau/prick'), 'prick');
    assert.equal(packageDirName('@yashau/prick-win32-x64-msvc'), 'prick-win32-x64-msvc');
  });
});

describe('platform manifests', () => {
  test('carry os, cpu and a bin entry pointing at the copied binary', () => {
    for (const p of PLATFORMS) {
      const m = platformManifest(p, VERSION, TEMPLATE);
      assert.equal(m.name, p.name);
      assert.equal(m.version, VERSION);
      assert.deepEqual(m.os, [p.os]);
      assert.deepEqual(m.cpu, [p.cpu]);
      assert.deepEqual(m.bin, { [BIN_BASENAME]: `bin/${binaryName(p)}` });
      assert.deepEqual(m.files, ['bin/']);
      assert.equal(m.publishConfig.access, 'public');
    }
  });

  test('carry libc only on linux', () => {
    const gnu = platformManifest(
      PLATFORMS.find((p) => p.name.endsWith('linux-x64-gnu')),
      VERSION,
    );
    const win = platformManifest(
      PLATFORMS.find((p) => p.os === 'win32'),
      VERSION,
    );
    assert.deepEqual(gnu.libc, ['glibc']);
    assert.equal('libc' in win, false);
  });

  test('never carry a scripts key', () => {
    for (const p of PLATFORMS) {
      assert.equal('scripts' in platformManifest(p, VERSION, TEMPLATE), false);
    }
  });

  test('drop the template repository.directory, which points at the parent', () => {
    const m = platformManifest(PLATFORMS[0], VERSION, TEMPLATE);
    assert.equal(m.repository.url, TEMPLATE.repository.url);
    assert.equal(m.repository.directory, undefined);
  });

  test('reject a version that is not CalVer', () => {
    assert.throws(() => platformManifest(PLATFORMS[0], '1.0'), /not a valid CalVer/);
  });
});

describe('the parent manifest', () => {
  test('pins all eight platform packages to the exact version, no range', () => {
    const m = parentManifest(TEMPLATE, VERSION);
    assert.equal(Object.keys(m.optionalDependencies).length, 8);
    for (const [name, range] of Object.entries(m.optionalDependencies)) {
      assert.equal(range, VERSION, `${name} must be pinned exactly`);
      assert.doesNotMatch(range, /[\^~><*x]|\s-\s/, `${name} must not be a range`);
    }
  });

  test('has no scripts key at all — nothing may run at install time', () => {
    const m = parentManifest({ ...TEMPLATE, scripts: { postinstall: 'node install.js' } }, VERSION);
    assert.equal('scripts' in m, false);
  });

  test('keeps the shim bin entry and the detect-libc dependency', () => {
    const m = parentManifest(TEMPLATE, VERSION);
    assert.deepEqual(m.bin, { prk: 'bin/prk.js' });
    assert.deepEqual(m.dependencies, { 'detect-libc': '^2.1.2' });
  });

  test('does not mutate the template it was given', () => {
    const before = JSON.stringify(TEMPLATE);
    parentManifest(TEMPLATE, VERSION);
    assert.equal(JSON.stringify(TEMPLATE), before);
  });

  test('assertTemplateMatchesPlatforms catches drift in either direction', () => {
    assert.doesNotThrow(() => assertTemplateMatchesPlatforms(TEMPLATE));
    const extra = {
      optionalDependencies: { ...TEMPLATE.optionalDependencies, '@yashau/prick-aix-ppc64': '0' },
    };
    assert.throws(
      () => assertTemplateMatchesPlatforms(extra),
      /disagree about the platform packages/,
    );
    assert.throws(() => assertTemplateMatchesPlatforms({}), /disagree about the platform packages/);
  });
});

describe('the MCP manifest', () => {
  test('is stamped with the release version like every other manifest', () => {
    assert.equal(mcpManifest(MCP_TEMPLATE, VERSION).version, VERSION);
    assert.throws(() => mcpManifest(MCP_TEMPLATE, '1.0'), /not a valid CalVer/);
  });

  test('drops devDependencies entirely — pnpm protocols npm would publish verbatim', () => {
    const m = mcpManifest(MCP_TEMPLATE, VERSION);
    assert.equal('devDependencies' in m, false);
    const rendered = JSON.stringify(m);
    assert.doesNotMatch(rendered, /workspace:/);
    assert.doesNotMatch(rendered, /catalog:/);
  });

  test('keeps the runtime dependencies, which are what actually get installed', () => {
    const m = mcpManifest(MCP_TEMPLATE, VERSION);
    assert.deepEqual(m.dependencies, MCP_TEMPLATE.dependencies);
    assert.deepEqual(m.bin, MCP_TEMPLATE.bin);
    assert.deepEqual(m.files, MCP_TEMPLATE.files);
    assert.equal(m.type, 'module');
  });

  test('drops scripts, which all refer to files the package does not ship', () => {
    assert.equal('scripts' in mcpManifest(MCP_TEMPLATE, VERSION), false);
  });

  test('does not mutate the template it was given', () => {
    const before = JSON.stringify(MCP_TEMPLATE);
    mcpManifest(MCP_TEMPLATE, VERSION);
    assert.equal(JSON.stringify(MCP_TEMPLATE), before);
  });

  test('a pnpm protocol among the RUNTIME dependencies is fatal, not stripped', () => {
    // Deleting it would silently ship a package that cannot start. There is no
    // safe rewrite, so this has to stop the release.
    const broken = {
      ...MCP_TEMPLATE,
      dependencies: { ...MCP_TEMPLATE.dependencies, '@prick/shared': 'workspace:*' },
    };
    assert.throws(() => mcpManifest(broken, VERSION), /npm cannot resolve/);
  });
});

describe('the publishable-spec guard', () => {
  test('accepts real ranges and exact pins', () => {
    assert.doesNotThrow(() =>
      assertPublishableSpecs({
        dependencies: { zod: '^4.4.3', a: '1.2.3', b: 'npm:c@^1', d: 'https://example.com/d.tgz' },
      }),
    );
  });

  test('rejects every pnpm-only protocol, in any dependency field', () => {
    for (const [field, spec] of [
      ['dependencies', 'workspace:*'],
      ['optionalDependencies', 'catalog:'],
      ['peerDependencies', 'link:../x'],
      ['dependencies', 'portal:../x'],
    ]) {
      assert.throws(
        () => assertPublishableSpecs({ name: '@yashau/x', [field]: { thing: spec } }),
        /npm cannot resolve/,
        `${field}: ${spec} was accepted`,
      );
    }
  });

  test('names the package and the offending entry, so the fix is obvious', () => {
    assert.throws(
      () => assertPublishableSpecs({ dependencies: { '@prick/shared': 'workspace:*' } }, '@x/y'),
      (error) => {
        assert.match(error.message, /@x\/y/);
        assert.match(error.message, /@prick\/shared/);
        assert.match(error.message, /workspace:\*/);
        return true;
      },
    );
  });
});

describe('binary lookup', () => {
  test('the primary layout is <bin-dir>/<target>/<binary>', () => {
    const p = PLATFORMS[0];
    assert.equal(candidateBinaryPaths('/b', p)[0], path.join('/b', p.target, binaryName(p)));
  });

  test('finds a binary in each supported layout', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'prick-npm-'));
    try {
      const linux = PLATFORMS.find((p) => p.name.endsWith('linux-x64-gnu'));
      const win = PLATFORMS.find((p) => p.name.endsWith('win32-x64-msvc'));

      mkdirSync(path.join(root, linux.target), { recursive: true });
      writeFileSync(path.join(root, linux.target, 'prk'), 'elf');
      assert.equal(findBinary(root, linux), path.join(root, linux.target, 'prk'));

      mkdirSync(path.join(root, packageDirName(win.name), 'bin'), { recursive: true });
      writeFileSync(path.join(root, packageDirName(win.name), 'bin', 'prk.exe'), 'pe');
      assert.equal(
        findBinary(root, win),
        path.join(root, packageDirName(win.name), 'bin', 'prk.exe'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null when nothing matches', () => {
    assert.equal(
      findBinary(mkdtempSync(path.join(os.tmpdir(), 'prick-empty-')), PLATFORMS[0]),
      null,
    );
  });
});

describe('rendering the full set', () => {
  function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'prick-render-'));
    const templateDir = path.join(root, 'packages', 'npm', 'prick');
    mkdirSync(path.join(templateDir, 'bin'), { recursive: true });
    writeFileSync(path.join(templateDir, 'package.json'), `${JSON.stringify(TEMPLATE, null, 2)}\n`);
    writeFileSync(path.join(templateDir, 'bin', 'prk.js'), '#!/usr/bin/env node\n// shim\n');
    writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');

    // The MCP package, as it looks after `mise run build:mcp`.
    const mcpDir = path.join(root, 'packages', 'mcp');
    mkdirSync(path.join(mcpDir, 'dist'), { recursive: true });
    writeFileSync(path.join(mcpDir, 'package.json'), `${JSON.stringify(MCP_TEMPLATE, null, 2)}\n`);
    writeFileSync(path.join(mcpDir, 'dist', 'main.js'), '#!/usr/bin/env node\n// server\n');
    writeFileSync(path.join(mcpDir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(path.join(mcpDir, 'README.md'), '# mcp\n');

    const binDir = path.join(root, 'artifacts');
    for (const p of PLATFORMS) {
      mkdirSync(path.join(binDir, p.target), { recursive: true });
      writeFileSync(path.join(binDir, p.target, binaryName(p)), `binary for ${p.target}`);
    }

    return { root, templateDir, mcpDir, binDir, outDir: path.join(root, 'dist', 'npm') };
  }

  test('emits exactly ten package directories', () => {
    const f = fixture();
    try {
      const emitted = renderPackages({
        ...f,
        version: VERSION,
        allowMissing: false,
        log: () => {},
      });
      assert.equal(emitted.length, PACKAGE_COUNT);
      for (const p of PLATFORMS) {
        assert.ok(existsSync(path.join(f.outDir, packageDirName(p.name), 'package.json')));
      }
      assert.ok(existsSync(path.join(f.outDir, 'prick-mcp', 'package.json')));
      assert.ok(existsSync(path.join(f.outDir, 'prick', 'package.json')));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the parent never lists the MCP server as an optional dependency', () => {
    const f = fixture();
    try {
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      const parent = JSON.parse(readFileSync(path.join(f.outDir, 'prick', 'package.json'), 'utf8'));
      assert.equal(MCP_PACKAGE in parent.optionalDependencies, false);
      assert.equal(Object.keys(parent.optionalDependencies).length, 8);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the MCP package ships its built dist and a publishable manifest', () => {
    const f = fixture();
    try {
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      const dir = path.join(f.outDir, 'prick-mcp');

      assert.equal(
        readFileSync(path.join(dir, 'dist', 'main.js'), 'utf8'),
        '#!/usr/bin/env node\n// server\n',
      );
      assert.ok(existsSync(path.join(dir, 'dist', 'index.js')));
      assert.ok(existsSync(path.join(dir, 'README.md')));
      assert.ok(existsSync(path.join(dir, 'LICENSE')), 'the licence must travel with the package');

      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, MCP_PACKAGE);
      assert.equal(manifest.version, VERSION);
      assert.equal('devDependencies' in manifest, false);
      assert.doesNotMatch(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
        /workspace:|catalog:/,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the parent is rendered last, so it is the last thing published', () => {
    const f = fixture();
    try {
      const emitted = renderPackages({
        ...f,
        version: VERSION,
        allowMissing: false,
        log: () => {},
      });
      assert.equal(emitted.at(-1).name, PARENT_PACKAGE);
      assert.equal(emitted.at(-2).name, MCP_PACKAGE);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('an unbuilt MCP package is fatal by default and skipped under --allow-missing', () => {
    const f = fixture();
    try {
      rmSync(path.join(f.mcpDir, 'dist'), { recursive: true, force: true });
      assert.throws(
        () => renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} }),
        /has not been built/,
      );
      const emitted = renderPackages({ ...f, version: VERSION, allowMissing: true, log: () => {} });
      assert.equal(emitted.length, PACKAGE_COUNT - 1);
      assert.equal(existsSync(path.join(f.outDir, 'prick-mcp')), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('copies the binary and reuses the template shim rather than regenerating it', () => {
    const f = fixture();
    try {
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });

      const win = PLATFORMS.find((p) => p.os === 'win32');
      const winBin = path.join(f.outDir, packageDirName(win.name), 'bin', 'prk.exe');
      assert.equal(readFileSync(winBin, 'utf8'), `binary for ${win.target}`);

      const shim = readFileSync(path.join(f.outDir, 'prick', 'bin', 'prk.js'), 'utf8');
      assert.equal(shim, readFileSync(path.join(f.templateDir, 'bin', 'prk.js'), 'utf8'));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('sets the executable bit on unix binaries', { skip: process.platform === 'win32' }, () => {
    const f = fixture();
    try {
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      for (const p of PLATFORMS.filter((x) => x.os !== 'win32')) {
        const mode = statSync(
          path.join(f.outDir, packageDirName(p.name), 'bin', binaryName(p)),
        ).mode;
        assert.equal(mode & 0o111, 0o111, `${p.name} is not executable`);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the emitted parent is the source of truth for names and versions', () => {
    const f = fixture();
    try {
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      const parent = JSON.parse(readFileSync(path.join(f.outDir, 'prick', 'package.json'), 'utf8'));

      assert.equal(parent.name, PARENT_PACKAGE);
      assert.equal(parent.version, VERSION);
      assert.equal('scripts' in parent, false);

      for (const [name, range] of Object.entries(parent.optionalDependencies)) {
        assert.equal(range, VERSION);
        const emitted = JSON.parse(
          readFileSync(path.join(f.outDir, packageDirName(name), 'package.json'), 'utf8'),
        );
        assert.equal(emitted.name, name);
        assert.equal(emitted.version, VERSION);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a missing binary is fatal by default', () => {
    const f = fixture();
    try {
      rmSync(path.join(f.binDir, PLATFORMS[0].target), { recursive: true, force: true });
      assert.throws(
        () => renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} }),
        (error) => {
          assert.match(error.message, /no binary found for @yashau\/prick-darwin-arm64/);
          assert.match(error.message, /tried:/);
          return true;
        },
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('--allow-missing skips it and the count no longer reaches ten', () => {
    const f = fixture();
    try {
      rmSync(path.join(f.binDir, PLATFORMS[0].target), { recursive: true, force: true });
      const emitted = renderPackages({ ...f, version: VERSION, allowMissing: true, log: () => {} });
      assert.equal(emitted.length, PACKAGE_COUNT - 1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the output directory is recreated, never merged into', () => {
    const f = fixture();
    try {
      mkdirSync(f.outDir, { recursive: true });
      writeFileSync(path.join(f.outDir, 'stale.txt'), 'from a previous run');
      renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      assert.equal(existsSync(path.join(f.outDir, 'stale.txt')), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a template that disagrees with PLATFORMS is rejected before anything is written', () => {
    const f = fixture();
    try {
      const broken = {
        ...TEMPLATE,
        optionalDependencies: { '@yashau/prick-darwin-x64': '0.0.0-dev' },
      };
      writeFileSync(
        path.join(f.templateDir, 'package.json'),
        `${JSON.stringify(broken, null, 2)}\n`,
      );
      assert.throws(
        () => renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} }),
        /disagree about the platform packages/,
      );
      assert.equal(existsSync(f.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe('the real checked-in manifests', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templateManifest = path.join(repoRoot, 'packages', 'npm', 'prick', 'package.json');
  const mcpManifestPath = path.join(repoRoot, 'packages', 'mcp', 'package.json');

  test(
    'the parent template agrees with PLATFORMS about which packages exist',
    { skip: !existsSync(templateManifest) && 'packages/npm/prick not created yet' },
    () => {
      const template = JSON.parse(readFileSync(templateManifest, 'utf8'));
      assert.doesNotThrow(() => assertTemplateMatchesPlatforms(template));
      assert.equal(template.name, PARENT_PACKAGE);
    },
  );

  test(
    'the MCP manifest renders into something npm can actually resolve',
    { skip: !existsSync(mcpManifestPath) && 'packages/mcp not created yet' },
    () => {
      const template = JSON.parse(readFileSync(mcpManifestPath, 'utf8'));
      assert.equal(template.name, MCP_PACKAGE);

      // The check that matters: the checked-in manifest carries pnpm-only
      // protocols in devDependencies, and the rendered one carries none
      // anywhere. If the real manifest ever stops using them this assertion
      // becomes a false alarm — but then the stripping is no longer load
      // bearing either, and that is worth knowing.
      const devSpecs = Object.values(template.devDependencies ?? {});
      assert.ok(
        devSpecs.some((spec) => /^(workspace|catalog):/.test(spec)),
        'expected the workspace manifest to use a pnpm-only protocol',
      );

      const rendered = mcpManifest(template, VERSION);
      assert.doesNotThrow(() => assertPublishableSpecs(rendered));
      assert.doesNotMatch(JSON.stringify(rendered), /workspace:|catalog:/);
      assert.equal(rendered.version, VERSION);
    },
  );
});
