// action/inputs.test.mjs — the `PRICK_INPUT_*` variables and what they are
// allowed to say. Mirrors inputs.mjs.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { ActionError } from "./errors.mjs";
import { fakeRandom, fakeSpawn, harness, inject, parseEnvFile, TOKEN } from "./harness.mjs";
import { commandInject, main } from "./inject.mjs";
import { parseBoolean, validateExportTo, validatePrefix, validateUrl } from "./inputs.mjs";

describe("parseBoolean", () => {
  test("accepts the spellings a workflow author actually writes", () => {
    for (const yes of ["true", "TRUE", " 1 ", "yes", "on"]) {
      assert.equal(parseBoolean(yes, "x", false), true, yes);
    }
    for (const no of ["false", "FALSE", "0", "no", "off"]) {
      assert.equal(parseBoolean(no, "x", true), false, no);
    }
  });

  test("falls back only when the input is absent", () => {
    assert.equal(parseBoolean("", "x", true), true);
    assert.equal(parseBoolean(undefined, "x", false), false);
  });

  test("refuses anything else", () => {
    assert.throws(() => parseBoolean("maybe", "mask", true), ActionError);
  });
});

describe("the prefix", () => {
  test("is prepended to every name", () => {
    const result = inject({ TOKEN: "t", URL: "u" }, { PRICK_INPUT_PREFIX: "APP_" });
    assert.deepEqual([...result.injected.keys()], ["APP_TOKEN", "APP_URL"]);
  });

  test("is optional", () => {
    assert.equal(validatePrefix(""), "");
    assert.equal(validatePrefix(undefined), "");
  });

  test("fails the step rather than skipping every key, when it is unusable", () => {
    // Operator configuration, not data: warning once per key would be noise
    // hiding a single mistake.
    assert.throws(() => validatePrefix("1_"), ActionError);
    assert.throws(() => validatePrefix("my-app-"), ActionError);
  });
});

describe("the url input", () => {
  test("accepts https", () => {
    assert.equal(validateUrl("https://prick.example.com"), "https://prick.example.com");
    assert.equal(validateUrl("  https://prick.example.com/  "), "https://prick.example.com/");
  });

  test("refuses plaintext, because the token travels in a header", () => {
    assert.throws(() => validateUrl("http://prick.example.com"), /only https is accepted/);
    assert.throws(() => validateUrl("ftp://prick.example.com"), /only https is accepted/);
    assert.throws(() => validateUrl("file:///etc/passwd"), /only https is accepted/);
  });

  test("refuses a URL with credentials in it", () => {
    assert.throws(() => validateUrl("https://user:pw@prick.example.com"), /userinfo/);
  });

  test("refuses a relative or empty URL", () => {
    assert.throws(() => validateUrl("prick.example.com"), /not a URL/);
    assert.throws(() => validateUrl(""), /required/);
  });

  test("does not echo the URL back, which is commonly a repository secret", () => {
    assert.throws(
      () => validateUrl("http://internal-host.example.net/path"),
      (error) => {
        assert.ok(!error.message.includes("internal-host"));
        assert.ok(!String(error.hint).includes("internal-host"));
        return true;
      },
    );
  });
});

describe("export-to", () => {
  test("defaults to env", () => {
    assert.equal(validateExportTo(""), "env");
    assert.equal(validateExportTo(undefined), "env");
  });

  test("refuses a mode that does not exist", () => {
    assert.throws(() => validateExportTo("file"), ActionError);
  });

  test("outputs mode writes a JSON object and leaves the environment alone", () => {
    const h = harness();
    commandInject({
      env: { ...TOKEN, PRICK_INPUT_EXPORT_TO: "outputs" },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"1","B":"two\\nlines"}' }),
      random: fakeRandom(),
    });

    assert.equal(h.of("env").length, 0);
    const written = parseEnvFile(h.output());
    assert.deepEqual(JSON.parse(written.get("secrets")), { A: "1", B: "two\nlines" });
  });

  test("masks in outputs mode too", () => {
    const h = harness();
    commandInject({
      env: { ...TOKEN, PRICK_INPUT_EXPORT_TO: "outputs" },
      io: h.io,
      spawn: fakeSpawn({ stdout: '{"A":"secret"}' }),
      random: fakeRandom(),
    });
    assert.deepEqual(
      h.commands("add-mask").map((e) => e.text),
      ["secret"],
    );
  });

  test("always publishes the names, and only the names", () => {
    const result = inject({ B: "v1", A: "v2" });
    const written = parseEnvFile(result.output());
    assert.equal(written.get("keys"), "A\nB");
    assert.ok(!result.output().includes("v1"));
  });
});

describe("required inputs", () => {
  /**
   * @param {Record<string, string>} env
   */
  const failsWith = (env) => {
    const h = harness();
    const code = main(["inject"], { env, io: h.io, spawn: fakeSpawn({ stdout: "{}" }) });
    assert.equal(code, 1);
    return h.commands("error")[0].text;
  };

  test("names the missing one", () => {
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_PROJECT: "" }), /`project` is required/);
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_CLIENT_ID: "" }), /client-id.*client-secret/);
    assert.match(failsWith({ ...TOKEN, PRICK_INPUT_CLIENT_SECRET: " " }), /required/);
  });

  test("says the credential is a service token, not an SSO session", () => {
    const h = harness();
    main(["inject"], {
      env: { ...TOKEN, PRICK_INPUT_CLIENT_ID: "" },
      io: h.io,
      spawn: fakeSpawn({ stdout: "{}" }),
    });
    assert.match(
      h
        .of("log")
        .map((e) => e.text)
        .join("\n"),
      /SERVICE TOKEN/,
    );
  });
});
