// scripts/docs.test.mjs — node:test + node:assert only.
//
// `cut` creates and pushes a tag, and the git that does it is a fake: these
// tests never touch a ref, never invoke gh and never open a terminal.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  DOCS_URL,
  TAG_GLOB,
  TAG_PREFIX,
  WORKFLOW,
  confirmationToken,
  formatCutSummary,
  formatPlanSummary,
  isConfirmed,
  main,
  runListArgs,
  tagMessage,
} from './docs.mjs';
import { DOCS_TAG_PREFIX, planVersion, tagCreateArgs, tagPushArgs } from './version.mjs';

const AUG15 = new Date('2026-08-15T12:00:00Z');
const PLAN = planVersion({ tags: [], now: AUG15, tagPrefix: DOCS_TAG_PREFIX });

const repoFile = (...parts) => readFileSync(path.join(import.meta.dirname, '..', ...parts), 'utf8');

const workflowText = () => repoFile('.github', 'workflows', WORKFLOW);

/**
 * An in-memory git, plus recorders for every other effect.
 *
 * `remote` is the shared truth; `local` is this clone's view, refreshed only by
 * a fetch. `rejectPush` simulates losing the compare-and-swap.
 */
function harness(overrides = {}) {
  const out = [];
  const err = [];
  const ghCalls = [];
  const gitCalls = [];

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
    ghCalls,
    gitCalls,
    remoteTags,
    localTags,
    io: {
      log: (s) => out.push(s),
      logErr: (s) => err.push(s),
      gh: (args, _options) => {
        ghCalls.push(args);
        return overrides.ghResult ?? '';
      },
      git: overrides.git ?? git,
      tags: overrides.tags ?? [],
      now: overrides.now ?? AUG15,
      sleep: async () => {},
      interactive: overrides.interactive ?? true,
      prompt: overrides.prompt ?? (async () => ''),
      root: os.tmpdir(),
    },
  };
}

describe('the release line', () => {
  test('is the `docs-v` prefix and the docs workflow', () => {
    assert.equal(TAG_PREFIX, 'docs-v');
    assert.equal(TAG_GLOB, 'docs-v*');
    assert.equal(WORKFLOW, 'docs-release.yml');
  });

  test('the workflow triggers on that tag glob and on nothing else', () => {
    const yaml = workflowText();
    // The requirement, exactly: not a push to main, not a docs edit, not a
    // manual dispatch. One trigger.
    assert.match(yaml, /^on:\n\s+push:\n\s+tags:\n\s+-\s+"docs-v\*"\n\npermissions:/m);
    assert.doesNotMatch(yaml, /^\s+branches:/m, 'a branch push must not deploy');
    assert.doesNotMatch(yaml, /^\s+paths:/m, 'a path filter must not deploy');
    assert.doesNotMatch(yaml, /workflow_dispatch/, 'a dispatch must not deploy');
  });

  test('the workflow deploys and releases but never claims a version', () => {
    const yaml = workflowText();
    assert.doesNotMatch(yaml, /git push/, 'nothing in CI may move a ref');
    assert.doesNotMatch(yaml, /persist-credentials: true/);
    assert.match(yaml, /gh release create/, 'the docs line needs a visible history');
    assert.match(yaml, /--latest=false/, 'a docs release must not steal the Latest badge');
  });
});

describe('the hostname', () => {
  /** A hostname as a regex fragment: only its dots need escaping. */
  const literal = (value) => value.replaceAll('.', '\\.');

  // Three files state where the site lives, in three different languages, and
  // each is useless if it disagrees with the others: a canonical URL nothing
  // serves keeps the site out of the index, and a route nothing advertises is
  // a hostname no reader is sent to. The comments in both config files say
  // "do both in the same commit"; this is what makes that mechanical.
  test('is stated identically by the script, Astro and wrangler', () => {
    const { host } = new URL(DOCS_URL);

    assert.match(
      repoFile('packages', 'docs', 'astro.config.ts'),
      new RegExp(`site: "${literal(DOCS_URL)}"`),
      `astro.config.ts must advertise ${DOCS_URL} as canonical`,
    );

    assert.match(
      repoFile('packages', 'docs', 'wrangler.jsonc'),
      new RegExp(`"pattern": "${literal(host)}", "custom_domain": true`),
      `wrangler.jsonc must route ${host} as a custom domain`,
    );
  });

  // NOT the app's security argument -- this Worker has nothing to expose. A
  // second hostname serving byte-identical pages is a duplicate of every
  // canonical URL on the site, and one more address a stale copy is linked
  // from. With these off, the route above is the only place a deploy can land.
  test('is the only hostname: workers.dev and preview URLs are off', () => {
    const config = repoFile('packages', 'docs', 'wrangler.jsonc');
    assert.match(config, /^\s*"workers_dev": false,$/m);
    assert.match(config, /^\s*"preview_urls": false,$/m);
  });
});

describe('confirmation', () => {
  test('the token is the docs tag, matching cli:cut rather than a plain y/N', () => {
    assert.equal(confirmationToken(PLAN), 'docs-v2026.815.0');
  });

  test('accepts the exact tag, tolerating surrounding whitespace', () => {
    assert.equal(isConfirmed('docs-v2026.815.0', PLAN), true);
    assert.equal(isConfirmed('  docs-v2026.815.0\n', PLAN), true);
  });

  test('rejects y, yes, the bare version and the CLI tag', () => {
    for (const bad of [
      'y',
      'Y',
      'yes',
      '',
      '2026.815.0',
      'v2026.815.0',
      'docs-v2026.815.1',
      null,
    ]) {
      assert.equal(isConfirmed(bad, PLAN), false, `${JSON.stringify(bad)} must not confirm`);
    }
  });
});

describe('summaries', () => {
  test('the plan shows semver, human CalVer and the docs tag', () => {
    const text = formatPlanSummary(PLAN).join('\n');
    assert.match(text, /version {3}2026\.815\.0/);
    assert.match(text, /calver {4}2026\.08\.15\.0/);
    assert.match(text, /tag {7}docs-v2026\.815\.0/);
    assert.match(text, /\(UTC\)/);
  });

  test('N = 0 is called out as the first docs release of the day', () => {
    assert.match(formatPlanSummary(PLAN).join('\n'), /N {9}0 {2}\(first docs release today\)/);
    const second = planVersion({
      tags: ['docs-v2026.815.0'],
      now: AUG15,
      tagPrefix: DOCS_TAG_PREFIX,
    });
    assert.doesNotMatch(formatPlanSummary(second).join('\n'), /first docs release today/);
  });

  test('the cut summary says the push is the only trigger', () => {
    const text = formatCutSummary(PLAN).join('\n');
    assert.match(text, /pushes the tag docs-v2026\.815\.0/);
    assert.match(text, /not a push to main, not a docs edit/);
    assert.match(text, /prick-docs Worker/);
    assert.match(text, /GitHub Release/);
    assert.match(text, /https:\/\/docs\.getprick\.dev/);
  });

  test('the tag message names the docs site, not the CLI', () => {
    assert.match(tagMessage(PLAN), /^docs-v2026\.815\.0\n/);
    assert.match(tagMessage(PLAN), /Documentation site 2026\.08\.15\.0/);
  });

  // `git show docs-v2026.815.0` is the record of what shipped. A message that
  // carries only a version leaves the reader to work out where it went.
  test('the tag message says which site the release is serving', () => {
    assert.match(tagMessage(PLAN), /Serving https:\/\/docs\.getprick\.dev/);
    assert.match(tagMessage(PLAN), /Pushing this tag is what deployed it/);
  });
});

describe('next', () => {
  test('works at zero docs tags and touches nothing', async () => {
    const h = harness({ tags: [] });
    assert.equal(await main(['next'], h.io), 0);
    assert.deepEqual(h.gitCalls, []);
    assert.deepEqual(h.ghCalls, []);
    const text = h.out.join('\n');
    assert.match(text, /2026\.815\.0/);
    assert.match(text, /2026\.08\.15\.0/);
    assert.match(text, /docs-v2026\.815\.0/);
  });

  test('never prompts, even without a terminal', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('next must not prompt'),
    });
    assert.equal(await main(['next'], h.io), 0);
  });

  test('counts docs tags only — CLI tags do not advance N', async () => {
    const h = harness({ tags: ['v2026.815.0', 'v2026.815.1', 'v2026.815.2'] });
    await main(['next'], h.io);
    assert.match(h.out.join('\n'), /docs-v2026\.815\.0/);
  });

  test('counts its own line', async () => {
    const h = harness({ tags: ['docs-v2026.815.0', 'docs-v2026.815.1'] });
    await main(['next'], h.io);
    assert.match(h.out.join('\n'), /docs-v2026\.815\.2/);
  });
});

describe('cut', () => {
  test('tags and pushes only after the tag is typed exactly', async () => {
    const h = harness({ prompt: async () => 'docs-v2026.815.0' });
    assert.equal(await main(['cut'], h.io), 0);
    assert.deepEqual(h.ghCalls, [], 'the tag push is the trigger; nothing is dispatched');
    assert.deepEqual(
      h.gitCalls.find((c) => c[0] === 'tag' && c[1] === '--annotate'),
      tagCreateArgs('docs-v2026.815.0', tagMessage(PLAN)),
    );
    assert.deepEqual(
      h.gitCalls.find((c) => c[0] === 'push'),
      tagPushArgs('docs-v2026.815.0', 'origin'),
    );
    assert.ok(h.remoteTags.has('docs-v2026.815.0'));
    assert.match(h.out.join('\n'), /Pushed docs-v2026\.815\.0/);
  });

  test('aborts and touches no ref on a wrong answer', async () => {
    for (const answer of ['y', 'yes', 'v2026.815.0', 'docs-v2026.815.1', '']) {
      const h = harness({ prompt: async () => answer });
      assert.equal(await main(['cut'], h.io), 1);
      assert.deepEqual(h.gitCalls, [], `${answer} must not tag`);
      assert.equal(h.remoteTags.size, 0);
      assert.match(h.err.join('\n'), /aborted/);
    }
  });

  test('shows the version before prompting', async () => {
    let shownAtPromptTime = null;
    const h = harness({
      prompt: async () => {
        shownAtPromptTime = h.out.join('\n');
        return 'docs-v2026.815.0';
      },
    });
    await main(['cut'], h.io);
    assert.ok(shownAtPromptTime, 'the prompt must have been reached');
    assert.match(shownAtPromptTime, /docs-v2026\.815\.0/);
  });

  test('--yes skips the prompt', async () => {
    const h = harness({ prompt: async () => assert.fail('--yes must not prompt') });
    assert.equal(await main(['cut', '--yes'], h.io), 0);
    assert.ok(h.remoteTags.has('docs-v2026.815.0'));
  });

  test('refuses rather than hanging when there is no tty and no --yes', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('must not prompt without a terminal'),
    });
    assert.equal(await main(['cut'], h.io), 1);
    assert.deepEqual(h.gitCalls, [], 'must not tag');
    assert.match(h.err.join('\n'), /refusing to cut a docs release without a confirmation/);
    assert.ok(h.err.join('\n').includes('--yes'), 'should name the automation escape hatch');
  });

  test('--yes still works without a terminal', async () => {
    const h = harness({ interactive: false });
    assert.equal(await main(['cut', '--yes'], h.io), 0);
    assert.ok(h.remoteTags.has('docs-v2026.815.0'));
  });

  test('a lost race is recomputed, claimed and reported', async () => {
    const h = harness({
      prompt: async () => 'docs-v2026.815.0',
      rejectPush: ['docs-v2026.815.0'],
    });
    assert.equal(await main(['cut'], h.io), 0);
    assert.ok(h.remoteTags.has('docs-v2026.815.1'), 'rolled forward rather than reusing');
    const text = h.out.join('\n');
    assert.match(text, /docs-v2026\.815\.0 was taken while you were reading/);
    assert.match(text, /Claimed docs-v2026\.815\.1/);
  });

  test('three docs cuts in a day leave the CLI line at .0', async () => {
    const h = harness({ prompt: async () => null });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await main(['cut', '--yes'], { ...h.io, tags: [...h.remoteTags] }), 0);
    }
    assert.deepEqual([...h.remoteTags].sort(), [
      'docs-v2026.815.0',
      'docs-v2026.815.1',
      'docs-v2026.815.2',
    ]);
    assert.equal(
      planVersion({ tags: [...h.remoteTags], now: AUG15 }).tag,
      'v2026.815.0',
      'the CLI line must not have moved',
    );
  });
});

describe('status', () => {
  const run = (extra) =>
    JSON.stringify([
      {
        databaseId: 42,
        status: 'completed',
        conclusion: 'success',
        headSha: 'abcdef1234',
        headBranch: 'docs-v2026.815.0',
        createdAt: '2026-08-15T00:00:00Z',
        url: 'https://github.com/yashau/prick/actions/runs/42',
        ...extra,
      },
    ]);

  test('requests the fields the report needs', () => {
    const args = runListArgs(1);
    const fields = args[args.indexOf('--json') + 1];
    for (const f of ['databaseId', 'status', 'conclusion', 'headSha', 'createdAt', 'url']) {
      assert.ok(fields.includes(f), `missing ${f}`);
    }
  });

  test('never passes a ref, tag or push token', () => {
    for (const token of ['tag', 'push', '--ref']) {
      assert.ok(!runListArgs().includes(token), `${token} must not appear`);
    }
  });

  test('reports cleanly when there are no runs yet', async () => {
    const h = harness({ ghResult: '[]' });
    assert.equal(await main(['status'], h.io), 0);
    assert.match(h.out.join('\n'), /no docs-release\.yml runs yet/);
  });

  test('exits non-zero when the last run failed', async () => {
    const h = harness({ ghResult: run({ conclusion: 'failure' }) });
    assert.equal(await main(['status'], h.io), 1);
    assert.match(h.err.join('\n'), /finished with: failure/);
  });

  test('exits zero when the last run succeeded', async () => {
    const h = harness({ ghResult: run() });
    assert.equal(await main(['status'], h.io), 0);
    assert.match(h.out.join('\n'), /#42/);
  });

  test('watches a run that is still going', async () => {
    const h = harness({ ghResult: run({ status: 'in_progress', conclusion: null }) });
    assert.equal(await main(['status'], h.io), 0);
    assert.deepEqual(h.ghCalls[1], ['run', 'watch', '42', '--exit-status']);
  });

  test('does not crash on malformed gh output', async () => {
    const h = harness({ ghResult: '<html>rate limited</html>' });
    assert.equal(await main(['status'], h.io), 1);
    assert.match(h.err.join('\n'), /could not parse/);
  });
});

describe('argument handling', () => {
  test('rejects an unknown command and touches nothing', async () => {
    const h = harness();
    assert.equal(await main(['publish'], h.io), 1);
    assert.deepEqual(h.gitCalls, []);
    assert.deepEqual(h.ghCalls, []);
    assert.match(h.err.join('\n'), /unknown command/);
  });

  test('the old `deploy` command is gone rather than silently aliased', async () => {
    const h = harness();
    assert.equal(await main(['deploy'], h.io), 1);
    assert.match(h.err.join('\n'), /unknown command/);
  });

  test('rejects no command at all', async () => {
    const h = harness();
    assert.equal(await main([], h.io), 1);
    assert.match(h.out.join('\n'), /next/);
  });

  test('--help exits zero', async () => {
    const h = harness();
    assert.equal(await main(['next', '--help'], h.io), 0);
  });
});
