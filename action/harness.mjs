// action/harness.mjs — the fakes every suite in this directory shares.
//
// Not a test file (the name matches none of node:test's discovery patterns), so
// `node --test` imports it rather than running it.
//
// Every effect the action performs is injected, so nothing in the suites spawns
// npm, spawns the CLI, writes to a file or writes to a stream. The `$GITHUB_ENV`
// block the action would have written is instead parsed back the way the runner
// parses it, and compared with the input -- because "the value survived" is the
// only assertion that actually matters, and it is the one a hand-checked
// expected string quietly fails to make.

import assert from "node:assert/strict";

import { commandInject } from "./inject.mjs";
import { DELIMITER_PREFIX } from "./io.mjs";

/**
 * Records every effect in issue order, so tests can assert on ordering as well
 * as on content -- masking before writing is a property of the ORDER.
 */
export function harness() {
  /** @type {{ kind: string, name?: string, text: string }[]} */
  const events = [];
  return {
    events,
    io: {
      command: (name, message) => events.push({ kind: "command", name, text: message }),
      log: (line) => events.push({ kind: "log", text: line }),
      appendEnv: (text) => events.push({ kind: "env", text }),
      appendOutput: (text) => events.push({ kind: "output", text }),
    },
    of: (kind) => events.filter((e) => e.kind === kind),
    commands: (name) => events.filter((e) => e.kind === "command" && e.name === name),
    env: () =>
      events
        .filter((e) => e.kind === "env")
        .map((e) => e.text)
        .join(""),
    output: () =>
      events
        .filter((e) => e.kind === "output")
        .map((e) => e.text)
        .join(""),
  };
}

/** A spawn that returns a canned result and records how it was called. */
export function fakeSpawn(result = {}, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0, stdout: "", stderr: "", ...result };
  };
}

/** The version the canned attestation report below verifies. */
export const VERIFIED_VERSION = "2026.815.0";

/**
 * An `npm audit signatures --json --include-attestations` document, shaped like
 * the real one. Recorded from npm 11 against the published package rather than
 * invented: `verified` carries the parent AND its platform package, and the
 * provenance predicate is the SLSA one npm reports.
 *
 * @param {object} [options]
 * @param {string} [options.version]
 * @param {boolean} [options.provenance]  drop the attestation, keep the signature
 * @param {object[]} [options.invalid]
 * @param {object[]} [options.missing]
 * @param {boolean} [options.present]  drop the parent package from the report
 */
export function auditReport({
  version = VERIFIED_VERSION,
  provenance = true,
  invalid = [],
  missing = [],
  present = true,
} = {}) {
  const attestations = {
    url: `https://registry.npmjs.org/-/npm/v1/attestations/@yashau%2fprick@${version}`,
    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
  };
  const parent = {
    name: "@yashau/prick",
    version,
    registry: "https://registry.npmjs.org/",
    ...(provenance ? { attestations } : {}),
  };
  return JSON.stringify({
    invalid,
    missing,
    verified: [
      ...(present ? [parent] : []),
      {
        name: "@yashau/prick-linux-x64-gnu",
        version,
        registry: "https://registry.npmjs.org/",
        attestations,
      },
    ],
  });
}

/**
 * A spawn that answers the install command's three npm invocations separately:
 * the staging fetch, the attestation audit, and the global install. Dispatches
 * on the argument vector rather than on call order, so a test that overrides one
 * of them does not have to know where it sits in the sequence.
 *
 * @param {{ staged?: object, audited?: object, installed?: object }} [results]
 * @param {object[]} [calls]
 */
export function fakeNpm({ staged = {}, audited = {}, installed = {} } = {}, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const ok = { status: 0, stdout: "", stderr: "" };
    if (args[0] === "audit") {
      return { ...ok, stdout: auditReport(), ...audited };
    }
    if (args.includes("--global")) {
      return { ...ok, ...installed };
    }
    return { ...ok, ...staged };
  };
}

/**
 * A staging directory that is never created on disk. A path with a space and an
 * ampersand in it, because the reason `stagingArgs` says `--prefix .` and passes
 * the directory as a cwd is that a runner's temporary path may contain both.
 */
export const STAGING = "/tmp/runner temp & more/prick-verify-abc123";

/** @returns {string} */
export const fakeStaging = () => STAGING;

/**
 * Deterministic bytes. Each call returns a different constant, so delimiters
 * are predictable and a collision can be forced.
 */
export function fakeRandom(sequence = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]) {
  let index = 0;
  return (size) => Buffer.alloc(size, sequence[Math.min(index++, sequence.length - 1)]);
}

/** The delimiter `fakeRandom` produces on its nth call (zero-based). */
export function nthDelimiter(n, sequence) {
  const random = fakeRandom(sequence);
  let value = "";
  for (let i = 0; i <= n; i += 1) {
    value = `${DELIMITER_PREFIX}${random(16).toString("hex")}__`;
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
export function parseEnvFile(text) {
  const parsed = new Map();
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    if (lines[index] === "") {
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
    parsed.set(name, body.join("\n"));
    index += 1;
  }

  return parsed;
}

export const TOKEN = {
  PRICK_INPUT_URL: "https://prick.example.com",
  PRICK_INPUT_CLIENT_ID: "e367826f93b8d71185e03fe518aff3b4.access",
  PRICK_INPUT_CLIENT_SECRET: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  PRICK_INPUT_PROJECT: "api",
};

/**
 * Runs `commandInject` against a canned secret set.
 *
 * @param {Record<string, string>} secrets
 * @param {Record<string, string>} [inputs]
 */
export function inject(secrets, inputs = {}) {
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
