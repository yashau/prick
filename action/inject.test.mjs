// action/inject.test.mjs — node:test + node:assert only, no dependencies.
//
// The end-to-end suite, plus the audit that gives the rest of the suites their
// meaning. The per-module suites are beside it: io.test.mjs, plan.test.mjs,
// inputs.test.mjs and cli.test.mjs, all sharing the fakes in harness.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { harness, inject } from "./harness.mjs";
import { main } from "./inject.mjs";
import { DELIMITER_PREFIX } from "./io.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every file the action itself loads: every `.mjs` in this directory that is
 * not a test suite or the fakes they share. DISCOVERED rather than listed, so a
 * module added tomorrow is audited without anyone remembering to add it here.
 */
const SOURCES = fs
  .readdirSync(HERE)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "harness.mjs")
  .sort();

// ---------------------------------------------------------------------------
// The audit that gives the rest of the suites their meaning
// ---------------------------------------------------------------------------

describe("the source itself", () => {
  /**
   * @param {string} file
   * @param {string} needle
   * @returns {number}
   */
  const countIn = (file, needle) =>
    fs.readFileSync(path.join(HERE, file), "utf8").split(needle).length - 1;

  /**
   * Across every source file, not merely the entry point: the whole point of
   * the count is that it is a property of the ACTION, and a second route to a
   * stream would most plausibly appear in a module beside this one.
   *
   * @param {string} needle
   * @returns {number}
   */
  const count = (needle) => SOURCES.reduce((total, file) => total + countIn(file, needle), 0);

  test("writes to stdout in exactly one place", () => {
    // Guards the guard: if a rename ever emptied this list the counts below
    // would all be 0 and the audit would pass while checking nothing.
    assert.ok(SOURCES.includes("inject.mjs"), `sources not discovered: ${SOURCES.join(", ")}`);
    assert.ok(SOURCES.includes("io.mjs"), `sources not discovered: ${SOURCES.join(", ")}`);

    // That one place is `realIo().command` in io.mjs, which escapes its
    // argument and is how `::add-mask::` is issued. If this number ever becomes
    // 2, a second route to the log exists and the masking guarantee is no
    // longer local to one file.
    assert.equal(count("process.stdout.write("), 1);
    assert.equal(countIn("io.mjs", "process.stdout.write("), 1);
  });

  test("writes to stderr in exactly one place, and never with console.log", () => {
    assert.equal(count("console.error("), 1);
    assert.equal(countIn("io.mjs", "console.error("), 1);
    assert.equal(count("process.stderr.write("), 0);
    for (const banned of ["console.log(", "console.info(", "console.warn(", "console.debug("]) {
      assert.equal(count(banned), 0, `${banned} is a route to the log that nothing audits`);
    }
  });

  test("has LF line endings and no tabs", () => {
    assert.equal(count("\r"), 0);
    assert.equal(count("\t"), 0);
  });
});

describe("the whole flow", () => {
  test("never lets a value reach anything but a mask command and the env file", () => {
    const value = "sentinel-a4f1c9-value";
    const result = inject({ DATABASE_URL: value });

    for (const event of result.events) {
      const isMask = event.kind === "command" && event.name === "add-mask";
      const isEnvFile = event.kind === "env";
      if (!isMask && !isEnvFile) {
        assert.ok(
          !event.text.includes(value),
          `a ${event.kind} carried the value: ${JSON.stringify(event.text)}`,
        );
      }
    }
    assert.equal(result.injected.get("DATABASE_URL"), value);
  });

  test("masks every value before anything is written", () => {
    const result = inject({ A: "one", B: "two" });
    const lastMask = result.events.findLastIndex((e) => e.name === "add-mask");
    const firstWrite = result.events.findIndex((e) => e.kind === "env" || e.kind === "output");

    assert.ok(lastMask >= 0, "nothing was masked");
    assert.ok(firstWrite >= 0, "nothing was written");
    assert.ok(lastMask < firstWrite, "a value was written before it was masked");
  });

  test("reports names, counts and nothing else on the log", () => {
    const result = inject({ DATABASE_URL: "postgres://u:p@h/db", API_KEY: "sk-live-1" });
    const log = result
      .of("log")
      .map((e) => e.text)
      .join("\n");
    assert.match(log, /Injected 2 secret\(s\)/);
    assert.match(log, /API_KEY, DATABASE_URL/);
    assert.ok(!log.includes("sk-live-1"));
    assert.ok(!log.includes("postgres://"));
  });
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe("a value survives the round trip when it", () => {
  /**
   * @param {string} label
   * @param {string} value
   */
  const survives = (label, value) => {
    test(label, () => {
      assert.equal(inject({ SECRET: value }).injected.get("SECRET"), value);
    });
  };

  survives("is ordinary", "hunter2");
  survives("is empty", "");
  survives("is a single space", " ");
  survives("spans several lines", "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----");
  survives("ends with a newline", "trailing\n");
  survives("starts with a newline", "\nleading");
  survives("is nothing but newlines", "\n\n\n");
  survives("contains an equals sign", "key=value=more");
  survives("is itself a KEY=VALUE assignment", "INJECTED=yes");
  survives("contains a lone carriage return", "a\rb");
  survives("contains CRLF", "a\r\nb");
  survives("is unicode", "café 日本語 🔑 Ω");
  survives("is unicode across lines", "первая\nвторая 🔑");
  survives("contains shell metacharacters", "$(id) `id` ${HOME} \\ ! & ; | > < * ? ~ #");
  survives("contains a percent sign", "100%%0A%0D%25");
  survives("contains a JSON document", '{"nested": "value", "n": [1, 2]}');
  survives("is very long", "x".repeat(100_000));

  test("is a line that looks like a heredoc terminator", () => {
    const value = `not-the-end\n${DELIMITER_PREFIX}deadbeef__\nstill-going`;
    assert.equal(inject({ SECRET: value }).injected.get("SECRET"), value);
  });
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

describe("the entry point", () => {
  test("refuses an unknown subcommand", () => {
    const h = harness();
    assert.equal(main(["frobnicate"], { env: {}, io: h.io }), 1);
    assert.match(h.commands("error")[0].text, /unknown subcommand/);
  });

  test("reports a failure as an ::error:: so it annotates the run", () => {
    const h = harness();
    main(["inject"], { env: {}, io: h.io });
    assert.equal(h.commands("error").length, 1);
    assert.match(h.commands("error")[0].text, /^prick: /);
  });
});
