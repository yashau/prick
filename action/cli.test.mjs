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
  stagingArgs,
  verifiedVersion,
  verifyArgs,
} from "./cli.mjs";
import { ActionError } from "./errors.mjs";
import {
  auditReport,
  fakeNpm,
  fakeSpawn,
  fakeStaging,
  harness,
  inject,
  STAGING,
  TOKEN,
  VERIFIED_VERSION,
} from "./harness.mjs";
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
  /**
   * @param {object} [options]
   * @param {Record<string, string>} [options.env]
   * @param {{ staged?: object, audited?: object, installed?: object }} [options.npm]
   */
  const install = ({ env = {}, npm = {} } = {}) => {
    const h = harness();
    const calls = [];
    const code = main(["install"], {
      env: { ...TOKEN, ...env },
      io: h.io,
      spawn: fakeNpm(npm, calls),
      staging: fakeStaging,
    });
    return { ...h, code, calls };
  };

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
      staging: fakeStaging,
    });

    assert.equal(code, 1);
    assert.equal(calls.length, 0, "npm ran despite an invalid url");
  });

  test("reports a fetch failure against the version it tried", () => {
    const result = install({
      env: { PRICK_INPUT_VERSION: "1999.101.0" },
      npm: { staged: { status: 1, stderr: "npm error 404" } },
    });

    assert.equal(result.code, 1);
    assert.match(result.commands("error")[0].text, /fetching @yashau\/prick@1999\.101\.0 failed/);
  });

  test("succeeds quietly", () => {
    const result = install();
    assert.equal(result.code, 0);
    assert.equal(result.calls[0].file, "npm");
    assert.equal(result.commands("error").length, 0);
  });

  test("stages, verifies, and only then installs", () => {
    const result = install();
    assert.equal(result.calls.length, 3);
    assert.equal(result.calls[0].args[0], "install");
    assert.equal(result.calls[1].args[0], "audit");
    assert.ok(result.calls[2].args.includes("--global"));
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("the staged fetch", () => {
  test("pins the prefix so npm cannot install into an ancestor project", () => {
    assert.deepEqual(stagingArgs("2026.815.0"), [
      "install",
      "--prefix",
      ".",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${CLI_PACKAGE}@2026.815.0`,
    ]);
  });

  test("runs no install script, exactly as the global install does not", () => {
    assert.ok(stagingArgs("2026.815.0").includes("--ignore-scripts"));
  });

  test("refuses a spec that is not a registry version, like installArgs", () => {
    assert.throws(() => stagingArgs("git+https://evil.example/x.git"), ActionError);
  });

  test("puts the staging directory in the cwd and never in an argument", () => {
    const calls = [];
    assert.equal(
      commandInstall({
        env: { ...TOKEN },
        io: harness().io,
        spawn: fakeNpm({}, calls),
        staging: fakeStaging,
      }),
      0,
    );

    // The premise of `--prefix .`: a runner's temporary path can contain a
    // space and an ampersand, and on Windows the npm invocation goes through
    // cmd. A cwd goes to the operating system and never reaches a command line.
    const [staged, audited, installed] = calls;
    assert.equal(staged.options.cwd, STAGING);
    assert.equal(audited.options.cwd, STAGING);
    assert.equal(installed.options.cwd, undefined, "the global install is not staged");

    for (const call of calls) {
      for (const argument of call.args) {
        assert.ok(!argument.includes(STAGING), `the staging path reached an argv: ${argument}`);
      }
    }
  });
});

describe("the attestation audit", () => {
  test("asks for the verified list, not merely the failures", () => {
    // Without --include-attestations npm reports `invalid` and `missing` alone,
    // and a package with NO attestation appears in neither -- which would pass.
    assert.ok(verifyArgs().includes("--include-attestations"));
    assert.ok(verifyArgs().includes("--json"));
  });

  test("returns the exact version npm verified", () => {
    assert.equal(verifiedVersion(auditReport()), VERIFIED_VERSION);
  });

  test("refuses a package with a signature but no provenance attestation", () => {
    assert.throws(
      () => verifiedVersion(auditReport({ provenance: false })),
      /carries no provenance attestation/,
    );
  });

  test("refuses a report that does not name the CLI at all", () => {
    assert.throws(
      () => verifiedVersion(auditReport({ present: false })),
      /verified no signature for @yashau\/prick/,
    );
  });

  test("refuses when anything in the tree failed, including a dependency", () => {
    // The platform package is where the `prk` executable actually lives.
    const report = auditReport({
      invalid: [{ name: "@yashau/prick-linux-x64-gnu", version: VERIFIED_VERSION }],
    });
    assert.throws(() => verifiedVersion(report), /refused 1 package/);
    assert.throws(() => verifiedVersion(report), /prick-linux-x64-gnu/);
  });

  test("counts a missing registry signature as a refusal too", () => {
    const report = auditReport({ missing: [{ name: "detect-libc", version: "2.1.2" }] });
    assert.throws(() => verifiedVersion(report), /refused 1 package/);
  });

  test("an unreachable registry is a check that did not happen, not one that passed", () => {
    // npm's own shape when it cannot fetch the verification keys.
    const report = JSON.stringify({
      error: { code: "ENOTFOUND", summary: "network request to ... failed", detail: "" },
    });
    assert.throws(() => verifiedVersion(report), /could not verify @yashau\/prick/);
    assert.throws(() => verifiedVersion(report), /network request/);
  });

  test("refuses output that is not a report at all", () => {
    for (const text of ["", "npm error something", "[]", "null", '"a string"']) {
      assert.throws(() => verifiedVersion(text), ActionError, JSON.stringify(text));
    }
  });

  test("refuses a version the registry answered with that is not a version", () => {
    const report = JSON.stringify({
      invalid: [],
      missing: [],
      verified: [
        {
          name: CLI_PACKAGE,
          version: "2026.815.0 && curl evil",
          attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
        },
      ],
    });
    assert.throws(() => verifiedVersion(report), /not a plain registry version/);
  });

  test("says what a failure means rather than only that it failed", () => {
    assert.throws(
      () => verifiedVersion(auditReport({ provenance: false })),
      (error) => {
        assert.match(error.hint, /refused rather than warned about/);
        assert.match(error.hint, /mirror that does not serve attestations/);
        return true;
      },
    );
  });
});

describe("what actually gets installed", () => {
  /** @param {object[]} calls */
  const globalArgs = (calls) => calls.find((call) => call.args.includes("--global")).args;

  /** The install step's log, as one string. */
  const installLog = () => {
    const h = harness();
    main(["install"], { env: { ...TOKEN }, io: h.io, spawn: fakeNpm(), staging: fakeStaging });
    return h
      .of("log")
      .map((event) => event.text)
      .join("\n");
  };

  test("is the version that verified, never the spec that was resolved", () => {
    // The whole point of verifying before installing: `latest` is resolved and
    // audited once, and the global install then names the exact version, so a
    // dist-tag that moves in between cannot slip an unaudited tarball past.
    const calls = [];
    commandInstall({
      env: { ...TOKEN },
      io: harness().io,
      spawn: fakeNpm({}, calls),
      staging: fakeStaging,
    });

    assert.ok(stagingArgs("latest").includes(`${CLI_PACKAGE}@latest`));
    assert.ok(globalArgs(calls).includes(`${CLI_PACKAGE}@${VERIFIED_VERSION}`));
    assert.ok(!globalArgs(calls).includes(`${CLI_PACKAGE}@latest`));
  });

  test("does not happen at all when the audit refuses", () => {
    const h = harness();
    const calls = [];
    const code = main(["install"], {
      env: { ...TOKEN },
      io: h.io,
      spawn: fakeNpm({ audited: { stdout: auditReport({ provenance: false }) } }, calls),
      staging: fakeStaging,
    });

    assert.equal(code, 1);
    assert.equal(
      calls.filter((call) => call.args.includes("--global")).length,
      0,
      "an unverified version was installed anyway",
    );
  });

  test("relays npm's reason when the audit exits non-zero", () => {
    const h = harness();
    const code = main(["install"], {
      env: { ...TOKEN },
      io: h.io,
      spawn: fakeNpm({
        audited: {
          status: 1,
          stderr: "npm error code ENOTFOUND",
          stdout: JSON.stringify({ error: { code: "ENOTFOUND", summary: "no route to host" } }),
        },
      }),
      staging: fakeStaging,
    });

    assert.equal(code, 1);
    const log = h
      .of("log")
      .map((event) => event.text)
      .join("\n");
    assert.match(log, /ENOTFOUND/);
  });

  test("names the verified version on the log, so a run records what it ran", () => {
    assert.match(installLog(), new RegExp(`Verified @yashau/prick@${VERIFIED_VERSION}`));
  });
});
