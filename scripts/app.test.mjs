// scripts/app.test.mjs — node:test + node:assert only.
//
// `cut` creates and pushes a tag, and the git that does it is a fake. `set`
// rewrites a file, and the filesystem it writes to is a recorder. These tests
// never touch a ref, open a terminal or modify the tree.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  TAG_GLOB,
  TAG_PREFIX,
  VERSION_FILE,
  confirmationToken,
  formatCutSummary,
  isConfirmed,
  main,
  stampSource,
  tagMessage,
  versionFromHeadTags,
} from './app.mjs';
import {
  APP_TAG_PREFIX,
  CLI_TAG_PREFIX,
  DEV_VERSION,
  DOCS_TAG_PREFIX,
  planVersion,
  tagCreateArgs,
  tagGlob,
  tagMatchesGlob,
  tagPushArgs,
} from './version.mjs';

const AUG15 = new Date('2026-08-15T12:00:00Z');
const PLAN = planVersion({ tags: [], now: AUG15, tagPrefix: APP_TAG_PREFIX });

const repoFile = (...parts) => readFileSync(path.join(import.meta.dirname, '..', ...parts), 'utf8');

/** The committed version module, exactly as `set` will find it. */
const COMMITTED = repoFile(...VERSION_FILE.split('/'));

/**
 * An in-memory git, plus recorders for every other effect.
 *
 * `remote` is the shared truth; `local` is this clone's view, refreshed only by
 * a fetch. `rejectPush` simulates losing the compare-and-swap. `headTags` is
 * what `git tag --points-at HEAD` reports.
 */
function harness(overrides = {}) {
  const out = [];
  const err = [];
  const gitCalls = [];
  const writes = [];

  const remoteTags = new Set(overrides.remoteTags ?? overrides.tags ?? []);
  const localTags = new Set(overrides.tags ?? []);
  const reject = new Set(overrides.rejectPush ?? []);

  const git = (args) => {
    gitCalls.push([...args]);
    const [command, second] = args;
    if (command === 'fetch') {
      for (const tag of remoteTags) localTags.add(tag);
      return '';
    }
    if (command === 'tag' && second === '--points-at') {
      return `${(overrides.headTags ?? []).join('\n')}\n`;
    }
    if (command === 'tag' && second === '--list') return `${[...localTags].join('\n')}\n`;
    if (command === 'tag' && second === '--annotate') {
      localTags.add(args.at(-1));
      return '';
    }
    if (command === 'tag' && second === '--delete') {
      localTags.delete(args.at(-1));
      return '';
    }
    if (command === 'push') {
      const tag = String(args[2]).replace('refs/tags/', '');
      if (reject.delete(tag)) {
        remoteTags.add(tag);
        throw new Error(`! [rejected] ${tag}`);
      }
      remoteTags.add(tag);
      return '';
    }
    throw new Error(`unexpected git invocation: ${args.join(' ')}`);
  };

  return {
    out,
    err,
    gitCalls,
    writes,
    remoteTags,
    io: {
      log: (s) => out.push(s),
      logErr: (s) => err.push(s),
      git: overrides.git ?? git,
      tags: overrides.tags ?? [],
      now: overrides.now ?? AUG15,
      sleep: async () => {},
      interactive: overrides.interactive ?? true,
      prompt: overrides.prompt ?? (async () => ''),
      // The repository, not a temporary directory: `set` resolves the version
      // file against it, and the injected writeFile records rather than writes.
      root: path.join(import.meta.dirname, '..'),
      readFile: () => overrides.source ?? COMMITTED,
      writeFile: (file, contents) => writes.push({ file, contents }),
    },
  };
}

describe('the release line', () => {
  test('is the `app-v` prefix', () => {
    assert.equal(TAG_PREFIX, 'app-v');
    assert.equal(TAG_GLOB, 'app-v*');
  });

  test('no workflow triggers on an app tag', () => {
    // An app tag names a release; it must never start the CLI or docs release.
    const workflows = path.join(import.meta.dirname, '..', '.github', 'workflows');
    for (const name of readdirSync(workflows).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(path.join(workflows, name), 'utf8');
      // Only the `on.push.tags` lists: a `tags:` key followed by list items.
      const lists = [...text.matchAll(/^\s*tags:\s*\n((?:\s*-\s*.+\n)+)/gm)].map((m) => m[1]);
      const globs = lists.flatMap((list) =>
        [...list.matchAll(/-\s*['"]?([^'"\s]+)['"]?/g)].map((m) => m[1]),
      );
      for (const glob of globs) {
        assert.equal(
          tagMatchesGlob(glob, 'app-v2026.815.0'),
          false,
          `${name} would trigger on an app tag via ${glob}`,
        );
      }
    }
    assert.equal(tagMatchesGlob(tagGlob('v'), 'app-v2026.815.0'), false);
    assert.equal(tagMatchesGlob(tagGlob('docs-v'), 'app-v2026.815.0'), false);
  });

  test('no tag any of the three lines can produce matches another glob', () => {
    const prefixes = [CLI_TAG_PREFIX, DOCS_TAG_PREFIX, APP_TAG_PREFIX];
    const globs = prefixes.map(tagGlob);
    for (const date of ['2026-01-05', '2026-08-15', '2026-10-01', '2026-12-31']) {
      for (const prefix of prefixes) {
        const { tag } = planVersion({ date, tags: [], tagPrefix: prefix });
        const matches = globs.filter((g) => tagMatchesGlob(g, tag));
        assert.deepEqual(matches, [tagGlob(prefix)], `${tag} matched ${matches.join(' and ')}`);
      }
    }
  });
});

describe('the committed version module', () => {
  test('is unstamped', () => {
    assert.match(COMMITTED, /^export const APP_VERSION = "0\.0\.0-dev";$/m);
  });

  test('is read by /health, the OpenAPI document and SvelteKit', () => {
    // The point of one module is that these three cannot disagree. A consumer
    // that went back to a literal would pass every other test here.
    const app = (...parts) => repoFile('packages', 'app', ...parts);
    assert.match(app('src', 'lib', 'server', 'http', 'routes', 'meta.ts'), /version: APP_VERSION/);
    assert.match(app('src', 'lib', 'server', 'http', 'openapi.ts'), /version: APP_VERSION/);
    assert.match(app('svelte.config.js'), /name: APP_VERSION/);
  });
});

describe('confirmation', () => {
  test('the token is the app tag', () => {
    assert.equal(confirmationToken(PLAN), 'app-v2026.815.0');
  });

  test('rejects y, the bare version and the other lines’ tags', () => {
    for (const answer of ['y', 'yes', '2026.815.0', 'v2026.815.0', 'docs-v2026.815.0']) {
      assert.equal(isConfirmed(answer, PLAN), false, answer);
    }
    assert.equal(isConfirmed('  app-v2026.815.0 \n', PLAN), true);
  });
});

describe('summaries', () => {
  test('the cut summary says nothing deploys', () => {
    const text = formatCutSummary(PLAN).join('\n');
    assert.match(text, /app-v2026\.815\.0/);
    assert.match(text, /starts no workflow and deploys/);
  });

  test('the tag message names the web app and how to deploy it', () => {
    const message = tagMessage(PLAN);
    assert.match(message, /^app-v2026\.815\.0$/m);
    assert.ok(message.includes(`Web app ${PLAN.calver}`), message);
    assert.match(message, /mise run app:set/);
  });
});

describe('next', () => {
  test('counts app tags only — CLI and docs tags do not advance N', async () => {
    const h = harness({ tags: ['v2026.815.0', 'v2026.815.1', 'docs-v2026.815.0'] });
    assert.equal(await main(['next'], h.io), 0);
    assert.match(h.out.join('\n'), /app-v2026\.815\.0/);
    assert.deepEqual(h.gitCalls, []);
  });

  test('counts its own line', async () => {
    const h = harness({ tags: ['app-v2026.815.0'] });
    await main(['next'], h.io);
    assert.match(h.out.join('\n'), /app-v2026\.815\.1/);
  });
});

describe('cut', () => {
  test('tags and pushes only after the tag is typed exactly', async () => {
    const h = harness({ prompt: async () => 'app-v2026.815.0' });
    assert.equal(await main(['cut'], h.io), 0);
    assert.deepEqual(
      h.gitCalls.find((c) => c[0] === 'tag' && c[1] === '--annotate'),
      tagCreateArgs('app-v2026.815.0', tagMessage(PLAN)),
    );
    assert.deepEqual(
      h.gitCalls.find((c) => c[0] === 'push'),
      tagPushArgs('app-v2026.815.0', 'origin'),
    );
    assert.ok(h.remoteTags.has('app-v2026.815.0'));
    assert.deepEqual(h.writes, [], 'cutting never stamps the tree');
  });

  test('aborts and touches no ref on a wrong answer', async () => {
    const h = harness({ prompt: async () => 'y' });
    assert.equal(await main(['cut'], h.io), 1);
    assert.deepEqual(h.gitCalls, []);
    assert.match(h.err.join('\n'), /aborted/);
  });

  test('refuses rather than hanging when there is no tty and no --yes', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('must not prompt without a terminal'),
    });
    assert.equal(await main(['cut'], h.io), 1);
    assert.deepEqual(h.gitCalls, []);
    assert.match(h.err.join('\n'), /--yes/);
  });

  test('a lost race is recomputed, claimed and reported', async () => {
    const h = harness({ prompt: async () => 'app-v2026.815.0', rejectPush: ['app-v2026.815.0'] });
    assert.equal(await main(['cut'], h.io), 0);
    assert.ok(h.remoteTags.has('app-v2026.815.1'));
    assert.match(h.out.join('\n'), /Claimed app-v2026\.815\.1/);
  });
});

describe('versionFromHeadTags', () => {
  test('reads the version off an app tag', () => {
    assert.equal(versionFromHeadTags(['app-v2026.815.0']), '2026.815.0');
  });

  test('ignores the other lines and malformed tags', () => {
    assert.equal(versionFromHeadTags(['v2026.815.0', 'docs-v2026.815.0', 'app-vnope']), null);
  });

  test('takes the highest N numerically when a commit carries two', () => {
    assert.equal(versionFromHeadTags(['app-v2026.815.9', 'app-v2026.815.10']), '2026.815.10');
  });

  test('is null when nothing is tagged', () => {
    assert.equal(versionFromHeadTags([]), null);
  });
});

describe('stampSource', () => {
  test('rewrites only the constant', () => {
    const stamped = stampSource(COMMITTED, '2026.815.0');
    assert.match(stamped, /^export const APP_VERSION = "2026\.815\.0";$/m);
    assert.equal(stamped.replace('"2026.815.0"', `"${DEV_VERSION}"`), COMMITTED);
  });

  test('can reset to the placeholder', () => {
    const stamped = stampSource(COMMITTED, '2026.815.0');
    assert.equal(stampSource(stamped, DEV_VERSION), COMMITTED);
  });

  test('refuses something that is not CalVer', () => {
    for (const bad of ['v2026.815.0', '2026.0815.0', 'latest', '']) {
      assert.throws(() => stampSource(COMMITTED, bad), /not a CalVer version/, bad);
    }
  });

  test('refuses a file it cannot find exactly one constant in', () => {
    assert.throws(() => stampSource('export const OTHER = 1;\n', '2026.815.0'), /found 0/);
  });
});

describe('set', () => {
  test('stamps an explicit version', async () => {
    const h = harness();
    assert.equal(await main(['set', '2026.815.3'], h.io), 0);
    assert.equal(h.writes.length, 1);
    assert.ok(h.writes[0].file.endsWith(path.join(...VERSION_FILE.split('/'))));
    assert.match(h.writes[0].contents, /APP_VERSION = "2026\.815\.3"/);
  });

  test('takes the version from the app tag on HEAD', async () => {
    const h = harness({ headTags: ['v2026.815.0', 'app-v2026.815.2'] });
    assert.equal(await main(['set'], h.io), 0);
    assert.match(h.writes[0].contents, /APP_VERSION = "2026\.815\.2"/);
  });

  test('refuses, writing nothing, when HEAD carries no app tag', async () => {
    const h = harness({ headTags: ['v2026.815.0'] });
    assert.equal(await main(['set'], h.io), 1);
    assert.deepEqual(h.writes, []);
    assert.match(h.err.join('\n'), /HEAD carries no app-v\* tag/);
  });

  test('refuses a malformed version, writing nothing', async () => {
    const h = harness();
    await assert.rejects(main(['set', 'banana'], h.io), /not a CalVer version/);
    assert.deepEqual(h.writes, []);
  });
});

describe('argument handling', () => {
  test('rejects an unknown command and touches nothing', async () => {
    const h = harness();
    assert.equal(await main(['deploy'], h.io), 1);
    assert.deepEqual(h.gitCalls, []);
    assert.deepEqual(h.writes, []);
  });

  test('rejects no command at all', async () => {
    const h = harness();
    assert.equal(await main([], h.io), 1);
  });

  test('--help exits zero', async () => {
    const h = harness();
    assert.equal(await main(['next', '--help'], h.io), 0);
  });
});
