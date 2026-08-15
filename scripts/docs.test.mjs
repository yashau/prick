import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WORKFLOW, isConfirmed, main, runListArgs, workflowRunArgs } from './docs.mjs';

/** Collects output and records the gh invocations instead of running them. */
function harness({ ghResult = '', isTty = true, answer = 'y' } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  return {
    calls,
    out,
    err,
    io: {
      gh: (args) => {
        calls.push(args);
        return ghResult;
      },
      log: (l) => out.push(l),
      logErr: (l) => err.push(l),
      prompt: async () => answer,
      isTty,
    },
  };
}

describe('workflow arguments', () => {
  it('dispatches the docs workflow, not the release one', () => {
    assert.equal(WORKFLOW, 'deploy-docs.yml');
    assert.deepEqual(workflowRunArgs(), ['workflow', 'run', 'deploy-docs.yml']);
  });

  it('never passes a ref, tag or push token', () => {
    // Deployment must not move any git ref; the workflow builds from main.
    const forbidden = ['tag', 'push', '--ref', 'ref'];
    for (const args of [workflowRunArgs(), runListArgs()]) {
      for (const token of forbidden) {
        assert.ok(!args.includes(token), `${token} must not appear in ${args.join(' ')}`);
      }
    }
  });

  it('requests the fields status reporting needs', () => {
    const args = runListArgs(1);
    const fields = args[args.indexOf('--json') + 1];
    for (const f of ['databaseId', 'status', 'conclusion', 'headSha', 'createdAt']) {
      assert.ok(fields.includes(f), `missing ${f}`);
    }
  });
});

describe('confirmation', () => {
  it('accepts y and yes in any case', () => {
    for (const v of ['y', 'Y', 'yes', 'YES', ' yes ']) assert.equal(isConfirmed(v), true);
  });

  it('rejects everything else, including empty', () => {
    for (const v of ['', 'n', 'no', 'sure', 'yep', undefined, null]) {
      assert.equal(isConfirmed(v), false);
    }
  });
});

describe('deploy', () => {
  it('dispatches once confirmed', async () => {
    const h = harness({ answer: 'y' });
    const code = await main(['deploy'], h.io);
    assert.equal(code, 0);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], workflowRunArgs());
  });

  it('dispatches nothing when the answer is no', async () => {
    const h = harness({ answer: 'n' });
    const code = await main(['deploy'], h.io);
    assert.equal(code, 1);
    assert.equal(h.calls.length, 0);
  });

  it('refuses rather than hanging when there is no tty and no --yes', async () => {
    const h = harness({ isTty: false });
    const code = await main(['deploy'], h.io);
    assert.equal(code, 1);
    assert.equal(h.calls.length, 0, 'must not dispatch');
    assert.ok(h.err.join('\n').includes('--yes'), 'should name the automation escape hatch');
  });

  it('honours --yes with no tty', async () => {
    const h = harness({ isTty: false });
    const code = await main(['deploy', '--yes'], h.io);
    assert.equal(code, 0);
    assert.equal(h.calls.length, 1);
  });
});

describe('status', () => {
  it('reports cleanly when there are no runs yet', async () => {
    const h = harness({ ghResult: '[]' });
    const code = await main(['status'], h.io);
    assert.equal(code, 0);
    assert.ok(h.out.join('\n').includes('no deploy-docs.yml runs yet'));
  });

  it('exits non-zero when the last run failed', async () => {
    const h = harness({
      ghResult: JSON.stringify([
        {
          databaseId: 42,
          status: 'completed',
          conclusion: 'failure',
          headSha: 'abcdef1234',
          createdAt: '2026-08-15T00:00:00Z',
        },
      ]),
    });
    assert.equal(await main(['status'], h.io), 1);
  });

  it('exits zero when the last run succeeded', async () => {
    const h = harness({
      ghResult: JSON.stringify([
        {
          databaseId: 43,
          status: 'completed',
          conclusion: 'success',
          headSha: 'abcdef1234',
          createdAt: '2026-08-15T00:00:00Z',
        },
      ]),
    });
    assert.equal(await main(['status'], h.io), 0);
  });

  it('does not crash on unparseable gh output', async () => {
    const h = harness({ ghResult: '<html>rate limited</html>' });
    assert.equal(await main(['status'], h.io), 1);
    assert.ok(h.err.join('\n').includes('could not parse'));
  });
});

describe('argument handling', () => {
  it('rejects an unknown command with the usage exit code', async () => {
    const h = harness();
    assert.equal(await main(['publish'], h.io), 2);
    assert.equal(h.calls.length, 0);
  });

  it('rejects no command at all', async () => {
    const h = harness();
    assert.equal(await main([], h.io), 2);
  });
});
