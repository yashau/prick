// action/io.test.mjs — the two destinations a value may reach: the mask
// command and the heredoc block. Mirrors io.mjs.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { ActionError } from "./errors.mjs";
import { fakeRandom, fakeSpawn, harness, inject, nthDelimiter, TOKEN } from "./harness.mjs";
import { main } from "./inject.mjs";
import { chooseDelimiter, escapeData, maskPayloads, renderAssignment } from "./io.mjs";

// ---------------------------------------------------------------------------
// The heredoc block
// ---------------------------------------------------------------------------

describe("the heredoc delimiter", () => {
  test("is a fresh random one per run", () => {
    const first = inject({ A: "1" }).env();
    const second = inject({ A: "1" }).env();
    const delimiterOf = (text) => /<<(\S+)/.exec(text)[1];
    // Both runs use the same fake RNG, so equality here proves only that the
    // delimiter comes FROM the RNG; the real one is crypto.randomBytes.
    assert.equal(delimiterOf(first), delimiterOf(second));
    assert.match(delimiterOf(first), /^__PRICK_EOF_[0-9a-f]{32}__$/);
  });

  test("is regenerated when a value contains it", () => {
    const collision = nthDelimiter(0);
    const values = [`a\n${collision}\nb`];
    const chosen = chooseDelimiter(values, fakeRandom());

    assert.notEqual(chosen, collision);
    assert.equal(chosen, nthDelimiter(1));
    assert.ok(!values[0].includes(chosen));
  });

  test("is regenerated even when the value merely contains it as a substring", () => {
    const collision = nthDelimiter(0);
    const chosen = chooseDelimiter([`prefix${collision}suffix`], fakeRandom());
    assert.notEqual(chosen, collision);
  });

  test("gives up rather than writing a block a value can break out of", () => {
    const always = () => Buffer.alloc(16, 0x11);
    assert.throws(() => chooseDelimiter([nthDelimiter(0)], always), ActionError);
  });

  test("survives end to end when the secret contains the delimiter the RNG offers first", () => {
    const collision = nthDelimiter(0);
    const value = `line1\n${collision}\nline2`;
    const result = inject({ SECRET: value });

    assert.equal(result.injected.get("SECRET"), value);
    assert.ok(!result.env().startsWith(`SECRET<<${collision}\n`));
  });
});

describe("the assignment", () => {
  test("writes the value byte for byte between the delimiters", () => {
    assert.equal(renderAssignment("K", " padded \n", "D"), "K<<D\n padded \n\nD\n");
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe("escapeData", () => {
  test("escapes the three characters that would end or corrupt a command", () => {
    assert.equal(escapeData("a\nb"), "a%0Ab");
    assert.equal(escapeData("a\rb"), "a%0Db");
    assert.equal(escapeData("100%"), "100%25");
  });

  test("escapes the percent first, so an escape cannot be double-escaped", () => {
    assert.equal(escapeData("%0A"), "%250A");
    assert.equal(escapeData("%"), "%25");
  });

  test("leaves everything else, including unicode, alone", () => {
    assert.equal(escapeData("café 🔑 $(id) ::"), "café 🔑 $(id) ::");
  });
});

describe("masking", () => {
  test("masks a single-line value once", () => {
    assert.deepEqual(maskPayloads("hunter2"), ["hunter2"]);
  });

  test("masks a multi-line value whole AND line by line", () => {
    // The whole-value mask never matches a log line, and a per-line mask never
    // matches a value logged whole. Both are needed.
    assert.deepEqual(maskPayloads("one\ntwo"), ["one\ntwo", "one", "two"]);
  });

  test("splits CRLF as one break, not two", () => {
    assert.deepEqual(maskPayloads("one\r\ntwo"), ["one\r\ntwo", "one", "two"]);
  });

  test("skips blank lines, which the runner ignores and which would redact the log", () => {
    assert.deepEqual(maskPayloads("one\n\n   \ntwo"), ["one\n\n   \ntwo", "one", "two"]);
  });

  test("has nothing to mask for an empty or whitespace-only value", () => {
    assert.deepEqual(maskPayloads(""), []);
    assert.deepEqual(maskPayloads("   "), []);
    assert.deepEqual(maskPayloads("\n\n"), []);
  });

  test("does not repeat a payload", () => {
    assert.deepEqual(maskPayloads("same\nsame"), ["same\nsame", "same"]);
  });

  test("emits the mask command with the value escaped", () => {
    const result = inject({ KEY: "line1\nline2" });
    const masks = result.commands("add-mask").map((e) => e.text);
    assert.deepEqual(masks, ["line1\nline2", "line1", "line2"]);
    // The io under test records the raw message; the real one escapes on the
    // way out. Assert that contract holds where it is implemented.
    assert.equal(escapeData(masks[0]), "line1%0Aline2");
  });

  test("mask: false injects but warns loudly instead", () => {
    const result = inject({ KEY: "value" }, { PRICK_INPUT_MASK: "false" });
    assert.equal(result.commands("add-mask").length, 0);
    assert.match(result.commands("warning")[0].text, /Masking is disabled/);
    assert.equal(result.injected.get("KEY"), "value");
  });

  test("an unreadable mask input fails rather than defaulting to off", () => {
    // `enabled` plainly means "on". Anything that treated it as "off" because
    // it is not in the accepted list would print every secret in the job.
    const h = harness();
    const code = main(["inject"], {
      env: { ...TOKEN, PRICK_INPUT_MASK: "enabled" },
      io: h.io,
      spawn: fakeSpawn({ stdout: "{}" }),
    });
    assert.equal(code, 1);
    assert.match(h.commands("error")[0].text, /must be true or false/);
  });
});
