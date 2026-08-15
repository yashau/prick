// scripts/npm-package.test.mjs — node:test + node:assert only.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BIN_BASENAME,
  PARENT_PACKAGE,
  PLATFORMS,
  assertTemplateMatchesPlatforms,
  binaryName,
  candidateBinaryPaths,
  findBinary,
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
  repository: { type: 'git', url: 'git+https://github.com/yashau/prick.git', directory: 'packages/npm/prick' },
  homepage: 'https://github.com/yashau/prick',
  bugs: { url: 'https://github.com/yashau/prick/issues' },
  dependencies: { 'detect-libc': '^2.1.2' },
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [p.name, '0.0.0-dev'])),
};

describe('the platform table', () => {
  test('there are exactly eight platform packages, plus the parent makes nine', () => {
    assert.equal(PLATFORMS.length, 8);
    assert.equal(PLATFORMS.length + 1, 9);
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
    const gnu = platformManifest(PLATFORMS.find((p) => p.name.endsWith('linux-x64-gnu')), VERSION);
    const win = platformManifest(PLATFORMS.find((p) => p.os === 'win32'), VERSION);
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
    const extra = { optionalDependencies: { ...TEMPLATE.optionalDependencies, '@yashau/prick-aix-ppc64': '0' } };
    assert.throws(() => assertTemplateMatchesPlatforms(extra), /disagree about the platform packages/);
    assert.throws(() => assertTemplateMatchesPlatforms({}), /disagree about the platform packages/);
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
    assert.equal(findBinary(mkdtempSync(path.join(os.tmpdir(), 'prick-empty-')), PLATFORMS[0]), null);
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

    const binDir = path.join(root, 'artifacts');
    for (const p of PLATFORMS) {
      mkdirSync(path.join(binDir, p.target), { recursive: true });
      writeFileSync(path.join(binDir, p.target, binaryName(p)), `binary for ${p.target}`);
    }

    return { root, templateDir, binDir, outDir: path.join(root, 'dist', 'npm') };
  }

  test('emits exactly nine package directories', () => {
    const f = fixture();
    try {
      const emitted = renderPackages({ ...f, version: VERSION, allowMissing: false, log: () => {} });
      assert.equal(emitted.length, 9);
      for (const p of PLATFORMS) {
        assert.ok(existsSync(path.join(f.outDir, packageDirName(p.name), 'package.json')));
      }
      assert.ok(existsSync(path.join(f.outDir, 'prick', 'package.json')));
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
        const mode = statSync(path.join(f.outDir, packageDirName(p.name), 'bin', binaryName(p))).mode;
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

  test('--allow-missing skips it and the count no longer reaches nine', () => {
    const f = fixture();
    try {
      rmSync(path.join(f.binDir, PLATFORMS[0].target), { recursive: true, force: true });
      const emitted = renderPackages({ ...f, version: VERSION, allowMissing: true, log: () => {} });
      assert.equal(emitted.length, 8);
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
      const broken = { ...TEMPLATE, optionalDependencies: { '@yashau/prick-darwin-x64': '0.0.0-dev' } };
      writeFileSync(path.join(f.templateDir, 'package.json'), `${JSON.stringify(broken, null, 2)}\n`);
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

describe('the real checked-in template', () => {
  const templateManifest = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'npm',
    'prick',
    'package.json',
  );

  test(
    'agrees with PLATFORMS about which packages exist',
    { skip: !existsSync(templateManifest) && 'packages/npm/prick not created yet' },
    () => {
      const template = JSON.parse(readFileSync(templateManifest, 'utf8'));
      assert.doesNotThrow(() => assertTemplateMatchesPlatforms(template));
      assert.equal(template.name, PARENT_PACKAGE);
    },
  );
});
