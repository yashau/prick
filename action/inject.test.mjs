// action/inject.test.mjs — node:test + node:assert only, no dependencies.
//
// Every effect is injected, so nothing here spawns npm, spawns the CLI, writes
// to a file or writes to a stream. The `$GITHUB_ENV` block the action would
// have written is instead parsed back the way the runner parses it, and
// compared with the input -- because "the value survived" is the only assertion
// that actually matters, and it is the one a hand-checked expected string
// quietly fails to make.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ActionError,
  CLI_ARGS,
  CLI_PACKAGE,
  DELIMITER_PREFIX,
  assertSafeVersionSpec,
  chooseDelimiter,
  commandInject,
  commandInstall,
  describeExit,
  escapeData,
  installArgs,
  isUnsafeName,
  isValidEnvName,
  main,
  maskPayloads,
  parseBoolean,
  parseKeyList,
  parseSecrets,
  planInjection,
  renderAssignment,
  resolveVersionSpec,
  validateExportTo,
  validatePrefix,
  validateUrl,
} from './inject.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Records every effect in issue order, so tests can assert on ordering as well
 * as on content -- masking before writing is a property of the ORDER.
 */
function harness() {
  /** @type {{ kind: string, name?: string, text: string }[]} */
  const events = [];
  return {
    events,
    io: {
      command: (name, message) => events.push({ kind: 'command', name, text: message }),
      log: (line) => events.push({ kind: 'log', text: line }),
      appendEnv: (text) => events.push({ kind: 'env', text }),
      appendOutput: (text) => events.push({ kind: 'output', text }),
    },
    of: (kind) => events.filter((e) => e.kind === kind),
    commands: (name) => events.filter((e) => e.kind === 'command' && e.name === name),
    env: () =>
      events
        .filter((e) => e.kind === 'env')
        .map((e) => e.text)
        .join(''),
    output: () =>
      events
        .filter((e) => e.kind === 'output')
        .map((e) => e.text)
        .join(''),
  };
}

/** A spawn that returns a canned result and records how it was called. */
function fakeSpawn(result = {}, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0, stdout: '', stderr: '', ...result };
  };
}

/**
 * Deterministic bytes. Each call returns a different constant, so delimiters
 * are predictable and a collision can be forced.
 */
function fakeRandom(sequence = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]) {
  let index = 0;
  return (size) => Buffer.alloc(size, sequence[Math.min(index++, sequence.length - 1)]);
}

/** The delimiter `fakeRandom` produces on its nth call (zero-based). */
function nthDelimiter(n, sequence) {
  const random = fakeRandom(sequence);
  let value = '';
  for (let i = 0; i <= n; i += 1) {
    value = `${DELIMITER_PREFIX}${random(16).toString('hex')}__`;
  }
  return value;
}

/**
 * Parses a `$GITHUB_ENV` file the way the runner does: a `NAME<<DELIM` line,
 * then the value, then a line equal to the delimiter.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseEnvFile(text) {
  const parsed = new Map();
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    if (lines[index] === '') {
      index += 1;
      continue;
    }
    const match = /^([^=<\n]+)<<(.+)$/.exec(lines[index]);
    assert.ok(match, `unparsable assignment line: ${JSON.stringify(lines[index])}`);
    const [, name, delimiter] = match;
    index += 1;

    const body = [];
    while (index < lines.length && lines[index] !== delimiter) {
      body.push(lines[index]);
      index += 1;
    }
    assert.ok(index < lines.length, `heredoc for ${name} was never closed`);
    parsed.set(name, body.join('\n'));
    index += 1;
  }

  return parsed;
}

const TOKEN = {
  PRICK_INPUT_URL: 'https://prick.example.com',
  PRICK_INPUT_CLIENT_ID: 'e367826f93b8d71185e03fe518aff3b4.access',
  PRICK_INPUT_CLIENT_SECRET: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  PRICK_INPUT_PROJECT: 'api',
};

/**
 * Runs `commandInject` against a canned secret set.
 *
 * @param {Record<string, string>} secrets
 * @param {Record<string, string>} [inputs]
 */
function inject(secrets, inputs = {}) {
  const h = harness();
  const calls = [];
  const code = commandInject({
    env: { ...TOKEN, ...inputs },
    io: h.io,
    spawn: fakeSpawn({ stdout: JSON.stringify(secrets) }, calls),
    random: fakeRandom(),
  });
  return { ...h, code, calls, injected: parseEnvFile(h.env()) };
}

// ---------------------------------------------------------------------------
// The audit that gives the rest of the suite its meaning
// ---------------------------------------------------------------------------

describe('the source itself', () => {
  const source = fs.readFileSync(path.join(HERE, 'inject.mjs'), 'utf8');

  /**
   * @param {string} needle
   * @returns {number}
   */
  const count = (needle) => source.split(needle).length - 1;

  test('writes to stdout in exactly one place', () => {
    // That one place is `realIo().command`, which escapes its argument and is
    // how `::add-mask::` is issued. If this number ever becomes 2, a second
    // route to the log exists and the masking guarantee is no longer local.
    assert.equal(count('process.stdout.write('), 1);
  });

  test('writes to stderr in exactly one place, and never with console.log', () => {
    assert.equal(count('console.error('), 1);
    assert.equal(count('process.stderr.write('), 0);
    for (const banned of ['console.log(', 'console.info(', 'console.warn(', 'console.debug(']) {
      assert.equal(count(banned), 0, `${banned} is a route to the log that nothing audits`);
    }
  });

  test('has LF line endings and no tabs', () => {
    assert.equal(count('\r'), 0);
    assert.equal(count('\t'), 0);
  });
});

describe('the whole flow', () => {
  test('never lets a value reach anything but a mask command and the env file', () => {
    const value = 'sentinel-a4f1c9-value';
    const result = inject({ DATABASE_URL: value });

    for (const event of result.events) {
      const isMask = event.kind === 'command' && event.name === 'add-mask';
      const isEnvFile = event.kind === 'env';
      if (!isMask && !isEnvFile) {
        assert.ok(
          !event.text.includes(value),
          `a ${event.kind} carried the value: ${JSON.stringify(event.text)}`,
        );
      }
    }
    assert.equal(result.injected.get('DATABASE_URL'), value);
  });

  test('masks every value before anything is written', () => {
    const result = inject({ A: 'one', B: 'two' });
    const lastMask = result.events.findLastIndex((e) => e.name === 'add-mask');
    const firstWrite = result.events.findIndex((e) => e.kind === 'env' || e.kind === 'output');

    assert.ok(lastMask >= 0, 'nothing was masked');
    assert.ok(firstWrite >= 0, 'nothing was written');
    assert.ok(lastMask < firstWrite, 'a value was written before it was masked');
  });

  test('reports names, counts and nothing else on the log', () => {
    const result = inject({ DATABASE_URL: 'postgres://u:p@h/db', API_KEY: 'sk-live-1' });
    const log = result
      .of('log')
      .map((e) => e.text)
      .join('\n');
    assert.match(log, /Injected 2 secret\(s\)/);
    assert.match(log, /API_KEY, DATABASE_URL/);
    assert.ok(!log.includes('sk-live-1'));
    assert.ok(!log.includes('postgres://'));
  });
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe('a value survives the round trip when it', () => {
  /**
   * @param {string} label
   * @param {string} value
   */
  const survives = (label, value) => {
    test(label, () => {
      assert.equal(inject({ SECRET: value }).injected.get('SECRET'), value);
    });
  };

  survives('is ordinary', 'hunter2');
  survives('is empty', '');
  survives('is a single space', ' ');
  survives('spans several lines', '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----');
  survives('ends with a newline', 'trailing\n');
  survives('starts with a newline', '\nleading');
  survives('is nothing but newlines', '\n\n\n');
  survives('contains an equals sign', 'key=value=more');
  survives('is itself a KEY=VALUE assignment', 'INJECTED=yes');
  survives('contains a lone carriage return', 'a\rb');
  survives('contains CRLF', 'a\r\nb');
  survives('is unicode', 'café 日本語 🔑 Ω');
  survives('is unicode across lines', 'первая\nвторая 🔑');
  survives('contains shell metacharacters', '$(id) `id` ${HOME} \\ ! & ; | > < * ? ~ #');
  survives('contains a percent sign', '100%%0A%0D%25');
  survives('contains a JSON document', '{"nested": "value", "n": [1, 2]}');
  survives('is very long', 'x'.repeat(100_000));

  test('is a line that looks like a heredoc terminator', () => {
    const value = `not-the-end\n${DELIMITER_PREFIX}deadbeef__\nstill-going`;
    assert.equal(inject({ SECRET: value }).injected.get('SECRET'), value);
  });
});

describe('the heredoc delimiter', () => {
  test('is a fresh random one per run', () => {
    const first = inject({ A: '1' }).env();
    const second = inject({ A: '1' }).env();
    const delimiterOf = (text) => /<<(\S+)/.exec(text)[1];
    // Both runs use the same fake RNG, so equality here proves only that the
    // delimiter comes FROM the RNG; the real one is crypto.randomBytes.
    assert.equal(delimiterOf(first), delimiterOf(second));
    assert.match(delimiterOf(first), /^__PRICK_EOF_[0-9a-f]{32}__$/);
  });

  test('is regenerated when a value contains it', () => {
    const collision = nthDelimiter(0);
    const values = [`a\n${collision}\nb`];
    const chosen = chooseDelimiter(values, fakeRandom());

    assert.notEqual(chosen, collision);
    assert.equal(chosen, nthDelimiter(1));
    assert.ok(!values[0].includes(chosen));
  });

  test('is regenerated even when the value merely contains it as a substring', () => {
    const collision = nthDelimiter(0);
    const chosen = chooseDelimiter([`prefix${collision}suffix`], fakeRandom());
    assert.notEqual(chosen, collision);
  });

  test('gives up rather than writing a block a value can break out of', () => {
    const always = () => Buffer.alloc(16, 0x11);
    assert.throws(() => chooseDelimiter([nthDelimiter(0)], always), ActionError);
  });

  test('survives end to end when the secret contains the delimiter the RNG offers first', () => {
    const collision = nthDelimiter(0);
    const value = `line1\n${collision}\nline2`;
    const result = inject({ SECRET: value });

    assert.equal(result.injected.get('SECRET'), value);
    assert.ok(!result.env().startsWith(`SECRET<<${collision}\n`));
  });
});

describe('the assignment', () => {
  test('writes the value byte for byte between the delimiters', () => {
    assert.equal(renderAssignment('K', ' padded \n', 'D'), 'K<<D\n padded \n\nD\n');
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe('escapeData', () => {
  test('escapes the three characters that would end or corrupt a command', () => {
    assert.equal(escapeData('a\nb'), 'a%0Ab');
    assert.equal(escapeData('a\rb'), 'a%0Db');
    assert.equal(escapeData('100%'), '100%25');
  });

  test('escapes the percent first, so an escape cannot be double-escaped', () => {
    assert.equal(escapeData('%0A'), '%250A');
    assert.equal(escapeData('%'), '%25');
  });

  test('leaves everything else, including unicode, alone', () => {
    assert.equal(escapeData('café 🔑 $(id) ::'), 'café 🔑 $(id) ::');
  });
});

describe('masking', () => {
  test('masks a single-line value once', () => {
    assert.deepEqual(maskPayloads('hunter2'), ['hunter2']);
  });

  test('masks a multi-line value whole AND line by line', () => {
    // The whole-value mask never matches a log line, and a per-line mask never
    // matches a value logged whole. Both are needed.
    assert.deepEqual(maskPayloads('one\ntwo'), ['one\ntwo', 'one', 'two']);
  });

  test('splits CRLF as one break, not two', () => {
    assert.deepEqual(maskPayloads('one\r\ntwo'), ['one\r\ntwo', 'one', 'two']);
  });

  test('skips blank lines, which the runner ignores and which would redact the log', () => {
    assert.deepEqual(maskPayloads('one\n\n   \ntwo'), ['one\n\n   \ntwo', 'one', 'two']);
  });

  test('has nothing to mask for an empty or whitespace-only value', () => {
    assert.deepEqual(maskPayloads(''), []);
    assert.deepEqual(maskPayloads('   '), []);
    assert.deepEqual(maskPayloads('\n\n'), []);
  });

  test('does not repeat a payload', () => {
    assert.deepEqual(maskPayloads('same\nsame'), ['same\nsame', 'same']);
  });

  test('emits the mask command with the value escaped', () => {
    const result = inject({ KEY: 'line1\nline2' });
    const masks = result.commands('add-mask').map((e) => e.text);
    assert.deepEqual(masks, ['line1\nline2', 'line1', 'line2']);
    // The io under test records the raw message; the real one escapes on the
    // way out. Assert that contract holds where it is implemented.
    assert.equal(escapeData(masks[0]), 'line1%0Aline2');
  });

  test('mask: false injects but warns loudly instead', () => {
    const result = inject({ KEY: 'value' }, { PRICK_INPUT_MASK: 'false' });
    assert.equal(result.commands('add-mask').length, 0);
    assert.match(result.commands('warning')[0].text, /Masking is disabled/);
    assert.equal(result.injected.get('KEY'), 'value');
  });

  test('an unreadable mask input fails rather than defaulting to off', () => {
    // `enabled` plainly means "on". Anything that treated it as "off" because
    // it is not in the accepted list would print every secret in the job.
    const h = harness();
    const code = main(['inject'], {
      env: { ...TOKEN, PRICK_INPUT_MASK: 'enabled' },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{}' }),
    });
    assert.equal(code, 1);
    assert.match(h.commands('error')[0].text, /must be true or false/);
  });
});

describe('parseBoolean', () => {
  test('accepts the spellings a workflow author actually writes', () => {
    for (const yes of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
      assert.equal(parseBoolean(yes, 'x', false), true, yes);
    }
    for (const no of ['false', 'FALSE', '0', 'no', 'off']) {
      assert.equal(parseBoolean(no, 'x', true), false, no);
    }
  });

  test('falls back only when the input is absent', () => {
    assert.equal(parseBoolean('', 'x', true), true);
    assert.equal(parseBoolean(undefined, 'x', false), false);
  });

  test('refuses anything else', () => {
    assert.throws(() => parseBoolean('maybe', 'mask', true), ActionError);
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('key names', () => {
  test('accepts what a POSIX environment accepts', () => {
    for (const name of ['DATABASE_URL', 'A', '_private', 'S3_BUCKET_2', 'lowercase']) {
      assert.ok(isValidEnvName(name), name);
    }
  });

  test('rejects what it does not', () => {
    for (const name of ['', '1FOO', 'FOO-BAR', 'FOO BAR', 'FOO=', 'FOO\nBAR', 'CAFÉ', 'a.b']) {
      assert.ok(!isValidEnvName(name), JSON.stringify(name));
    }
    assert.ok(!isValidEnvName('A'.repeat(257)));
    assert.ok(isValidEnvName('A'.repeat(256)));
  });

  test('is not fooled by a trailing newline', () => {
    assert.ok(!isValidEnvName('FOO\n'));
  });
});

describe('an invalid key name', () => {
  const secrets = {
    GOOD: 'kept',
    'BAD-NAME': 'skipped-value-1',
    '1LEADING': 'skipped-value-2',
    'has space': 'skipped-value-3',
    CAFÉ: 'skipped-value-4',
  };

  test('is skipped, not injected', () => {
    const result = inject(secrets);
    assert.deepEqual([...result.injected.keys()], ['GOOD']);
  });

  test('is warned about by name', () => {
    const warnings = inject(secrets)
      .commands('warning')
      .map((e) => e.text);
    assert.equal(warnings.length, 4);
    for (const key of ['BAD-NAME', '1LEADING', 'has space', 'CAFÉ']) {
      assert.ok(
        warnings.some((w) => w.includes(key)),
        `${key} was skipped without saying so`,
      );
    }
  });

  test('never has its value named', () => {
    const result = inject(secrets);
    for (const event of result.events) {
      if (event.kind === 'command' && event.name === 'add-mask') {
        continue;
      }
      if (event.kind === 'env') {
        continue;
      }
      for (let i = 1; i <= 4; i += 1) {
        assert.ok(!event.text.includes(`skipped-value-${i}`), event.text);
      }
    }
  });

  test('does not stop the valid ones', () => {
    assert.equal(inject(secrets).code, 0);
  });
});

describe('an unsafe name', () => {
  test('covers the loader, the runtime and the runner', () => {
    for (const name of [
      'PATH',
      'NODE_OPTIONS',
      'BASH_ENV',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'PYTHONPATH',
      'GITHUB_ENV',
      'GITHUB_TOKEN',
      'RUNNER_TEMP',
      'ACTIONS_RUNTIME_TOKEN',
    ]) {
      assert.ok(isUnsafeName(name), name);
    }
  });

  test('does not catch names that merely look like one', () => {
    for (const name of ['ld_preload', 'Path', 'PATHS', 'LOAD_BALANCER', 'MY_GITHUB_TOKEN']) {
      assert.ok(!isUnsafeName(name), name);
    }
  });

  test('is skipped with a warning by default', () => {
    const result = inject({ NODE_OPTIONS: '--require ./evil.js', SAFE: 'ok' });
    assert.deepEqual([...result.injected.keys()], ['SAFE']);
    assert.match(result.commands('warning')[0].text, /NODE_OPTIONS/);
  });

  test('is injected when the operator opts in', () => {
    const result = inject(
      { NODE_OPTIONS: '--max-old-space-size=4096' },
      { PRICK_INPUT_ALLOW_UNSAFE_NAMES: 'true' },
    );
    assert.equal(result.injected.get('NODE_OPTIONS'), '--max-old-space-size=4096');
  });

  test('is judged after the prefix is applied, which is what makes a prefix a fix', () => {
    const result = inject({ PATH: 'x' }, { PRICK_INPUT_PREFIX: 'APP_' });
    assert.equal(result.injected.get('APP_PATH'), 'x');
  });
});

describe('the prefix', () => {
  test('is prepended to every name', () => {
    const result = inject({ TOKEN: 't', URL: 'u' }, { PRICK_INPUT_PREFIX: 'APP_' });
    assert.deepEqual([...result.injected.keys()], ['APP_TOKEN', 'APP_URL']);
  });

  test('is optional', () => {
    assert.equal(validatePrefix(''), '');
    assert.equal(validatePrefix(undefined), '');
  });

  test('fails the step rather than skipping every key, when it is unusable', () => {
    // Operator configuration, not data: warning once per key would be noise
    // hiding a single mistake.
    assert.throws(() => validatePrefix('1_'), ActionError);
    assert.throws(() => validatePrefix('my-app-'), ActionError);
  });
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe('the keys allowlist', () => {
  test('splits on newlines and on commas', () => {
    assert.deepEqual(parseKeyList('A\nB'), ['A', 'B']);
    assert.deepEqual(parseKeyList('A,B'), ['A', 'B']);
    assert.deepEqual(parseKeyList(' A , B \n C\n\n'), ['A', 'B', 'C']);
    assert.deepEqual(parseKeyList('A,A,B'), ['A', 'B']);
  });

  test('distinguishes "no allowlist" from "an empty one"', () => {
    assert.equal(parseKeyList(''), null);
    assert.equal(parseKeyList('  \n , '), null);
    assert.equal(parseKeyList(undefined), null);
  });

  test('injects only what it names', () => {
    const result = inject({ A: '1', B: '2', C: '3' }, { PRICK_INPUT_KEYS: 'A\nC' });
    assert.deepEqual([...result.injected.keys()], ['A', 'C']);
  });

  test('fails on a name the environment does not have', () => {
    const h = harness();
    const code = main(['inject'], {
      env: { ...TOKEN, PRICK_INPUT_KEYS: 'A,MISSING_ONE' },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"1"}' }),
    });

    assert.equal(code, 1);
    assert.match(h.commands('error')[0].text, /MISSING_ONE/);
    assert.equal(h.of('env').length, 0, 'nothing may be written when the step fails');
  });

  test('reports every missing name at once, not one per run', () => {
    const plan = planInjection({
      secrets: new Map([['A', '1']]),
      allowlist: ['A', 'X', 'Y'],
      prefix: '',
    });
    assert.deepEqual(plan.missing, ['X', 'Y']);
    assert.deepEqual(
      plan.entries.map((e) => e.name),
      ['A'],
    );
  });

  test('still skips an invalid name it happens to list', () => {
    const plan = planInjection({
      secrets: new Map([['BAD-NAME', 'v']]),
      allowlist: ['BAD-NAME'],
      prefix: '',
    });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].key, 'BAD-NAME');
  });
});

// ---------------------------------------------------------------------------
// The CLI's output and exit status
// ---------------------------------------------------------------------------

describe('the CLI invocation', () => {
  test('puts no user data in the argument vector', () => {
    // The premise the Windows `shell: true` path rests on.
    for (const argument of CLI_ARGS) {
      assert.match(argument, /^[a-z-]+$/, argument);
    }
  });

  test('asks for JSON and never prompts', () => {
    assert.deepEqual(CLI_ARGS, ['secrets', 'download', '--format', 'json', '--no-input']);
  });

  test('passes the URL, project, environment and token through the environment', () => {
    const result = inject({ A: '1' }, { PRICK_INPUT_ENVIRONMENT: 'staging' });
    const { env } = result.calls[0].options;

    assert.equal(env.PRK_API_URL, 'https://prick.example.com');
    assert.equal(env.PRK_PROJECT, 'api');
    assert.equal(env.PRK_ENV, 'staging');
    assert.equal(env.PRK_ACCESS_CLIENT_ID, TOKEN.PRICK_INPUT_CLIENT_ID);
    assert.equal(env.PRK_ACCESS_CLIENT_SECRET, TOKEN.PRICK_INPUT_CLIENT_SECRET);
  });

  test('defaults the environment to production', () => {
    assert.equal(inject({ A: '1' }).calls[0].options.env.PRK_ENV, 'production');
  });

  test('closes the child stdin so a prompt cannot hang the job', () => {
    assert.deepEqual(inject({ A: '1' }).calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  });
});

describe('parseSecrets', () => {
  test('reads a flat object of strings', () => {
    const secrets = parseSecrets('{"A":"1","B":"two"}');
    assert.deepEqual(
      [...secrets],
      [
        ['A', '1'],
        ['B', 'two'],
      ],
    );
  });

  test('accepts an empty environment', () => {
    assert.equal(parseSecrets('{}').size, 0);
  });

  test('does not reach through to Object.prototype', () => {
    const secrets = parseSecrets('{"__proto__":"x","constructor":"y"}');
    assert.equal(secrets.get('__proto__'), 'x');
    assert.equal(secrets.get('toString'), undefined);
  });

  test('refuses a non-object document', () => {
    for (const text of ['[]', '"a string"', 'null', '42']) {
      assert.throws(() => parseSecrets(text), ActionError, text);
    }
  });

  test('names the key when a value is not a string', () => {
    assert.throws(() => parseSecrets('{"N":1}'), /`N`/);
  });

  test('never quotes the input in a parse failure', () => {
    // Node's own SyntaxError message embeds a slice of the input, and the input
    // is a document of secret values. This is why it is discarded.
    const output = 'oops: SUPER_SECRET_VALUE_42 was here';
    assert.throws(
      () => parseSecrets(output),
      (error) => {
        assert.ok(!error.message.includes('SUPER_SECRET_VALUE_42'), error.message);
        assert.ok(!String(error.hint).includes('SUPER_SECRET_VALUE_42'));
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
  });
});

describe('a failing CLI', () => {
  /**
   * @param {number} status
   * @param {string} [stderr]
   */
  const failWith = (status, stderr = '') => {
    const h = harness();
    const code = main(['inject'], {
      env: { ...TOKEN },
      io: h.io,
      spawn: fakeSpawn({ status, stderr }),
    });
    return { ...h, code };
  };

  test('403 says what to do about it, and where', () => {
    const result = failWith(4);
    const message = result.commands('error')[0].text;
    const hint = result
      .of('log')
      .map((e) => e.text)
      .join('\n');

    assert.match(message, /no grant for this project and environment/);
    assert.match(hint, /Seen but not granted/);
    assert.match(hint, /reader/);
  });

  test('401 points at the token, not at a login', () => {
    assert.match(
      failWith(3)
        .of('log')
        .map((e) => e.text)
        .join('\n'),
      /client-id.*client-secret/s,
    );
  });

  test('404 points at the names', () => {
    assert.match(failWith(5).commands('error')[0].text, /no such project or environment/);
  });

  test('an unreachable server points at the url input', () => {
    assert.match(
      failWith(7)
        .of('log')
        .map((e) => e.text)
        .join('\n'),
      /`url`/,
    );
  });

  test('an unmapped status is reported rather than guessed at', () => {
    assert.match(failWith(99).commands('error')[0].text, /exited with status 99/);
  });

  test('relays the CLI stderr, which is contractually value-free', () => {
    assert.match(
      failWith(4, 'error: forbidden\n')
        .of('log')
        .map((e) => e.text)
        .join('\n'),
      /error: forbidden/,
    );
  });

  test('writes nothing when it fails', () => {
    const result = failWith(4);
    assert.equal(result.of('env').length, 0);
    assert.equal(result.of('output').length, 0);
    assert.equal(result.code, 1);
  });

  test('a missing binary is reported as a missing binary', () => {
    const h = harness();
    const code = main(['inject'], {
      env: { ...TOKEN },
      io: h.io,
      spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
    });
    assert.equal(code, 1);
    assert.match(h.commands('error')[0].text, /could not run `prk`/);
  });
});

describe('describeExit', () => {
  test('gives every documented code a title and an actionable hint', () => {
    for (const code of [2, 3, 4, 5, 6, 7, 8, 10, 11]) {
      const { title, hint } = describeExit(code);
      assert.ok(title.length > 0, `${code} has no title`);
      assert.ok(hint.length > 0, `${code} has no hint`);
    }
  });

  test('does not report a signal as a successful exit', () => {
    // spawnSync reports `null` for a killed child. Coercing that to a number
    // would say "exited with status 0" for a cancelled job.
    assert.match(describeExit(null).title, /killed before it finished/);
  });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

describe('the url input', () => {
  test('accepts https', () => {
    assert.equal(validateUrl('https://prick.example.com'), 'https://prick.example.com');
    assert.equal(validateUrl('  https://prick.example.com/  '), 'https://prick.example.com/');
  });

  test('refuses plaintext, because the token travels in a header', () => {
    assert.throws(() => validateUrl('http://prick.example.com'), /only https is accepted/);
    assert.throws(() => validateUrl('ftp://prick.example.com'), /only https is accepted/);
    assert.throws(() => validateUrl('file:///etc/passwd'), /only https is accepted/);
  });

  test('refuses a URL with credentials in it', () => {
    assert.throws(() => validateUrl('https://user:pw@prick.example.com'), /userinfo/);
  });

  test('refuses a relative or empty URL', () => {
    assert.throws(() => validateUrl('prick.example.com'), /not a URL/);
    assert.throws(() => validateUrl(''), /required/);
  });

  test('does not echo the URL back, which is commonly a repository secret', () => {
    assert.throws(
      () => validateUrl('http://internal-host.example.net/path'),
      (error) => {
        assert.ok(!error.message.includes('internal-host'));
        assert.ok(!String(error.hint).includes('internal-host'));
        return true;
      },
    );
  });
});

describe('export-to', () => {
  test('defaults to env', () => {
    assert.equal(validateExportTo(''), 'env');
    assert.equal(validateExportTo(undefined), 'env');
  });

  test('refuses a mode that does not exist', () => {
    assert.throws(() => validateExportTo('file'), ActionError);
  });

  test('outputs mode writes a JSON object and leaves the environment alone', () => {
    const h = harness();
    commandInject({
      env: { ...TOKEN, PRICK_INPUT_EXPORT_TO: 'outputs' },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"1","B":"two\\nlines"}' }),
      random: fakeRandom(),
    });

    assert.equal(h.of('env').length, 0);
    const written = parseEnvFile(h.output());
    assert.deepEqual(JSON.parse(written.get('secrets')), { A: '1', B: 'two\nlines' });
  });

  test('masks in outputs mode too', () => {
    const h = harness();
    commandInject({
      env: { ...TOKEN, PRICK_INPUT_EXPORT_TO: 'outputs' },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"secret"}' }),
      random: fakeRandom(),
    });
    assert.deepEqual(
      h.commands('add-mask').map((e) => e.text),
      ['secret'],
    );
  });

  test('always publishes the names, and only the names', () => {
    const result = inject({ B: 'v1', A: 'v2' });
    const written = parseEnvFile(result.output());
    assert.equal(written.get('keys'), 'A\nB');
    assert.ok(!result.output().includes('v1'));
  });
});

describe('required inputs', () => {
  /**
   * @param {Record<string, string>} env
   */
  const failsWith = (env) => {
    const h = harness();
    const code = main(['inject'], { env, io: h.io, spawn: fakeSpawn({ stdout: '{}' }) });
    assert.equal(code, 1);
    return h.commands('error')[0].text;
  };

  test('names the missing one', () => {
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_PROJECT: '' }), /`project` is required/);
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_CLIENT_ID: '' }), /client-id.*client-secret/);
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_CLIENT_SECRET: ' ' }), /required/);
  });

  test('says the credential is a service token, not an SSO session', () => {
    const h = harness();
    main(['inject'], {
      env: { ...TOKEN, PRICK_INPUT_CLIENT_ID: '' },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{}' }),
    });
    assert.match(
      h
        .of('log')
        .map((e) => e.text)
        .join('\n'),
      /SERVICE TOKEN/,
    );
  });
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

describe('the version the action installs', () => {
  test('is the action ref when the ref is a release tag', () => {
    assert.deepEqual(resolveVersionSpec({ actionRef: 'v2026.815.0' }).spec, '2026.815.0');
    assert.deepEqual(resolveVersionSpec({ actionRef: '2026.105.3' }).spec, '2026.105.3');
  });

  test('is the version input when one is given, which wins over the ref', () => {
    const resolved = resolveVersionSpec({ version: '2026.814.1', actionRef: 'v2026.815.0' });
    assert.equal(resolved.spec, '2026.814.1');
    assert.match(resolved.source, /version. input/);
  });

  test('falls back to latest for a floating ref, and says why', () => {
    for (const ref of ['v1', 'main', 'a'.repeat(40), '']) {
      assert.equal(resolveVersionSpec({ actionRef: ref }).spec, 'latest');
    }
    assert.match(resolveVersionSpec({ actionRef: 'v1' }).source, /v1 names no version/);
  });

  test('accepts ranges and dist-tags in the input', () => {
    for (const spec of ['2026.815.0', '^2026.815.0', '~2026.815.0', 'latest', 'next']) {
      assert.equal(resolveVersionSpec({ version: spec }).spec, spec);
    }
  });

  test('refuses a spec that is not a registry version', () => {
    for (const spec of [
      'git+https://evil.example/x.git',
      'file:../../etc',
      './local',
      'https://evil.example/x.tgz',
      '2026.815.0 && curl evil',
      '$(id)',
      'a|b',
    ]) {
      assert.throws(() => assertSafeVersionSpec(spec), ActionError, spec);
    }
  });
});

describe('the install step', () => {
  test('installs the pinned version globally, without running install scripts', () => {
    const args = installArgs('2026.815.0');
    assert.deepEqual(args, [
      'install',
      '--global',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${CLI_PACKAGE}@2026.815.0`,
    ]);
  });

  test('validates the inputs before spending a minute on npm', () => {
    const h = harness();
    const calls = [];
    const code = main(['install'], {
      env: { ...TOKEN, PRICK_INPUT_URL: 'http://prick.example.com' },
      io: h.io,
      spawn: fakeSpawn({}, calls),
    });

    assert.equal(code, 1);
    assert.equal(calls.length, 0, 'npm ran despite an invalid url');
  });

  test('reports an install failure against the version it tried', () => {
    const h = harness();
    const code = main(['install'], {
      env: { ...TOKEN, PRICK_INPUT_VERSION: '1999.101.0' },
      io: h.io,
      spawn: fakeSpawn({ status: 1, stderr: 'npm error 404' }),
    });

    assert.equal(code, 1);
    assert.match(h.commands('error')[0].text, /installing @yashau\/prick@1999\.101\.0 failed/);
  });

  test('succeeds quietly', () => {
    const h = harness();
    const calls = [];
    assert.equal(commandInstall({ env: { ...TOKEN }, io: h.io, spawn: fakeSpawn({}, calls) }), 0);
    assert.equal(calls[0].file, 'npm');
    assert.equal(h.commands('error').length, 0);
  });
});

describe('the entry point', () => {
  test('refuses an unknown subcommand', () => {
    const h = harness();
    assert.equal(main(['frobnicate'], { env: {}, io: h.io }), 1);
    assert.match(h.commands('error')[0].text, /unknown subcommand/);
  });

  test('reports a failure as an ::error:: so it annotates the run', () => {
    const h = harness();
    main(['inject'], { env: {}, io: h.io });
    assert.equal(h.commands('error').length, 1);
    assert.match(h.commands('error')[0].text, /^prick: /);
  });
});
