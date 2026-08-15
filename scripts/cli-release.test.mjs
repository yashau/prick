// scripts/cli-release.test.mjs — node:test + node:assert only.
//
// Every effect is injected, so nothing here invokes gh, git or a terminal. In
// particular `cut` now creates and pushes a tag, and the git that does it is a
// fake: these tests never touch a ref.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  TAG_GLOB,
  TAG_PREFIX,
  WORKFLOW,
  confirmationToken,
  formatCutSummary,
  formatPlanSummary,
  isConfirmed,
  main,
  publishedPackages,
  tagMessage,
  workflowRunArgs,
} from './cli-release.mjs';
import { MCP_PACKAGE, PARENT_PACKAGE, PLATFORMS } from './npm-package.mjs';
import { planVersion, tagCreateArgs, tagPushArgs } from './version.mjs';

const AUG15 = new Date('2026-08-15T12:00:00Z');
const PLAN = planVersion({ tags: [], now: AUG15 });

/**
 * An in-memory git, plus recorders for every other effect.
 *
 * `remote` is the shared truth; `local` is this clone's view, refreshed only by
 * a fetch. `rejectPush` simulates losing the compare-and-swap.
 */
function harness(overrides = {}) {
  const out = [];
  const err = [];
  const dispatched = [];
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
    dispatched,
    gitCalls,
    remoteTags,
    localTags,
    io: {
      log: (s) => out.push(s),
      logErr: (s) => err.push(s),
      gh: (args, _options) => {
        dispatched.push(args);
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

describe('the published set', () => {
  test('is ten packages: eight platforms, the MCP server, and the parent', () => {
    const packages = publishedPackages();
    assert.equal(packages.length, 10);
    assert.equal(new Set(packages).size, 10);
    assert.equal(packages.length, PLATFORMS.length + 2);
    assert.ok(packages.includes(MCP_PACKAGE), 'the MCP server must be published too');
  });

  test('puts the parent last, because `latest` moves last', () => {
    assert.equal(publishedPackages().at(-1), PARENT_PACKAGE);
    assert.equal(publishedPackages().indexOf(PARENT_PACKAGE), 9);
  });

  test('publishes the MCP server before the parent, and never as a platform', () => {
    const packages = publishedPackages();
    assert.ok(packages.indexOf(MCP_PACKAGE) < packages.indexOf(PARENT_PACKAGE));
    // It is an independent package, not one of the eight binary carriers: a
    // platform name would put it into the parent's optionalDependencies.
    assert.equal(
      PLATFORMS.some((p) => p.name === MCP_PACKAGE),
      false,
    );
  });
});

describe('the release line', () => {
  test('is the `v` prefix and the CLI workflow', () => {
    assert.equal(TAG_PREFIX, 'v');
    assert.equal(TAG_GLOB, 'v*');
    assert.equal(WORKFLOW, 'cli-release.yml');
  });

  test('the workflow triggers on that tag glob and not on a branch push', () => {
    const yaml = readFileSync(
      path.join(import.meta.dirname, '..', '.github', 'workflows', WORKFLOW),
      'utf8',
    );
    assert.match(yaml, /^on:\n\s+push:\n\s+tags:\n\s+-\s+"v\*"$/m);
    assert.doesNotMatch(yaml, /^\s+branches:/m, 'a branch push must not release');
  });

  test('the workflow no longer claims a version', () => {
    const yaml = readFileSync(
      path.join(import.meta.dirname, '..', '.github', 'workflows', WORKFLOW),
      'utf8',
    );
    // The tag is pushed by cli:cut now. Nothing in CI may move a ref.
    assert.doesNotMatch(yaml, /git push origin "refs\/tags/);
    assert.doesNotMatch(yaml, /persist-credentials: true/);
  });
});

describe('the dry-run dispatch arguments', () => {
  test('dry passes dry_run=true', () => {
    assert.deepEqual(workflowRunArgs(true), ['workflow', 'run', WORKFLOW, '-f', 'dry_run=true']);
  });

  test('never contain a tag, push or ref subcommand', () => {
    const joined = workflowRunArgs(true).join(' ');
    for (const forbidden of ['tag', 'push', 'ref']) {
      assert.doesNotMatch(
        joined,
        new RegExp(`\\b${forbidden}\\b`),
        `${joined} must not ${forbidden}`,
      );
    }
  });
});

describe('confirmation', () => {
  test('the token is the tag, not "yes"', () => {
    assert.equal(confirmationToken(PLAN), 'v2026.815.0');
  });

  test('accepts the exact tag, tolerating surrounding whitespace', () => {
    assert.equal(isConfirmed('v2026.815.0', PLAN), true);
    assert.equal(isConfirmed('  v2026.815.0\n', PLAN), true);
  });

  test('rejects everything else, including yes and the bare version', () => {
    for (const bad of ['yes', 'y', 'Y', '', '2026.815.0', 'v2026.815.1', 'V2026.815.0', null]) {
      assert.equal(isConfirmed(bad, PLAN), false, `${JSON.stringify(bad)} must not confirm`);
    }
  });
});

describe('summaries', () => {
  test('the plan shows semver, human CalVer and the tag', () => {
    const text = formatPlanSummary(PLAN).join('\n');
    assert.match(text, /version {3}2026\.815\.0/);
    assert.match(text, /calver {4}2026\.08\.15\.0/);
    assert.match(text, /tag {7}v2026\.815\.0/);
    assert.match(text, /\(UTC\)/);
  });

  test('N = 0 is called out as the first release of the day', () => {
    assert.match(formatPlanSummary(PLAN).join('\n'), /N {9}0 {2}\(first release today\)/);
    const second = planVersion({ tags: ['v2026.815.0'], now: AUG15 });
    assert.doesNotMatch(formatPlanSummary(second).join('\n'), /first release today/);
  });

  test('the cut summary names all ten packages and says the push is the trigger', () => {
    const text = formatCutSummary(PLAN).join('\n');
    for (const name of publishedPackages()) assert.ok(text.includes(name), `missing ${name}`);
    assert.match(text, /not undoable/);
    assert.match(text, /immutable/);
    assert.match(text, /pushes the tag v2026\.815\.0/);
    assert.match(text, /Nothing else does/);
  });

  test('the tag message carries the human CalVer', () => {
    assert.match(tagMessage(PLAN), /^v2026\.815\.0\n/);
    assert.match(tagMessage(PLAN), /2026\.08\.15\.0/);
  });
});

describe('next', () => {
  test('works at zero tags and touches nothing', async () => {
    const h = harness({ tags: [] });
    assert.equal(await main(['next'], h.io), 0);
    assert.deepEqual(h.dispatched, []);
    assert.deepEqual(h.gitCalls, []);
    const text = h.out.join('\n');
    assert.match(text, /2026\.815\.0/);
    assert.match(text, /2026\.08\.15\.0/);
    assert.match(text, /v2026\.815\.0/);
  });

  test('never prompts, even without a terminal', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('next must not prompt'),
    });
    assert.equal(await main(['next'], h.io), 0);
  });

  test('counts existing CLI tags for the day and ignores docs tags', async () => {
    const h = harness({ tags: ['v2026.815.0', 'v2026.815.1', 'docs-v2026.815.0'] });
    await main(['next'], h.io);
    assert.match(h.out.join('\n'), /v2026\.815\.2/);
  });
});

describe('dry', () => {
  test('dispatches with dry_run=true, never prompts and never tags', async () => {
    const h = harness({ prompt: async () => assert.fail('dry must not prompt') });
    assert.equal(await main(['dry'], h.io), 0);
    assert.deepEqual(h.dispatched, [workflowRunArgs(true)]);
    assert.deepEqual(h.gitCalls, [], 'a dry run claims no version');
  });
});

describe('cut', () => {
  test('tags and pushes only after the tag is typed exactly', async () => {
    const h = harness({ prompt: async () => 'v2026.815.0' });
    assert.equal(await main(['cut'], h.io), 0);
    assert.deepEqual(h.dispatched, [], 'the tag push is the trigger; nothing is dispatched');
    assert.ok(
      h.gitCalls.some((c) => c[0] === 'tag' && c[1] === '--annotate'),
      'an annotated tag is created',
    );
    assert.deepEqual(
      h.gitCalls.find((c) => c[0] === 'push'),
      tagPushArgs('v2026.815.0', 'origin'),
    );
    assert.ok(h.remoteTags.has('v2026.815.0'));
    assert.match(h.out.join('\n'), /Pushed v2026\.815\.0/);
  });

  test('the annotated tag carries the release message', async () => {
    const h = harness({ prompt: async () => 'v2026.815.0' });
    await main(['cut'], h.io);
    const create = h.gitCalls.find((c) => c[0] === 'tag' && c[1] === '--annotate');
    assert.deepEqual(create, tagCreateArgs('v2026.815.0', tagMessage(PLAN)));
  });

  test('aborts and touches no ref on a wrong answer', async () => {
    for (const answer of ['yes', 'v2026.815.1', '']) {
      const h = harness({ prompt: async () => answer });
      assert.equal(await main(['cut'], h.io), 1);
      assert.deepEqual(h.gitCalls, [], `${answer} must not tag`);
      assert.equal(h.remoteTags.size, 0);
      assert.match(h.err.join('\n'), /aborted/);
    }
  });

  test('shows the version and all ten packages before prompting', async () => {
    let shownAtPromptTime = null;
    const h = harness({
      prompt: async () => {
        shownAtPromptTime = h.out.join('\n');
        return 'v2026.815.0';
      },
    });
    await main(['cut'], h.io);
    assert.ok(shownAtPromptTime, 'the prompt must have been reached');
    assert.match(shownAtPromptTime, /2026\.815\.0/);
    for (const name of publishedPackages()) assert.ok(shownAtPromptTime.includes(name));
  });

  test('--yes skips the prompt', async () => {
    const h = harness({ prompt: async () => assert.fail('--yes must not prompt') });
    assert.equal(await main(['cut', '--yes'], h.io), 0);
    assert.ok(h.remoteTags.has('v2026.815.0'));
  });

  test('refuses to cut when there is no terminal and no --yes', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('must not prompt without a terminal'),
    });
    assert.equal(await main(['cut'], h.io), 1);
    assert.deepEqual(h.gitCalls, []);
    assert.match(h.err.join('\n'), /refusing to cut a release without a confirmation/);
    assert.match(h.err.join('\n'), /--yes/);
  });

  test('--yes still works without a terminal', async () => {
    const h = harness({ interactive: false });
    assert.equal(await main(['cut', '--yes'], h.io), 0);
    assert.ok(h.remoteTags.has('v2026.815.0'));
  });

  test('a lost race is recomputed, claimed and reported', async () => {
    const h = harness({ prompt: async () => 'v2026.815.0', rejectPush: ['v2026.815.0'] });
    assert.equal(await main(['cut'], h.io), 0);
    assert.ok(h.remoteTags.has('v2026.815.1'), 'rolled forward rather than reusing');
    const text = h.out.join('\n');
    assert.match(text, /v2026\.815\.0 was taken while you were reading/);
    assert.match(text, /Claimed v2026\.815\.1/);
  });

  test('the docs line is invisible to a CLI cut', async () => {
    const h = harness({
      tags: ['docs-v2026.815.0', 'docs-v2026.815.1', 'docs-v2026.815.2'],
      prompt: async () => 'v2026.815.0',
    });
    assert.equal(await main(['cut'], h.io), 0);
    assert.ok(h.remoteTags.has('v2026.815.0'), 'three docs cuts do not push the CLI to .3');
  });
});

describe('status', () => {
  const run = (extra) =>
    JSON.stringify([
      {
        databaseId: 42,
        status: 'completed',
        conclusion: 'success',
        displayTitle: 'CLI release',
        headBranch: 'v2026.815.0',
        createdAt: '2026-08-15T12:00:00Z',
        url: 'https://github.com/yashau/prick/actions/runs/42',
        ...extra,
      },
    ]);

  test('reports a completed successful run and watches nothing', async () => {
    const h = harness({ ghResult: run() });
    assert.equal(await main(['status'], h.io), 0);
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.dispatched[0][0], 'run');
    assert.equal(h.dispatched[0][1], 'list');
    assert.match(h.out.join('\n'), /#42/);
  });

  test('exits non-zero when the last run failed', async () => {
    const h = harness({ ghResult: run({ conclusion: 'failure' }) });
    assert.equal(await main(['status'], h.io), 1);
    assert.match(h.err.join('\n'), /finished with: failure/);
  });

  test('watches a run that is still going', async () => {
    const h = harness({ ghResult: run({ status: 'in_progress', conclusion: null }) });
    assert.equal(await main(['status'], h.io), 0);
    assert.deepEqual(h.dispatched[1], ['run', 'watch', '42', '--exit-status']);
  });

  test('is calm when there are no runs yet', async () => {
    const h = harness({ ghResult: '[]' });
    assert.equal(await main(['status'], h.io), 0);
    assert.match(h.out.join('\n'), /no cli-release\.yml runs yet/);
  });

  test('does not crash on malformed gh output', async () => {
    const h = harness({ ghResult: '<html>rate limited</html>' });
    assert.equal(await main(['status'], h.io), 1);
    assert.match(h.err.join('\n'), /could not parse/);
  });

  test('never prompts', async () => {
    const h = harness({
      ghResult: run(),
      interactive: false,
      prompt: async () => assert.fail('status must not prompt'),
    });
    assert.equal(await main(['status'], h.io), 0);
  });
});

describe('the CLI surface', () => {
  test('an unknown command exits non-zero and touches nothing', async () => {
    const h = harness();
    assert.equal(await main(['ship-it'], h.io), 1);
    assert.deepEqual(h.dispatched, []);
    assert.deepEqual(h.gitCalls, []);
    assert.match(h.err.join('\n'), /unknown command/);
  });

  test('the old `preview` name is gone rather than silently aliased', async () => {
    const h = harness();
    assert.equal(await main(['preview'], h.io), 1);
    assert.match(h.err.join('\n'), /unknown command/);
  });

  test('no command prints usage and exits non-zero', async () => {
    const h = harness();
    assert.equal(await main([], h.io), 1);
    assert.match(h.out.join('\n'), /next/);
  });

  test('--help exits zero', async () => {
    const h = harness();
    assert.equal(await main(['next', '--help'], h.io), 0);
  });
});
