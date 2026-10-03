// scripts/version.test.mjs — node:test + node:assert only, no dependencies.
//
// Run with `mise run test:scripts`, or directly: `node --test scripts/`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  CLI_TAG_PREFIX,
  DEV_VERSION,
  DOCS_TAG_PREFIX,
  VERSION_RE,
  assertVersion,
  claimTag,
  computePatch,
  dateToCalver,
  discoverManifests,
  fetchTagsArgs,
  formatCalver,
  formatTag,
  formatVersion,
  main,
  planVersion,
  readCargoLockVersions,
  readCargoVersions,
  readPackageJsonVersions,
  setCargoLockVersion,
  setCargoVersion,
  setPackageJsonVersion,
  tagCreateArgs,
  tagDeleteArgs,
  tagGlob,
  tagMatchesGlob,
  tagPushArgs,
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
        assert.match(error.message, /refusing to compute N for v2026\.815/);
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

describe('the two release lines count N independently', () => {
  const docsPlan = (date, tags = []) => planVersion({ date, tags, tagPrefix: DOCS_TAG_PREFIX });

  test('the prefixes are what they claim to be', () => {
    assert.equal(CLI_TAG_PREFIX, 'v');
    assert.equal(DOCS_TAG_PREFIX, 'docs-v');
  });

  test('a docs cut at zero docs tags is docs-v…0', () => {
    const plan = docsPlan('2026-08-15');
    assert.equal(plan.patch, 0);
    assert.equal(plan.version, '2026.815.0');
    assert.equal(plan.tag, 'docs-v2026.815.0');
    assert.equal(plan.calver, '2026.08.15.0');
  });

  test('CLI tags do not advance the docs N', () => {
    const cliTags = ['v2026.815.0', 'v2026.815.1', 'v2026.815.2'];
    assert.equal(docsPlan('2026-08-15', cliTags).patch, 0, 'three CLI cuts, still docs N = 0');
    assert.equal(docsPlan('2026-08-15', cliTags).tag, 'docs-v2026.815.0');
  });

  test('docs tags do not advance the CLI N — the scenario from the brief', () => {
    // Cut docs three times in a day. The next CLI release must still be .0.
    const tags = [];
    for (let i = 0; i < 3; i += 1) tags.push(docsPlan('2026-08-15', tags).tag);
    assert.deepEqual(tags, ['docs-v2026.815.0', 'docs-v2026.815.1', 'docs-v2026.815.2']);
    assert.equal(planOn('2026-08-15', tags).patch, 0);
    assert.equal(planOn('2026-08-15', tags).tag, 'v2026.815.0');
  });

  test('both lines advance side by side without interfering', () => {
    const tags = ['v2026.815.0', 'docs-v2026.815.0', 'docs-v2026.815.1', 'v2026.815.1'];
    assert.equal(planOn('2026-08-15', tags).tag, 'v2026.815.2');
    assert.equal(docsPlan('2026-08-15', tags).tag, 'docs-v2026.815.2');
  });

  test('computePatch takes the prefix positionally too', () => {
    const tags = ['docs-v2026.815.0', 'v2026.815.0', 'v2026.815.1'];
    assert.equal(computePatch(tags, { major: 2026, minor: 815 }, DOCS_TAG_PREFIX), 1);
    assert.equal(computePatch(tags, { major: 2026, minor: 815 }), 2);
  });

  test('formatTag prefixes without validating the prefix into the version', () => {
    assert.equal(formatTag('2026.815.3', DOCS_TAG_PREFIX), 'docs-v2026.815.3');
    assert.equal(formatTag('2026.815.3'), 'v2026.815.3');
  });

  test('a hole in one line names that line, not the other', () => {
    // Same numbers, two namespaces: the message must say which one is broken,
    // or the operator inspects the wrong set of tags and finds nothing wrong.
    assert.throws(
      () => docsPlan('2026-08-15', ['docs-v2026.815.0', 'docs-v2026.815.2']),
      /refusing to compute N for docs-v2026\.815/,
    );
    assert.throws(
      () => planOn('2026-08-15', ['v2026.815.0', 'v2026.815.2']),
      /refusing to compute N for v2026\.815/,
    );
  });

  test('a broken docs sequence does not break the CLI line', () => {
    const tags = ['docs-v2026.815.0', 'docs-v2026.815.2'];
    assert.equal(planOn('2026-08-15', tags).tag, 'v2026.815.0');
  });
});

// ---------------------------------------------------------------------------

describe('the workflow tag globs cannot cross', () => {
  const CLI_GLOB = tagGlob(CLI_TAG_PREFIX);
  const DOCS_GLOB = tagGlob(DOCS_TAG_PREFIX);

  test('the globs are what the workflows declare', () => {
    assert.equal(CLI_GLOB, 'v*');
    assert.equal(DOCS_GLOB, 'docs-v*');
  });

  test('a docs tag does not trigger the CLI workflow', () => {
    // The whole safety of `v*` rests on a glob being anchored at the start of
    // the ref name. Asserted, not assumed.
    assert.equal(tagMatchesGlob(CLI_GLOB, 'docs-v2026.815.0'), false);
    assert.equal(tagMatchesGlob(CLI_GLOB, 'docs-v2026.1231.9'), false);
  });

  test('a CLI tag does not trigger the docs workflow', () => {
    assert.equal(tagMatchesGlob(DOCS_GLOB, 'v2026.815.0'), false);
    assert.equal(tagMatchesGlob(DOCS_GLOB, 'v2026.1231.9'), false);
  });

  test('each glob matches its own line', () => {
    assert.equal(tagMatchesGlob(CLI_GLOB, 'v2026.815.0'), true);
    assert.equal(tagMatchesGlob(DOCS_GLOB, 'docs-v2026.815.0'), true);
  });

  test('no tag either line can produce matches both globs', () => {
    for (const date of ['2026-01-05', '2026-08-15', '2026-10-01', '2026-12-31']) {
      for (const prefix of [CLI_TAG_PREFIX, DOCS_TAG_PREFIX]) {
        const { tag } = planVersion({ date, tags: [], tagPrefix: prefix });
        const matches = [CLI_GLOB, DOCS_GLOB].filter((g) => tagMatchesGlob(g, tag));
        assert.deepEqual(matches, [tagGlob(prefix)], `${tag} matched ${matches.join(' and ')}`);
      }
    }
  });

  test('the globs in the workflow files are the ones tested here', () => {
    // Ties the constants above to the YAML. A workflow edited to `**` or to
    // `*v*` would pass every test above and still cross the lines.
    const read = (name) =>
      readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', name), 'utf8');
    assert.match(read('cli-release.yml'), /^\s+-\s+"v\*"\s*$/m);
    assert.match(read('docs-release.yml'), /^\s+-\s+"docs-v\*"\s*$/m);
  });
});

// ---------------------------------------------------------------------------

describe('claimTag — the tag is the lock', () => {
  /**
   * An in-memory git. `remote` is the shared truth; `local` is this clone's
   * view, refreshed only by `fetch`.
   *
   * `onReject` is what the race winner had already pushed by the time our push
   * bounced — which may be more than the one tag we tried for.
   *
   * @param {{ remote?: string[], local?: string[], rejectPush?: string[], failCreate?: string[], onReject?: string[] }} [setup]
   */
  function fakeGit({
    remote = [],
    local = remote,
    rejectPush = [],
    failCreate = [],
    onReject = [],
  } = {}) {
    const remoteTags = new Set(remote);
    const localTags = new Set(local);
    const reject = new Set(rejectPush);
    const fail = new Set(failCreate);
    const calls = [];

    const git = (args) => {
      calls.push([...args]);
      const [command, second] = args;

      if (command === 'fetch') {
        for (const tag of remoteTags) localTags.add(tag);
        return '';
      }
      if (command === 'tag' && second === '--list') {
        return `${[...localTags].join('\n')}\n`;
      }
      if (command === 'tag' && second === '--annotate') {
        const tag = args.at(-1);
        if (fail.delete(tag)) throw new Error(`fatal: tag '${tag}' already exists`);
        localTags.add(tag);
        return '';
      }
      if (command === 'tag' && second === '--delete') {
        localTags.delete(args.at(-1));
        return '';
      }
      if (command === 'push') {
        const tag = String(args[2]).replace('refs/tags/', '');
        if (reject.delete(tag)) {
          // Losing the race means the winner's tags now exist on the remote.
          remoteTags.add(tag);
          for (const claimed of onReject) remoteTags.add(claimed);
          throw new Error(`! [rejected] ${tag} (already exists)`);
        }
        remoteTags.add(tag);
        return '';
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };

    return { git, calls, remoteTags, localTags };
  }

  const NEVER_SLEEP = async () => {};
  const AUG15 = new Date('2026-08-15T12:00:00Z');

  const claim = (fake, extra = {}) =>
    claimTag({ git: fake.git, now: AUG15, sleep: NEVER_SLEEP, ...extra });

  test('claims N = 0 in a repository with no tags', async () => {
    const fake = fakeGit();
    const { plan, attempt } = await claim(fake);
    assert.equal(plan.tag, 'v2026.815.0');
    assert.equal(attempt, 1);
    assert.ok(fake.remoteTags.has('v2026.815.0'), 'the tag reached the remote');
  });

  test('fetches before computing, so N is counted from the remote', async () => {
    // The tag exists on the remote but not locally: without the fetch this
    // would compute N = 0 and the push would bounce.
    const fake = fakeGit({ remote: ['v2026.815.0'], local: [] });
    const { plan } = await claim(fake);
    assert.equal(plan.tag, 'v2026.815.1');
    assert.deepEqual(fake.calls[0], fetchTagsArgs('origin'));
  });

  test('pushes an annotated tag by its full refspec', async () => {
    const fake = fakeGit();
    await claim(fake, { message: (p) => `msg for ${p.tag}` });
    const create = fake.calls.find((c) => c[0] === 'tag' && c[1] === '--annotate');
    const push = fake.calls.find((c) => c[0] === 'push');
    assert.deepEqual(create, tagCreateArgs('v2026.815.0', 'msg for v2026.815.0'));
    assert.deepEqual(push, tagPushArgs('v2026.815.0', 'origin'));
    assert.ok(create.includes('--annotate'), 'a lightweight tag records no author');
    assert.equal(push[2], 'refs/tags/v2026.815.0');
  });

  test('a rejected push recomputes N rather than incrementing it', async () => {
    // The race winner took .0 AND .1 — one run can only claim one, but two
    // racing runs can land between our read and our push. Merely incrementing
    // would try .1 and bounce again; recomputing lands on .2.
    const fake = fakeGit({
      rejectPush: ['v2026.815.0'],
      onReject: ['v2026.815.0', 'v2026.815.1'],
    });
    const { plan, attempt } = await claim(fake);
    assert.equal(plan.tag, 'v2026.815.2');
    assert.equal(attempt, 2);
  });

  test('a lost race leaves no local tag behind', async () => {
    const fake = fakeGit({ rejectPush: ['v2026.815.0'] });
    await claim(fake);
    assert.deepEqual(
      fake.calls.filter((c) => c[0] === 'tag' && c[1] === '--delete'),
      [tagDeleteArgs('v2026.815.0')],
    );
    assert.ok(fake.localTags.has('v2026.815.1'), 'only the claimed tag survives locally');
  });

  test('a stale local-only tag is dropped and the claim retried', async () => {
    const fake = fakeGit({ failCreate: ['v2026.815.0'] });
    const { plan, attempt } = await claim(fake);
    assert.equal(plan.tag, 'v2026.815.0');
    assert.equal(attempt, 2);
  });

  test('gives up after the attempt budget rather than looping forever', async () => {
    const fake = fakeGit({ rejectPush: ['v2026.815.0', 'v2026.815.1'] });
    await assert.rejects(
      () => claim(fake, { attempts: 2 }),
      (error) => {
        assert.match(error.message, /could not claim a v\* tag after 2 attempts/);
        assert.match(error.message, /Never delete and re-push a tag/);
        return true;
      },
    );
    // Every tag still in the clone came back from the remote. Nothing this
    // process created survives a failed claim, so the next run recomputes N
    // from the truth rather than from its own debris.
    for (const tag of fake.localTags) {
      assert.ok(fake.remoteTags.has(tag), `${tag} was left behind locally`);
    }
    assert.deepEqual([...fake.localTags], ['v2026.815.0'], 'only the tag that won remains');
  });

  test('claims on the docs line without seeing the CLI line', async () => {
    const fake = fakeGit({ remote: ['v2026.815.0', 'v2026.815.1', 'v2026.815.2'] });
    const { plan } = await claim(fake, { tagPrefix: DOCS_TAG_PREFIX });
    assert.equal(plan.tag, 'docs-v2026.815.0');
  });

  test('claims on the CLI line without seeing the docs line', async () => {
    const fake = fakeGit({ remote: ['docs-v2026.815.0', 'docs-v2026.815.1'] });
    const { plan } = await claim(fake, { tagPrefix: CLI_TAG_PREFIX });
    assert.equal(plan.tag, 'v2026.815.0');
  });

  test('refuses a missing git runner or a nonsensical budget', async () => {
    await assert.rejects(() => claimTag({}), TypeError);
    await assert.rejects(() => claim(fakeGit(), { attempts: 0 }), RangeError);
  });

  test('the argument builders end options before the tag name', () => {
    // A tag called `--force` is absurd but a tag read as an option is a bug.
    assert.equal(tagCreateArgs('x', 'm').at(-2), '--');
    assert.equal(tagDeleteArgs('x').at(-2), '--');
    assert.deepEqual(fetchTagsArgs('upstream').at(-1), 'upstream');
    assert.ok(fetchTagsArgs().includes('--force'), 'a drifted local view must be corrected');
    assert.ok(fetchTagsArgs().includes('--prune'));
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

/** The six workspace members, in the order Cargo.lock lists them. */
const LOCK_MEMBERS = ['prick-api', 'prick-auth', 'prick-core', 'prick-exec', 'prk', 'xtask'];

/**
 * A real-shaped Cargo.lock, plus a trap: a registry crate sharing both a name
 * AND a version with a workspace member. Only the sourceless twin is stamped.
 */
const LOCK = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 4

[[package]]
name = "clap"
version = "4.5.51"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "prick-api"
version = "0.0.0-dev"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1111111111ff"

[[package]]
name = "prick-api"
version = "0.0.0-dev"
dependencies = [
 "clap",
 "prick-core",
]

[[package]]
name = "prick-auth"
version = "0.0.0-dev"

[[package]]
name = "prick-core"
version = "0.0.0-dev"

[[package]]
name = "prick-exec"
version = "0.0.0-dev"

[[package]]
name = "prk"
version = "0.0.0-dev"

[[package]]
name = "xtask"
version = "0.0.0-dev"
`;

describe('Cargo.lock rewriting', () => {
  test('stamps every workspace member — all six, or --locked fails the release', () => {
    // Leaving one behind is what made every cross-compile die with "cannot
    // update the lock file … because --locked was passed".
    const { text } = setCargoLockVersion(LOCK, '2026.816.0');
    for (const name of LOCK_MEMBERS) {
      const at = new RegExp(`name = "${name}"\\nversion = "2026\\.816\\.0"`);
      assert.match(text, at, `${name} was left stale in the lock`);
    }
  });

  test('changes exactly the six workspace blocks, in file order', () => {
    assert.deepEqual(
      setCargoLockVersion(LOCK, '2026.816.0').changes,
      LOCK_MEMBERS.map((n) => `[[package]] ${n} version`),
    );
  });

  test('never touches a block with a source — not even one named like ours', () => {
    // A registry crate sharing a name with a workspace member separates "has no
    // source" from "has a name we recognise". Its version answers to its
    // checksum, so stamping it writes a lock cargo rejects.
    const { text } = setCargoLockVersion(LOCK, '2026.816.0');
    assert.match(text, /name = "prick-api"\nversion = "0\.0\.0-dev"\nsource = "registry\+/);
    assert.match(text, /name = "clap"\nversion = "4\.5\.51"/);
    // The twin is the only 0.0.0-dev cargo may still see.
    const left = text.match(/0\.0\.0-dev/g) ?? [];
    assert.equal(left.length, 1, 'the registry twin is the only 0.0.0-dev that may remain');
  });

  test('leaves the lock format version alone', () => {
    // `version = 4` belongs to no package; a CalVer there is unreadable to cargo.
    assert.match(setCargoLockVersion(LOCK, '2026.816.0').text, /^version = 4$/m);
  });

  test('readCargoLockVersions reports the workspace members and nothing else', () => {
    const found = readCargoLockVersions(LOCK);
    assert.deepEqual(
      found.map((f) => f.label),
      LOCK_MEMBERS.map((n) => `[[package]] ${n} version`),
    );
    assert.deepEqual([...new Set(found.map((f) => f.version))], ['0.0.0-dev']);
  });

  test('is idempotent and rewrites nothing but the version lines', () => {
    const once = setCargoLockVersion(LOCK, '2026.816.0').text;
    assert.equal(setCargoLockVersion(once, '2026.816.0').text, once);
    const before = LOCK.split('\n');
    assert.equal(once.split('\n').filter((l, i) => l !== before[i]).length, 6);
  });

  test('refuses an invalid version before touching anything', () => {
    assert.throws(() => setCargoLockVersion(LOCK, '2026.0816.0'), /not a valid CalVer/);
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

  test('discoverManifests claims Cargo.lock, as its own kind', () => {
    const root = makeRepo({ 'Cargo.toml': cargo, 'Cargo.lock': LOCK });
    try {
      assert.deepEqual(discoverManifests(root), [
        { path: 'Cargo.toml', kind: 'cargo' },
        { path: 'Cargo.lock', kind: 'lock' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('check fails when the lock is stale relative to Cargo.toml', () => {
    // The exact release-workflow state: Cargo.toml stamped, the lock still on
    // 0.0.0-dev. `--locked` catches that six cross-compiles deep; check has to
    // catch it before the tag.
    const root = makeRepo({ 'Cargo.toml': cargo, 'Cargo.lock': LOCK });
    try {
      assert.equal(main(['check'], { root, log: () => {}, logErr: () => {} }), 0);
      const bumped = setCargoVersion(cargo, '2026.816.0').text;
      writeFileSync(path.join(root, 'Cargo.toml'), bumped, 'utf8');
      const errors = [];
      assert.equal(main(['check'], { root, log: () => {}, logErr: (s) => errors.push(s) }), 1);
      assert.ok(errors.some((l) => l.includes('version drift')));
      assert.ok(errors.some((l) => l.includes('Cargo.lock') && l.includes('0.0.0-dev')));
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
      'Cargo.lock': LOCK,
      'package.json': pkg('prick'),
      'packages/app/package.json': pkg('@yashau/prick-app'),
    });
    try {
      const lines = [];
      const code = main(['set', '2026.815.0'], { root, log: (s) => lines.push(s) });
      assert.equal(code, 0);

      assert.match(readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), /version = "2026\.815\.0"/);
      const lock = readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
      for (const name of LOCK_MEMBERS) {
        assert.match(lock, new RegExp(`name = "${name}"\\nversion = "2026\\.815\\.0"`), name);
      }
      assert.equal(
        JSON.parse(readFileSync(path.join(root, 'packages/app/package.json'), 'utf8')).version,
        '2026.815.0',
      );
      assert.ok(lines.some((l) => l.includes('stamped 2026.815.0 into 4 of 4')));
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
