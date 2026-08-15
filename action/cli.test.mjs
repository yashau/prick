// action/cli.test.mjs — the boundary with the `prk` binary: how it is invoked,
// what its exit codes mean, how its output is read, and which version is
// installed. Mirrors cli.mjs.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  assertSafeVersionSpec,
  CLI_ARGS,
  CLI_PACKAGE,
  describeExit,
  installArgs,
  parseSecrets,
  resolveVersionSpec,
} from "./cli.mjs";
import { ActionError } from "./errors.mjs";
import { fakeSpawn, harness, inject, TOKEN } from "./harness.mjs";
import { commandInstall, main } from "./inject.mjs";

// ---------------------------------------------------------------------------
// Invocation and output
// ---------------------------------------------------------------------------

describe("the CLI invocation", () => {
  test("puts no user data in the argument vector", () => {
    // The premise the Windows `shell: true` path rests on.
    for (const argument of CLI_ARGS) {
      assert.match(argument, /^[a-z-]+$/, argument);
    }
  });

  test("asks for JSON and never prompts", () => {
    assert.deepEqual(CLI_ARGS, ["secrets", "download", "--format", "json", "--no-input"]);
  });

  test("passes the URL, project, environment and token through the environment", () => {
    const result = inject({ A: "1" }, { PRICK_INPUT_ENVIRONMENT: "staging" });
    const { env } = result.calls[0].options;

    assert.equal(env.PRK_API_URL, "https://prick.example.com");
    assert.equal(env.PRK_PROJECT, "api");
    assert.equal(env.PRK_ENV, "staging");
    assert.equal(env.PRK_ACCESS_CLIENT_ID, TOKEN.PRICK_INPUT_CLIENT_ID);
    assert.equal(env.PRK_ACCESS_CLIENT_SECRET, TOKEN.PRICK_INPUT_CLIENT_SECRET);
  });

  test("defaults the environment to production", () => {
    assert.equal(inject({ A: "1" }).calls[0].options.env.PRK_ENV, "production");
  });

  test("closes the child stdin so a prompt cannot hang the job", () => {
    assert.deepEqual(inject({ A: "1" }).calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  });
});

describe("parseSecrets", () => {
  test("reads a flat object of strings", () => {
    const secrets = parseSecrets('{"A":"1","B":"two"}');
    assert.deepEqual(
      [...secrets],
      [
        ["A", "1"],
        ["B", "two"],
      ],
    );
  });

  test("accepts an empty environment", () => {
    assert.equal(parseSecrets("{}").size, 0);
  });

  test("does not reach through to Object.prototype", () => {
    const secrets = parseSecrets('{"__proto__":"x","constructor":"y"}');
    assert.equal(secrets.get("__proto__"), "x");
    assert.equal(secrets.get("toString"), undefined);
  });

  test("refuses a non-object document", () => {
    for (const text of ["[]", '"a string"', "null", "42"]) {
      assert.throws(() => parseSecrets(text), ActionError, text);
    }
  });

  test("names the key when a value is not a string", () => {
    assert.throws(() => parseSecrets('{"N":1}'), /`N`/);
  });

  test("never quotes the input in a parse failure", () => {
    // Node's own SyntaxError message embeds a slice of the input, and the input
    // is a document of secret values. This is why it is discarded.
    const output = "oops: SUPER_SECRET_VALUE_42 was here";
    assert.throws(
      () => parseSecrets(output),
      (error) => {
        assert.ok(!error.message.includes("SUPER_SECRET_VALUE_42"), error.message);
        assert.ok(!String(error.hint).includes("SUPER_SECRET_VALUE_42"));
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Exit status
// ---------------------------------------------------------------------------

describe("a failing CLI", () => {
  /**
   * @param {number} status
   * @param {string} [stderr]
   */
  const failWith = (status, stderr = "") => {
    const h = harness();
    const code = main(["inject"], {
      env: { ...TOKEN },
      io: h.io,
      spawn: fakeSpawn({ status, stderr }),
    });
    return { ...h, code };
  };

  test("403 says what to do about it, and where", () => {
    const result = failWith(4);
    const message = result.commands("error")[0].text;
    const hint = result
      .of("log")
      .map((e) => e.text)
      .join("\n");

    assert.match(message, /no grant for this project and environment/);
    assert.match(hint, /Seen but not granted/);
    assert.match(hint, /reader/);
  });

  test("401 points at the token, not at a login", () => {
    assert.match(
      failWith(3)
        .of("log")
        .map((e) => e.text)
        .join("\n"),
      /client-id.*client-secret/s,
    );
  });

  test("404 points at the names", () => {
    assert.match(failWith(5).commands("error")[0].text, /no such project or environment/);
  });

  test("an unreachable server points at the url input", () => {
    assert.match(
      failWith(7)
        .of("log")
        .map((e) => e.text)
        .join("\n"),
      /`url`/,
    );
  });

  test("an unmapped status is reported rather than guessed at", () => {
    assert.match(failWith(99).commands("error")[0].text, /exited with status 99/);
  });

  test("relays the CLI stderr, which is contractually value-free", () => {
    assert.match(
      failWith(4, "error: forbidden\n")
        .of("log")
        .map((e) => e.text)
        .join("\n"),
      /error: forbidden/,
    );
  });

  test("writes nothing when it fails", () => {
    const result = failWith(4);
    assert.equal(result.of("env").length, 0);
    assert.equal(result.of("output").length, 0);
    assert.equal(result.code, 1);
  });

  test("a missing binary is reported as a missing binary", () => {
    const h = harness();
    const code = main(["inject"], {
      env: { ...TOKEN },
      io: h.io,
      spawn: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
    });
    assert.equal(code, 1);
    assert.match(h.commands("error")[0].text, /could not run `prk`/);
  });
});

describe("describeExit", () => {
  test("gives every documented code a title and an actionable hint", () => {
    for (const code of [2, 3, 4, 5, 6, 7, 8, 10, 11]) {
      const { title, hint } = describeExit(code);
      assert.ok(title.length > 0, `${code} has no title`);
      assert.ok(hint.length > 0, `${code} has no hint`);
    }
  });

  test("does not report a signal as a successful exit", () => {
    // spawnSync reports `null` for a killed child. Coercing that to a number
    // would say "exited with status 0" for a cancelled job.
    assert.match(describeExit(null).title, /killed before it finished/);
  });
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

describe("the version the action installs", () => {
  test("is the action ref when the ref is a release tag", () => {
    assert.deepEqual(resolveVersionSpec({ actionRef: "v2026.815.0" }).spec, "2026.815.0");
    assert.deepEqual(resolveVersionSpec({ actionRef: "2026.105.3" }).spec, "2026.105.3");
  });

  test("is the version input when one is given, which wins over the ref", () => {
    const resolved = resolveVersionSpec({ version: "2026.814.1", actionRef: "v2026.815.0" });
    assert.equal(resolved.spec, "2026.814.1");
    assert.match(resolved.source, /version. input/);
  });

  test("falls back to latest for a floating ref, and says why", () => {
    for (const ref of ["v1", "main", "a".repeat(40), ""]) {
      assert.equal(resolveVersionSpec({ actionRef: ref }).spec, "latest");
    }
    assert.match(resolveVersionSpec({ actionRef: "v1" }).source, /v1 names no version/);
  });

  test("accepts ranges and dist-tags in the input", () => {
    for (const spec of ["2026.815.0", "^2026.815.0", "~2026.815.0", "latest", "next"]) {
      assert.equal(resolveVersionSpec({ version: spec }).spec, spec);
    }
  });

  test("refuses a spec that is not a registry version", () => {
    for (const spec of [
      "git+https://evil.example/x.git",
      "file:../../etc",
      "./local",
      "https://evil.example/x.tgz",
      "2026.815.0 && curl evil",
      "$(id)",
      "a|b",
    ]) {
      assert.throws(() => assertSafeVersionSpec(spec), ActionError, spec);
    }
  });
});

describe("the install step", () => {
  test("installs the pinned version globally, without running install scripts", () => {
    const args = installArgs("2026.815.0");
    assert.deepEqual(args, [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${CLI_PACKAGE}@2026.815.0`,
    ]);
  });

  test("validates the inputs before spending a minute on npm", () => {
    const h = harness();
    const calls = [];
    const code = main(["install"], {
      env: { ...TOKEN, PRICK_INPUT_URL: "http://prick.example.com" },
      io: h.io,
      spawn: fakeSpawn({}, calls),
    });

    assert.equal(code, 1);
    assert.equal(calls.length, 0, "npm ran despite an invalid url");
  });

  test("reports an install failure against the version it tried", () => {
    const h = harness();
    const code = main(["install"], {
      env: { ...TOKEN, PRICK_INPUT_VERSION: "1999.101.0" },
      io: h.io,
      spawn: fakeSpawn({ status: 1, stderr: "npm error 404" }),
    });

    assert.equal(code, 1);
    assert.match(h.commands("error")[0].text, /installing @yashau\/prick@1999\.101\.0 failed/);
  });

  test("succeeds quietly", () => {
    const h = harness();
    const calls = [];
    assert.equal(commandInstall({ env: { ...TOKEN }, io: h.io, spawn: fakeSpawn({}, calls) }), 0);
    assert.equal(calls[0].file, "npm");
    assert.equal(h.commands("error").length, 0);
  });
});
