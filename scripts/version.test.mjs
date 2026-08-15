// scripts/version.test.mjs — node:test + node:assert only, no dependencies.
//
// Run with `mise run test:scripts`, or directly: `node --test scripts/`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  DEV_VERSION,
  VERSION_RE,
  assertVersion,
  computePatch,
  dateToCalver,
  discoverManifests,
  formatCalver,
  formatTag,
  formatVersion,
  main,
  planVersion,
  readCargoVersions,
  readPackageJsonVersions,
  setCargoVersion,
  setPackageJsonVersion,
  utcDateString,
} from './version.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

/** @param {string} date @param {readonly string[]} [tags] */
const planOn = (date, tags = []) => planVersion({ date, tags });

// ---------------------------------------------------------------------------

describe('date -> CalVer', () => {
  test('Jan 5 has no leading zero: 2026.105.0', () => {
    assert.equal(planOn('2026-01-05').version, '2026.105.0');
    assert.equal(planOn('2026-01-05').minor, 105);
  });

  test('Oct 1 is 1001, not 101', () => {
    assert.equal(planOn('2026-10-01').version, '2026.1001.0');
    assert.equal(planOn('2026-10-01').minor, 1001);
  });

  test('Dec 31 is 1231', () => {
    assert.equal(planOn('2026-12-31').version, '2026.1231.0');
  });

  test('Aug 15 is 815 — the worked example from the plan', () => {
    const plan = planOn('2026-08-15');
    assert.equal(plan.version, '2026.815.0');
    assert.equal(plan.tag, 'v2026.815.0');
    assert.equal(plan.calver, '2026.08.15.0');
  });

  test('the human CalVer zero-pads while the semver minor does not', () => {
    assert.equal(planOn('2026-01-05').calver, '2026.01.05.0');
    assert.equal(planOn('2026-01-05').version, '2026.105.0');
  });

  test('the tag is the version with a leading v', () => {
    assert.equal(formatTag('2026.1001.3'), 'v2026.1001.3');
  });

  test('rejects anything that is not an ISO date', () => {
    for (const bad of ['2026-8-15', '15-08-2026', '2026/08/15', '', 'today', null]) {
      assert.throws(() => dateToCalver(bad), /ISO date/);
    }
    assert.throws(() => dateToCalver('2026-13-01'), /month out of range/);
    assert.throws(() => dateToCalver('2026-01-32'), /day out of range/);
  });
});

// ---------------------------------------------------------------------------

describe('ordering and semver validity', () => {
  test('minor is strictly monotonic through the year: 105 < 815 < 930 < 1001 < 1231', () => {
    const minors = ['2026-01-05', '2026-08-15', '2026-09-30', '2026-10-01', '2026-12-31'].map(
      (d) => planOn(d).minor,
    );
    assert.deepEqual(minors, [105, 815, 930, 1001, 1231]);
    for (let i = 1; i < minors.length; i += 1) {
      assert.ok(minors[i - 1] < minors[i], `${minors[i - 1]} should sort before ${minors[i]}`);
    }
  });

  test('every day of a leap year yields valid semver with no leading zeros', () => {
    let previous = -1;
    let days = 0;
    for (let month = 1; month <= 12; month += 1) {
      const lastDay = new Date(Date.UTC(2028, month, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day += 1) {
        const version = planOn(`2028-${pad2(month)}-${pad2(day)}`).version;
        assert.match(version, VERSION_RE, `${version} is not leading-zero-free semver`);
        const minor = Number(version.split('.')[1]);
        assert.ok(minor > previous, `${minor} must sort after ${previous}`);
        previous = minor;
        days += 1;
      }
    }
    assert.equal(days, 366, '2028 is a leap year');
  });

  test('assertVersion rejects leading zeros and non-CalVer shapes', () => {
    for (const bad of ['2026.0815.0', '2026.815.00', '02026.815.0', '2026.815', 'v2026.815.0']) {
      assert.throws(() => assertVersion(bad), /not a valid CalVer version/);
    }
    assert.equal(assertVersion('2026.815.0'), '2026.815.0');
  });

  test('the in-repo placeholder is deliberately not a CalVer version', () => {
    assert.doesNotMatch(DEV_VERSION, VERSION_RE);
  });
});

// ---------------------------------------------------------------------------

describe('N is zero-based and counted from the tags', () => {
  test('no tags today means N = 0', () => {
    assert.equal(planOn('2026-08-15', []).patch, 0);
  });

  test('N increments with each tag claiming the same day', () => {
    const tags = [];
    for (let expected = 0; expected < 5; expected += 1) {
      const plan = planOn('2026-08-15', tags);
      assert.equal(plan.patch, expected);
      assert.equal(plan.version, `2026.815.${expected}`);
      tags.push(plan.tag);
    }
  });

  test('tags from other days do not count', () => {
    const tags = ['v2026.814.0', 'v2026.814.1', 'v2025.815.0', 'v2026.816.0', 'v2026.815.0'];
    assert.equal(planOn('2026-08-15', tags).patch, 1);
  });

  test('non-numeric and pre-release suffixes are ignored', () => {
    const tags = ['v2026.815.0', 'v2026.815.1-rc.1', 'v2026.815.x', 'nightly', 'v2026.815.01'];
    assert.equal(planOn('2026-08-15', tags).patch, 1);
  });

  test('a hole in the sequence is fatal, not silently reused', () => {
    // count = 2 but max + 1 = 3: taking N = 2 would republish an existing version.
    assert.throws(
      () => planOn('2026-08-15', ['v2026.815.0', 'v2026.815.2']),
      (error) => {
        assert.match(error.message, /refusing to compute N for 2026\.815/);
        assert.match(error.message, /the next free N is 3, not 2/);
        assert.match(error.message, /never delete and re-push a tag/);
        return true;
      },
    );
  });

  test('a duplicate tag is fatal for the same reason', () => {
    assert.throws(
      () => computePatch(['v2026.815.0', 'v2026.815.0'], { major: 2026, minor: 815 }),
      /refusing to compute N/,
    );
  });

  test('whitespace around tags is tolerated', () => {
    assert.equal(
      computePatch(['  v2026.815.0  ', '\tv2026.815.1'], { major: 2026, minor: 815 }),
      2,
    );
  });
});

// ---------------------------------------------------------------------------

describe('UTC is mandatory', () => {
  test('utcDateString is the UTC calendar date, never the local one', () => {
    // 20:30 UTC on Aug 15 is already 01:30 on Aug 16 in Male (UTC+5).
    const instant = new Date('2026-08-15T20:30:00Z');

    const asUtcPlus5 = new Date(instant.getTime() + 5 * 60 * 60 * 1000);
    const whatTheLocalClockSays = `${asUtcPlus5.getUTCFullYear()}-${pad2(
      asUtcPlus5.getUTCMonth() + 1,
    )}-${pad2(asUtcPlus5.getUTCDate())}`;

    assert.equal(whatTheLocalClockSays, '2026-08-16', 'precondition: the local date differs');
    assert.equal(utcDateString(instant), '2026-08-15');
    assert.equal(planVersion({ now: instant, tags: [] }).version, '2026.815.0');
  });

  test('a UTC+5 rollover does not drag the version backwards either', () => {
    // 00:30 UTC on Aug 16 is still 19:30 on Aug 15 in New York (UTC-5).
    const instant = new Date('2026-08-16T00:30:00Z');

    const asUtcMinus5 = new Date(instant.getTime() - 5 * 60 * 60 * 1000);
    const whatTheLocalClockSays = `${asUtcMinus5.getUTCFullYear()}-${pad2(
      asUtcMinus5.getUTCMonth() + 1,
    )}-${pad2(asUtcMinus5.getUTCDate())}`;

    assert.equal(whatTheLocalClockSays, '2026-08-15', 'precondition: the local date differs');
    assert.equal(utcDateString(instant), '2026-08-16');
    assert.equal(planVersion({ now: instant, tags: [] }).version, '2026.816.0');
  });

  test('year rollover at midnight UTC on New Year', () => {
    assert.equal(
      planVersion({ now: new Date('2027-01-01T00:00:00Z'), tags: [] }).version,
      '2027.101.0',
    );
    assert.equal(
      planVersion({ now: new Date('2026-12-31T23:59:59Z'), tags: [] }).version,
      '2026.1231.0',
    );
  });

  test('utcDateString rejects an invalid Date rather than emitting garbage', () => {
    assert.throws(() => utcDateString(new Date('not a date')), TypeError);
    assert.throws(() => utcDateString('2026-08-15'), TypeError);
  });
});

// ---------------------------------------------------------------------------

describe('formatting helpers', () => {
  test('formatVersion refuses to build an invalid version', () => {
    assert.equal(formatVersion({ major: 2026, minor: 815, patch: 0 }), '2026.815.0');
    assert.throws(() => formatVersion({ major: 2026, minor: '0815', patch: 0 }), /not a valid/);
  });

  test('formatCalver zero-pads month and day', () => {
    assert.equal(formatCalver({ major: 2026, month: 1, day: 5, patch: 12 }), '2026.01.05.12');
  });
});

// ---------------------------------------------------------------------------

describe('Cargo.toml rewriting', () => {
  const CARGO = `[workspace]
members = ["crates/*", "xtask"]
resolver = "3"

[workspace.package]
version = "0.0.0-dev"
edition = "2024"
license = "MIT"

[workspace.dependencies]
prick-core = { path = "crates/prick-core", version = "0.0.0-dev" }
prick-api = { path = "crates/prick-api" }
clap = { version = "4.5", features = ["derive"] }
serde = "1"

[workspace.dependencies.prick-auth]
path = "crates/prick-auth"
version = "0.0.0-dev"

[workspace.dependencies.prick-exec]
path = "crates/prick-exec"

[profile.dist]
inherits = "release"
`;

  test('rewrites the workspace version', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    assert.match(text, /\[workspace\.package\]\nversion = "2026\.815\.0"/);
  });

  test('rewrites an existing version on an inline path dependency', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    assert.match(text, /prick-core = \{ path = "crates\/prick-core", version = "2026\.815\.0" \}/);
  });

  test('inserts a version into an inline path dependency that lacks one', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    assert.match(text, /prick-api = \{ path = "crates\/prick-api", version = "2026\.815\.0" \}/);
  });

  test('handles the sub-table form, rewriting and inserting', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    assert.match(
      text,
      /\[workspace\.dependencies\.prick-auth\]\npath = "crates\/prick-auth"\nversion = "2026\.815\.0"/,
    );
    assert.match(
      text,
      /\[workspace\.dependencies\.prick-exec\]\npath = "crates\/prick-exec"\nversion = "2026\.815\.0"/,
    );
  });

  test('never touches a registry dependency', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    assert.match(text, /clap = \{ version = "4\.5", features = \["derive"\] \}/);
    assert.match(text, /serde = "1"/);
  });

  test('is idempotent', () => {
    const once = setCargoVersion(CARGO, '2026.815.0').text;
    const twice = setCargoVersion(once, '2026.815.0').text;
    assert.equal(twice, once);
    assert.deepEqual(setCargoVersion(once, '2026.815.0').changes.length > 0, true);
  });

  test('reports every location it changed', () => {
    const { changes } = setCargoVersion(CARGO, '2026.815.0');
    assert.deepEqual(changes, [
      '[workspace.package] version',
      '[workspace.dependencies] prick-core.version',
      '[workspace.dependencies] prick-api.version (inserted)',
      '[workspace.dependencies.prick-auth] version',
      '[workspace.dependencies.prick-exec] version (inserted)',
    ]);
  });

  test('readCargoVersions finds every version it wrote', () => {
    const { text } = setCargoVersion(CARGO, '2026.815.0');
    const found = readCargoVersions(text);
    assert.equal(found.length, 5);
    assert.deepEqual([...new Set(found.map((f) => f.version))], ['2026.815.0']);
  });

  test('readCargoVersions surfaces drift', () => {
    const drifted = CARGO.replace(
      'prick-core", version = "0.0.0-dev"',
      'prick-core", version = "9.9.9"',
    );
    const versions = readCargoVersions(drifted).map((f) => f.version);
    assert.ok(versions.includes('9.9.9'));
    assert.ok(versions.includes('0.0.0-dev'));
  });

  test('refuses an invalid version before touching anything', () => {
    assert.throws(() => setCargoVersion(CARGO, '2026.0815.0'), /not a valid CalVer/);
  });
});

// ---------------------------------------------------------------------------

describe('package.json rewriting', () => {
  const PARENT =
    JSON.stringify(
      {
        name: '@yashau/prick',
        version: '0.0.0-dev',
        optionalDependencies: {
          '@yashau/prick-linux-x64-gnu': '0.0.0-dev',
          '@yashau/prick-darwin-arm64': '^0.0.1',
          '@yashau/prick-win32-x64-msvc': '0.0.0-dev',
          'detect-libc': '^2.0.3',
        },
        dependencies: { '@yashau/prick-shared': 'workspace:*' },
      },
      null,
      2,
    ) + '\n';

  test('sets version and pins every internal optional dependency exactly', () => {
    const { text } = setPackageJsonVersion(PARENT, '2026.815.0');
    const pkg = JSON.parse(text);
    assert.equal(pkg.version, '2026.815.0');
    assert.equal(pkg.optionalDependencies['@yashau/prick-linux-x64-gnu'], '2026.815.0');
    assert.equal(pkg.optionalDependencies['@yashau/prick-darwin-arm64'], '2026.815.0');
    assert.equal(pkg.optionalDependencies['@yashau/prick-win32-x64-msvc'], '2026.815.0');
  });

  test('leaves third-party optional dependencies alone', () => {
    const pkg = JSON.parse(setPackageJsonVersion(PARENT, '2026.815.0').text);
    assert.equal(pkg.optionalDependencies['detect-libc'], '^2.0.3');
  });

  test('never rewrites the workspace protocol in dependencies', () => {
    const pkg = JSON.parse(setPackageJsonVersion(PARENT, '2026.815.0').text);
    assert.equal(pkg.dependencies['@yashau/prick-shared'], 'workspace:*');
  });

  test('preserves indentation and the trailing newline', () => {
    const tabbed = JSON.stringify({ name: 'x', version: '0.0.0-dev' }, null, '\t');
    const { text } = setPackageJsonVersion(tabbed, '2026.815.0');
    assert.ok(text.includes('\n\t"version"'), 'tab indentation preserved');
    assert.ok(!text.endsWith('\n'), 'absent trailing newline stays absent');
    assert.ok(setPackageJsonVersion(PARENT, '2026.815.0').text.endsWith('\n'));
  });

  test('a package with no optionalDependencies still works', () => {
    const simple = `{\n  "name": "e2e",\n  "version": "0.0.0-dev"\n}\n`;
    const { text, changes } = setPackageJsonVersion(simple, '2026.815.0');
    assert.equal(JSON.parse(text).version, '2026.815.0');
    assert.deepEqual(changes, ['version']);
  });

  test('is idempotent and reports no changes the second time', () => {
    const once = setPackageJsonVersion(PARENT, '2026.815.0');
    const twice = setPackageJsonVersion(once.text, '2026.815.0');
    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.changes, []);
  });

  test('readPackageJsonVersions reports version plus every internal pin', () => {
    const { text } = setPackageJsonVersion(PARENT, '2026.815.0');
    const found = readPackageJsonVersions(text);
    assert.deepEqual(
      found.map((f) => f.label),
      [
        'version',
        'optionalDependencies["@yashau/prick-linux-x64-gnu"]',
        'optionalDependencies["@yashau/prick-darwin-arm64"]',
        'optionalDependencies["@yashau/prick-win32-x64-msvc"]',
      ],
    );
    assert.deepEqual([...new Set(found.map((f) => f.version))], ['2026.815.0']);
  });
});

// ---------------------------------------------------------------------------

describe('filesystem: set and check across a partial repo', () => {
  /** @returns {string} */
  function makeRepo(files) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'prick-version-'));
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
    return root;
  }

  const cargo = `[workspace.package]\nversion = "0.0.0-dev"\n\n[workspace.dependencies]\nprick-core = { path = "crates/prick-core" }\n`;
  const pkg = (name) => `{\n  "name": "${name}",\n  "version": "0.0.0-dev"\n}\n`;

  test('discoverManifests skips what does not exist yet', () => {
    const root = makeRepo({ 'Cargo.toml': cargo, 'package.json': pkg('prick') });
    try {
      assert.deepEqual(
        discoverManifests(root).map((t) => t.path),
        ['Cargo.toml', 'package.json'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discoverManifests finds packages/* and the nested packages/npm/*', () => {
    const root = makeRepo({
      'package.json': pkg('prick'),
      'packages/app/package.json': pkg('@yashau/prick-app'),
      'packages/shared/package.json': pkg('@yashau/prick-shared'),
      'packages/npm/prick/package.json': pkg('@yashau/prick'),
      'e2e/package.json': pkg('e2e'),
    });
    try {
      assert.deepEqual(
        discoverManifests(root).map((t) => t.path),
        [
          'package.json',
          'packages/app/package.json',
          'packages/npm/prick/package.json',
          'packages/shared/package.json',
          'e2e/package.json',
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('set stamps every manifest that exists and reports what it wrote', () => {
    const root = makeRepo({
      'Cargo.toml': cargo,
      'package.json': pkg('prick'),
      'packages/app/package.json': pkg('@yashau/prick-app'),
    });
    try {
      const lines = [];
      const code = main(['set', '2026.815.0'], { root, log: (s) => lines.push(s) });
      assert.equal(code, 0);

      assert.match(readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), /version = "2026\.815\.0"/);
      assert.equal(
        JSON.parse(readFileSync(path.join(root, 'packages/app/package.json'), 'utf8')).version,
        '2026.815.0',
      );
      assert.ok(lines.some((l) => l.includes('stamped 2026.815.0 into 3 of 3')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('set is a no-op the second time', () => {
    const root = makeRepo({ 'package.json': pkg('prick') });
    try {
      main(['set', '2026.815.0'], { root, log: () => {} });
      const lines = [];
      main(['set', '2026.815.0'], { root, log: (s) => lines.push(s) });
      assert.ok(lines.some((l) => l.includes('already 2026.815.0')));
      assert.ok(lines.some((l) => l.includes('into 0 of 1')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('check passes when everything agrees and fails on drift', () => {
    const root = makeRepo({
      'Cargo.toml': cargo,
      'package.json': pkg('prick'),
      'packages/app/package.json': pkg('@yashau/prick-app'),
    });
    try {
      assert.equal(main(['check'], { root, log: () => {}, logErr: () => {} }), 0);

      writeFileSync(
        path.join(root, 'packages/app/package.json'),
        `{\n  "name": "@yashau/prick-app",\n  "version": "2026.814.0"\n}\n`,
        'utf8',
      );
      const errors = [];
      assert.equal(main(['check'], { root, log: () => {}, logErr: (s) => errors.push(s) }), 1);
      assert.ok(errors.some((l) => l.includes('version drift')));
      assert.ok(errors.some((l) => l.includes('packages/app/package.json')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('check tolerates an empty repo', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'prick-version-'));
    try {
      assert.equal(main(['check'], { root, log: () => {}, logErr: () => {} }), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('set rejects an invalid version before writing anything', () => {
    const root = makeRepo({ 'package.json': pkg('prick') });
    try {
      assert.throws(() => main(['set', 'v2026.815.0'], { root, log: () => {} }), /not a valid/);
      assert.equal(
        JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
        '0.0.0-dev',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown command exits non-zero', () => {
    const errors = [];
    assert.equal(
      main(['frobnicate'], { root: os.tmpdir(), log: () => {}, logErr: (s) => errors.push(s) }),
      1,
    );
    assert.ok(errors.some((l) => l.includes('unknown command')));
  });
});
