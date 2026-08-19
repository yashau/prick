import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_REPO,
  DESCRIPTION,
  TARGETS,
  archiveName,
  archiveUrl,
  buildScoopManifest,
  hashFor,
  main,
  parseChecksums,
  renderHomebrewFormula,
  renderManifests,
  renderScoopManifest,
  stageDir,
  targetInfo,
} from './dist-manifests.mjs';

const VERSION = '2026.819.0';

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'prick-dist-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A SHA256SUMS covering every target, with a distinct but deterministic hash
 * per file so a manifest that pairs the wrong hash with the wrong archive is
 * visible rather than merely "some 64 hex characters".
 *
 * @param {string} [version]
 */
function checksumsText(version = VERSION) {
  return `${TARGETS.map((t) => {
    const name = archiveName(version, t.target);
    return `${createHash('sha256').update(name).digest('hex')}  ${name}`;
  }).join('\n')}\n`;
}

/** @param {string} name */
const expectedHash = (name) => createHash('sha256').update(name).digest('hex');

/** @param {string} [version] */
const sumsFor = (version = VERSION) => parseChecksums(checksumsText(version));

describe('the target table', () => {
  it('matches the build matrix in cli-release.yml', () => {
    // If a target is added to or removed from the workflow's matrix without
    // being reflected here, the manifests silently stop covering a platform.
    const workflow = readFileSync(
      new URL('../.github/workflows/cli-release.yml', import.meta.url),
      'utf8',
    );
    for (const { target } of TARGETS) {
      assert.ok(workflow.includes(target), `${target} is not built by cli-release.yml`);
    }
  });

  it('names every target exactly once', () => {
    const names = TARGETS.map((t) => t.target);
    assert.equal(new Set(names).size, names.length);
  });

  it('archives Windows as zip and everything else as tar.gz', () => {
    for (const t of TARGETS) {
      assert.equal(t.ext, t.os === 'windows' ? 'zip' : 'tar.gz', t.target);
    }
  });

  it('refuses a target it does not know', () => {
    assert.throws(() => targetInfo('powerpc-unknown-linux-gnu'), /unknown target/);
  });
});

describe('archive naming', () => {
  it('matches what the package job stages and archives', () => {
    // The workflow builds `prk-${VERSION}-${target}` as a directory and then
    // archives that directory by name. Both halves must agree.
    assert.equal(stageDir(VERSION, 'x86_64-apple-darwin'), 'prk-2026.819.0-x86_64-apple-darwin');
    assert.equal(
      archiveName(VERSION, 'x86_64-apple-darwin'),
      'prk-2026.819.0-x86_64-apple-darwin.tar.gz',
    );
    assert.equal(
      archiveName(VERSION, 'aarch64-pc-windows-msvc'),
      'prk-2026.819.0-aarch64-pc-windows-msvc.zip',
    );
  });

  it('builds a download URL against the v-prefixed tag', () => {
    assert.equal(
      archiveUrl(VERSION, 'x86_64-unknown-linux-gnu'),
      'https://github.com/yashau/prick/releases/download/v2026.819.0/prk-2026.819.0-x86_64-unknown-linux-gnu.tar.gz',
    );
  });

  it('honours a repository override', () => {
    assert.match(
      archiveUrl(VERSION, 'x86_64-apple-darwin', 'fork/prick'),
      /github\.com\/fork\/prick\//,
    );
  });
});

describe('parsing SHA256SUMS', () => {
  it('reads the two-space form sha256sum writes', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  prk-1.0.0-x.tar.gz\n`);
    assert.equal(sums.get('prk-1.0.0-x.tar.gz'), 'a'.repeat(64));
  });

  it('reads the binary-mode asterisk form', () => {
    const sums = parseChecksums(`${'b'.repeat(64)} *prk-1.0.0-x.zip\n`);
    assert.equal(sums.get('prk-1.0.0-x.zip'), 'b'.repeat(64));
  });

  it('ignores blank lines', () => {
    assert.equal(parseChecksums(`\n${'c'.repeat(64)}  a\n\n`).size, 1);
  });

  it('rejects a line it cannot read rather than skipping it', () => {
    // Skipping would render a manifest missing a platform, which is worse than
    // failing the release.
    assert.throws(() => parseChecksums('not a checksum line\n'), /not a sha256sum record/);
  });

  it('rejects a truncated hash', () => {
    assert.throws(() => parseChecksums(`${'d'.repeat(63)}  a\n`), /not a sha256sum record/);
  });

  it('rejects uppercase hex, which sha256sum never emits', () => {
    assert.throws(() => parseChecksums(`${'A'.repeat(64)}  a\n`), /not a sha256sum record/);
  });

  it('rejects a duplicate file name', () => {
    assert.throws(
      () => parseChecksums(`${'e'.repeat(64)}  a\n${'f'.repeat(64)}  a\n`),
      /lists a twice/,
    );
  });

  it('rejects an empty file', () => {
    assert.throws(() => parseChecksums('\n\n'), /empty/);
  });
});

describe('looking a hash up', () => {
  it('finds the entry for a target', () => {
    const name = archiveName(VERSION, 'aarch64-apple-darwin');
    assert.equal(hashFor(sumsFor(), VERSION, 'aarch64-apple-darwin'), expectedHash(name));
  });

  it('fails loudly, naming what it did find, when a target is missing', () => {
    const sums = parseChecksums(
      `${'a'.repeat(64)}  ${archiveName(VERSION, 'x86_64-apple-darwin')}\n`,
    );
    assert.throws(
      () => hashFor(sums, VERSION, 'aarch64-apple-darwin'),
      /no entry for prk-2026\.819\.0-aarch64-apple-darwin\.tar\.gz.*It lists:/s,
    );
  });

  it('fails when the checksums are for a different version', () => {
    assert.throws(() => hashFor(sumsFor('2026.101.0'), VERSION, 'x86_64-apple-darwin'), /no entry/);
  });
});

describe('the Scoop manifest', () => {
  const manifest = () => buildScoopManifest({ version: VERSION, sums: sumsFor() });

  it('covers both Windows architectures and nothing else', () => {
    assert.deepEqual(Object.keys(manifest().architecture).sort(), ['64bit', 'arm64']);
  });

  it('pairs each architecture with its own archive and hash', () => {
    const m = manifest();
    const x64 = archiveName(VERSION, 'x86_64-pc-windows-msvc');
    const arm = archiveName(VERSION, 'aarch64-pc-windows-msvc');

    assert.ok(m.architecture['64bit'].url.endsWith(x64));
    assert.equal(m.architecture['64bit'].hash, expectedHash(x64));
    assert.ok(m.architecture.arm64.url.endsWith(arm));
    assert.equal(m.architecture.arm64.hash, expectedHash(arm));

    // The one mistake that installs the wrong binary silently.
    assert.notEqual(m.architecture['64bit'].hash, m.architecture.arm64.hash);
  });

  it('extracts from the directory the archive actually contains', () => {
    const m = manifest();
    assert.equal(m.architecture['64bit'].extract_dir, stageDir(VERSION, 'x86_64-pc-windows-msvc'));
    assert.equal(m.architecture.arm64.extract_dir, stageDir(VERSION, 'aarch64-pc-windows-msvc'));
  });

  it('exposes the binary under its real name', () => {
    assert.equal(manifest().bin, 'prk.exe');
  });

  it('checks for new versions by asset name, not by "latest release"', () => {
    // Two release lines share this repository's releases. A `docs-v*` release
    // can be the newest one, and it ships no binaries — so checkver must key on
    // something only a CLI release has.
    const { checkver } = manifest();
    assert.equal(checkver.url, `https://api.github.com/repos/${DEFAULT_REPO}/releases`);
    assert.doesNotMatch(checkver.url, /releases\/latest/);

    const re = new RegExp(checkver.regex);
    assert.deepEqual(re.exec('prk-2026.820.1-x86_64-pc-windows-msvc.zip')?.[1], '2026.820.1');
    assert.equal(re.test('docs-v2026.820.0'), false);
    assert.equal(re.test('prk-2026.820.1-aarch64-apple-darwin.tar.gz'), false);
  });

  it('autoupdates through Scoop placeholders, not a frozen version', () => {
    const { autoupdate } = manifest();
    for (const arch of ['64bit', 'arm64']) {
      assert.match(autoupdate.architecture[arch].url, /\$version/);
      assert.match(autoupdate.architecture[arch].extract_dir, /\$version/);
      assert.doesNotMatch(
        autoupdate.architecture[arch].url,
        new RegExp(VERSION.replace(/\./g, '\\.')),
      );
    }
    assert.match(autoupdate.hash.url, /SHA256SUMS$/);
  });

  it('renders as JSON with a trailing newline', () => {
    const text = renderScoopManifest({ version: VERSION, sums: sumsFor() });
    assert.ok(text.endsWith('}\n'));
    assert.equal(JSON.parse(text).version, VERSION);
  });

  it('refuses a version that is not CalVer', () => {
    assert.throws(() => buildScoopManifest({ version: '1.2', sums: sumsFor() }), /CalVer/);
  });
});

describe('the Homebrew formula', () => {
  const formula = () => renderHomebrewFormula({ version: VERSION, sums: sumsFor() });

  it('declares the class Homebrew derives from the file name', () => {
    assert.match(formula(), /^class Prk < Formula$/m);
  });

  it('carries the version and the licence', () => {
    assert.match(formula(), new RegExp(`^  version "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
    assert.match(formula(), /^  license "MIT"$/m);
  });

  it('opens its description with neither the formula name nor an article', () => {
    // `brew audit --strict` rejects both.
    assert.doesNotMatch(DESCRIPTION, /^(prk|an?|the)\b/i);
  });

  it('covers all four supported platform slots', () => {
    const text = formula();
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
    ]) {
      assert.ok(text.includes(archiveName(VERSION, target)), target);
      assert.ok(text.includes(expectedHash(archiveName(VERSION, target))), `${target} hash`);
    }
  });

  it('ships the gnu Linux builds, never the musl ones', () => {
    // Homebrew on Linux runs against glibc; two candidates per architecture
    // would make the formula pick one arbitrarily.
    assert.doesNotMatch(formula(), /musl/);
  });

  it('never references a Windows archive', () => {
    assert.doesNotMatch(formula(), /windows|\.zip/);
  });

  it('installs the binary and generates completions', () => {
    const text = formula();
    assert.match(text, /^ {4}bin\.install "prk"$/m);
    assert.match(text, /generate_completions_from_executable\(bin\/"prk", "completions"/);
  });

  it('leaves Ruby interpolation for Homebrew to evaluate', () => {
    // `#{bin}` must survive into the formula; a template that ate it would
    // produce a test block that shells out to a bare `/prk`.
    assert.match(formula(), /shell_output\("#\{bin\}\/prk version"\)/);
  });

  it('ends with a newline', () => {
    assert.ok(formula().endsWith('end\n'));
  });

  it('refuses a version that is not CalVer', () => {
    assert.throws(() => renderHomebrewFormula({ version: 'dev', sums: sumsFor() }), /CalVer/);
  });
});

describe('rendering to disk', () => {
  it('writes both manifests under their package-manager directories', () => {
    const out = join(root, 'out');
    const written = renderManifests({ version: VERSION, sums: sumsFor(), outDir: out });

    assert.deepEqual(written.map((p) => p.replace(/\\/g, '/')).sort(), [
      'homebrew/prk.rb',
      'scoop/prk.json',
    ]);
    assert.equal(JSON.parse(readFileSync(join(out, 'scoop', 'prk.json'), 'utf8')).version, VERSION);
    assert.match(readFileSync(join(out, 'homebrew', 'prk.rb'), 'utf8'), /class Prk < Formula/);
  });
});

describe('the command line', () => {
  /** @returns {{ code: number, out: string, err: string }} */
  function run(argv) {
    let out = '';
    let err = '';
    const code = main(argv, {
      log: (s) => {
        out += `${s}\n`;
      },
      logErr: (s) => {
        err += `${s}\n`;
      },
    });
    return { code, out, err };
  }

  it('renders from a checksums file on disk', () => {
    const sumsPath = join(root, 'SHA256SUMS');
    writeFileSync(sumsPath, checksumsText());
    const out = join(root, 'cli-out');

    const result = run(['--version', VERSION, '--checksums', sumsPath, '--out', out]);
    assert.equal(result.code, 0);
    assert.match(result.out, /rendered 2 manifest\(s\)/);
    assert.match(readFileSync(join(out, 'homebrew', 'prk.rb'), 'utf8'), /class Prk/);
  });

  it('names every missing option at once', () => {
    const result = run(['--version', VERSION]);
    assert.equal(result.code, 1);
    assert.match(result.err, /--checksums/);
    assert.match(result.err, /--out/);
  });

  it('prints usage for --help without writing anything', () => {
    const result = run(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.out, /usage: node scripts\/dist-manifests\.mjs/);
  });

  it('rejects a version the release could never have produced', () => {
    const sumsPath = join(root, 'SHA256SUMS');
    writeFileSync(sumsPath, checksumsText());
    assert.throws(
      () => run(['--version', '0.0.0-dev', '--checksums', sumsPath, '--out', join(root, 'x')]),
      /CalVer/,
    );
  });
});
