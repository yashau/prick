// action/plan.test.mjs — the name rules and the injection plan they produce.
// Mirrors plan.mjs.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { fakeSpawn, harness, inject, TOKEN } from "./harness.mjs";
import { main } from "./inject.mjs";
// `parseKeyList` is an input parser and lives in inputs.mjs; the allowlist
// tests stay together here because reading the list and applying it are one
// behaviour, and splitting them across two files would hide the second half.
import { parseKeyList } from "./inputs.mjs";
import { isUnsafeName, isValidEnvName, planInjection } from "./plan.mjs";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("key names", () => {
  test("accepts what a POSIX environment accepts", () => {
    for (const name of ["DATABASE_URL", "A", "_private", "S3_BUCKET_2", "lowercase"]) {
      assert.ok(isValidEnvName(name), name);
    }
  });

  test("rejects what it does not", () => {
    for (const name of ["", "1FOO", "FOO-BAR", "FOO BAR", "FOO=", "FOO\nBAR", "CAFÉ", "a.b"]) {
      assert.ok(!isValidEnvName(name), JSON.stringify(name));
    }
    assert.ok(!isValidEnvName("A".repeat(257)));
    assert.ok(isValidEnvName("A".repeat(256)));
  });

  test("is not fooled by a trailing newline", () => {
    assert.ok(!isValidEnvName("FOO\n"));
  });
});

describe("an invalid key name", () => {
  const secrets = {
    GOOD: "kept",
    "BAD-NAME": "skipped-value-1",
    "1LEADING": "skipped-value-2",
    "has space": "skipped-value-3",
    CAFÉ: "skipped-value-4",
  };

  test("is skipped, not injected", () => {
    const result = inject(secrets);
    assert.deepEqual([...result.injected.keys()], ["GOOD"]);
  });

  test("is warned about by name", () => {
    const warnings = inject(secrets)
      .commands("warning")
      .map((e) => e.text);
    assert.equal(warnings.length, 4);
    for (const key of ["BAD-NAME", "1LEADING", "has space", "CAFÉ"]) {
      assert.ok(
        warnings.some((w) => w.includes(key)),
        `${key} was skipped without saying so`,
      );
    }
  });

  test("never has its value named", () => {
    const result = inject(secrets);
    for (const event of result.events) {
      if (event.kind === "command" && event.name === "add-mask") {
        continue;
      }
      if (event.kind === "env") {
        continue;
      }
      for (let i = 1; i <= 4; i += 1) {
        assert.ok(!event.text.includes(`skipped-value-${i}`), event.text);
      }
    }
  });

  test("does not stop the valid ones", () => {
    assert.equal(inject(secrets).code, 0);
  });
});

describe("an unsafe name", () => {
  test("covers the loader, the runtime and the runner", () => {
    for (const name of [
      "PATH",
      "NODE_OPTIONS",
      "BASH_ENV",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "PYTHONPATH",
      "GITHUB_ENV",
      "GITHUB_TOKEN",
      "RUNNER_TEMP",
      "ACTIONS_RUNTIME_TOKEN",
    ]) {
      assert.ok(isUnsafeName(name), name);
    }
  });

  test("does not catch names that merely look like one", () => {
    for (const name of ["ld_preload", "Path", "PATHS", "LOAD_BALANCER", "MY_GITHUB_TOKEN"]) {
      assert.ok(!isUnsafeName(name), name);
    }
  });

  test("is skipped with a warning by default", () => {
    const result = inject({ NODE_OPTIONS: "--require ./evil.js", SAFE: "ok" });
    assert.deepEqual([...result.injected.keys()], ["SAFE"]);
    assert.match(result.commands("warning")[0].text, /NODE_OPTIONS/);
  });

  test("is injected when the operator opts in", () => {
    const result = inject(
      { NODE_OPTIONS: "--max-old-space-size=4096" },
      { PRICK_INPUT_ALLOW_UNSAFE_NAMES: "true" },
    );
    assert.equal(result.injected.get("NODE_OPTIONS"), "--max-old-space-size=4096");
  });

  test("is judged after the prefix is applied, which is what makes a prefix a fix", () => {
    const result = inject({ PATH: "x" }, { PRICK_INPUT_PREFIX: "APP_" });
    assert.equal(result.injected.get("APP_PATH"), "x");
  });
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe("the keys allowlist", () => {
  test("splits on newlines and on commas", () => {
    assert.deepEqual(parseKeyList("A\nB"), ["A", "B"]);
    assert.deepEqual(parseKeyList("A,B"), ["A", "B"]);
    assert.deepEqual(parseKeyList(" A , B \n C\n\n"), ["A", "B", "C"]);
    assert.deepEqual(parseKeyList("A,A,B"), ["A", "B"]);
  });

  test('distinguishes "no allowlist" from "an empty one"', () => {
    assert.equal(parseKeyList(""), null);
    assert.equal(parseKeyList("  \n , "), null);
    assert.equal(parseKeyList(undefined), null);
  });

  test("injects only what it names", () => {
    const result = inject({ A: "1", B: "2", C: "3" }, { PRICK_INPUT_KEYS: "A\nC" });
    assert.deepEqual([...result.injected.keys()], ["A", "C"]);
  });

  test("fails on a name the environment does not have", () => {
    const h = harness();
    const code = main(["inject"], {
      env: { ...TOKEN, PRICK_INPUT_KEYS: "A,MISSING_ONE" },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"1"}' }),
    });

    assert.equal(code, 1);
    assert.match(h.commands("error")[0].text, /MISSING_ONE/);
    assert.equal(h.of("env").length, 0, "nothing may be written when the step fails");
  });

  test("reports every missing name at once, not one per run", () => {
    const plan = planInjection({
      secrets: new Map([["A", "1"]]),
      allowlist: ["A", "X", "Y"],
      prefix: "",
    });
    assert.deepEqual(plan.missing, ["X", "Y"]);
    assert.deepEqual(
      plan.entries.map((e) => e.name),
      ["A"],
    );
  });

  test("still skips an invalid name it happens to list", () => {
    const plan = planInjection({
      secrets: new Map([["BAD-NAME", "v"]]),
      allowlist: ["BAD-NAME"],
      prefix: "",
    });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].key, "BAD-NAME");
  });
});
