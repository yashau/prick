// scripts/release.test.mjs — node:test + node:assert only.
//
// Every effect is injected, so nothing here invokes gh, git or a terminal.

import assert from 'node:assert/strict';
import os from 'node:os';
import test, { describe } from 'node:test';

import { PARENT_PACKAGE, PLATFORMS } from './npm-package.mjs';
import {
  WORKFLOW,
  confirmationToken,
  formatCutSummary,
  formatPlanSummary,
  isConfirmed,
  main,
  publishedPackages,
  workflowRunArgs,
} from './release.mjs';
import { planVersion } from './version.mjs';

const AUG15 = new Date('2026-08-15T12:00:00Z');
const PLAN = planVersion({ tags: [], now: AUG15 });

/** A recorder for the injected effects. */
function harness(overrides = {}) {
  const out = [];
  const err = [];
  const dispatched = [];
  return {
    out,
    err,
    dispatched,
    io: {
      log: (s) => out.push(s),
      logErr: (s) => err.push(s),
      gh: (args, options) => {
        dispatched.push(args);
        return overrides.ghResult ?? '';
      },
      tags: overrides.tags ?? [],
      now: overrides.now ?? AUG15,
      interactive: overrides.interactive ?? true,
      prompt: overrides.prompt ?? (async () => ''),
      root: os.tmpdir(),
    },
  };
}

describe('the published set', () => {
  test('is nine packages: eight platforms plus the parent', () => {
    const packages = publishedPackages();
    assert.equal(packages.length, 9);
    assert.equal(new Set(packages).size, 9);
    assert.equal(packages.length, PLATFORMS.length + 1);
  });

  test('puts the parent last, because `latest` moves last', () => {
    assert.equal(publishedPackages().at(-1), PARENT_PACKAGE);
    assert.equal(publishedPackages().indexOf(PARENT_PACKAGE), 8);
  });
});

describe('the workflow dispatch arguments', () => {
  test('dry and real differ only in the dry_run input', () => {
    assert.deepEqual(workflowRunArgs(true), ['workflow', 'run', WORKFLOW, '-f', 'dry_run=true']);
    assert.deepEqual(workflowRunArgs(false), ['workflow', 'run', WORKFLOW, '-f', 'dry_run=false']);
  });

  test('never contain a tag, push or ref subcommand', () => {
    for (const args of [workflowRunArgs(true), workflowRunArgs(false)]) {
      const joined = args.join(' ');
      for (const forbidden of ['tag', 'push', 'ref']) {
        assert.doesNotMatch(joined, new RegExp(`\\b${forbidden}\\b`), `${joined} must not ${forbidden}`);
      }
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
  test('the preview shows semver, human CalVer and the tag', () => {
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

  test('the cut summary names all nine packages before the prompt', () => {
    const text = formatCutSummary(PLAN).join('\n');
    for (const name of publishedPackages()) assert.ok(text.includes(name), `missing ${name}`);
    assert.match(text, /not undoable/);
    assert.match(text, /immutable/);
    assert.match(text, /pushed by the workflow, not by this command/);
  });
});

describe('preview', () => {
  test('works at zero tags and dispatches nothing', async () => {
    const h = harness({ tags: [] });
    assert.equal(await main(['preview'], h.io), 0);
    assert.deepEqual(h.dispatched, []);
    const text = h.out.join('\n');
    assert.match(text, /2026\.815\.0/);
    assert.match(text, /2026\.08\.15\.0/);
    assert.match(text, /v2026\.815\.0/);
  });

  test('never prompts, even without a terminal', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('preview must not prompt'),
    });
    assert.equal(await main(['preview'], h.io), 0);
  });

  test('counts existing tags for the day', async () => {
    const h = harness({ tags: ['v2026.815.0', 'v2026.815.1'] });
    await main(['preview'], h.io);
    assert.match(h.out.join('\n'), /2026\.815\.2/);
  });
});

describe('dry', () => {
  test('dispatches with dry_run=true and never prompts', async () => {
    const h = harness({ prompt: async () => assert.fail('dry must not prompt') });
    assert.equal(await main(['dry'], h.io), 0);
    assert.deepEqual(h.dispatched, [workflowRunArgs(true)]);
  });
});

describe('cut', () => {
  test('dispatches only after the tag is typed exactly', async () => {
    const h = harness({ prompt: async () => 'v2026.815.0' });
    assert.equal(await main(['cut'], h.io), 0);
    assert.deepEqual(h.dispatched, [workflowRunArgs(false)]);
  });

  test('aborts and dispatches nothing on a wrong answer', async () => {
    for (const answer of ['yes', 'v2026.815.1', '']) {
      const h = harness({ prompt: async () => answer });
      assert.equal(await main(['cut'], h.io), 1);
      assert.deepEqual(h.dispatched, [], `${answer} must not dispatch`);
      assert.match(h.err.join('\n'), /aborted/);
    }
  });

  test('shows the version and all nine packages before prompting', async () => {
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
    assert.deepEqual(h.dispatched, [workflowRunArgs(false)]);
  });

  test('refuses to dispatch when there is no terminal and no --yes', async () => {
    const h = harness({
      interactive: false,
      prompt: async () => assert.fail('must not prompt without a terminal'),
    });
    assert.equal(await main(['cut'], h.io), 1);
    assert.deepEqual(h.dispatched, []);
    assert.match(h.err.join('\n'), /refusing to cut a release without a confirmation/);
  });

  test('--yes still works without a terminal', async () => {
    const h = harness({ interactive: false });
    assert.equal(await main(['cut', '--yes'], h.io), 0);
    assert.deepEqual(h.dispatched, [workflowRunArgs(false)]);
  });
});

describe('status', () => {
  const run = (extra) => JSON.stringify([{
    databaseId: 42,
    status: 'completed',
    conclusion: 'success',
    displayTitle: 'Release',
    headBranch: 'main',
    createdAt: '2026-08-15T12:00:00Z',
    url: 'https://github.com/yashau/prick/actions/runs/42',
    ...extra,
  }]);

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
    assert.match(h.out.join('\n'), /no release\.yml runs yet/);
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
  test('an unknown command exits non-zero and dispatches nothing', async () => {
    const h = harness();
    assert.equal(await main(['ship-it'], h.io), 1);
    assert.deepEqual(h.dispatched, []);
    assert.match(h.err.join('\n'), /unknown command/);
  });

  test('no command prints usage and exits non-zero', async () => {
    const h = harness();
    assert.equal(await main([], h.io), 1);
    assert.match(h.out.join('\n'), /preview/);
  });

  test('--help exits zero', async () => {
    const h = harness();
    assert.equal(await main(['preview', '--help'], h.io), 0);
  });
});
