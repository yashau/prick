import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
  normaliseBaseUrl,
  parseAllowReveal,
  parseArgs,
} from "../src/config.ts";

/** `assert.throws` returns void, and these tests need the error itself. */
function caught(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return error;
  }
  assert.fail("expected a ConfigError, nothing was thrown");
}

const COMPLETE = {
  PRICK_MCP_API_URL: "https://secrets.example.com",
  PRICK_MCP_CLIENT_ID: "id.access",
  PRICK_MCP_CLIENT_SECRET: "shhh",
};

describe("loadConfig", () => {
  test("fails fast and names every missing variable", () => {
    const error = caught(() => loadConfig({}, []));

    assert.match(error.message, /PRICK_MCP_API_URL/);
    assert.match(error.message, /PRICK_MCP_CLIENT_ID/);
    assert.match(error.message, /PRICK_MCP_CLIENT_SECRET/);
    // The hint has to be actionable, not "check your configuration".
    assert.match(error.hint, /MCP client configuration/);
  });

  test("accepts the cloudflared-parity aliases", () => {
    const config = loadConfig(
      {
        PRK_URL: "https://secrets.example.com",
        CF_ACCESS_CLIENT_ID: "id.access",
        CF_ACCESS_CLIENT_SECRET: "shhh",
      },
      [],
    );

    assert.equal(config.accessClientId, "id.access");
    assert.equal(config.accessClientSecret, "shhh");
  });

  test("reveal is off by default", () => {
    assert.equal(loadConfig(COMPLETE, []).allowReveal, false);
  });

  test("reveal turns on via the env var", () => {
    assert.equal(loadConfig({ ...COMPLETE, PRICK_MCP_ALLOW_REVEAL: "true" }, []).allowReveal, true);
  });

  test("reveal turns on via the flag", () => {
    assert.equal(loadConfig(COMPLETE, ["--allow-reveal"]).allowReveal, true);
  });

  test('only the exact string "true" enables reveal', () => {
    for (const raw of ["TRUE", "True", "1", "yes", "on", "false", "", " true "]) {
      assert.equal(parseAllowReveal(raw), false, `"${raw}" must not enable reveal`);
    }
    assert.equal(parseAllowReveal("true"), true);
  });

  test("default timeout applies and out-of-range values are rejected", () => {
    assert.equal(loadConfig(COMPLETE, []).requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    assert.throws(() => loadConfig({ ...COMPLETE, PRICK_MCP_TIMEOUT_MS: "5" }, []), ConfigError);
    assert.throws(() => loadConfig({ ...COMPLETE, PRICK_MCP_TIMEOUT_MS: "abc" }, []), ConfigError);
  });

  test("an unknown log level is a config error, not a silent default", () => {
    assert.throws(
      () => loadConfig({ ...COMPLETE, PRICK_MCP_LOG_LEVEL: "verbose" }, []),
      ConfigError,
    );
  });
});

describe("parseArgs", () => {
  test("there is no flag for the client secret", () => {
    // Arguments are visible in `ps` and land in shell history. If this ever
    // starts succeeding, a credential has been given a flag.
    const error = caught(() => parseArgs(["--client-secret", "shhh"]));

    assert.match(error.message, /Unrecognised argument/);
    assert.match(error.hint, /never accepted as arguments/);
  });

  test("accepts both --flag value and --flag=value", () => {
    assert.equal(parseArgs(["--api-url", "https://a.example"]).apiUrl, "https://a.example");
    assert.equal(parseArgs(["--api-url=https://b.example"]).apiUrl, "https://b.example");
  });
});

describe("normaliseBaseUrl", () => {
  test("strips trailing slashes and keeps a base path", () => {
    assert.equal(normaliseBaseUrl("https://a.example/"), "https://a.example");
    assert.equal(normaliseBaseUrl("https://a.example/base///"), "https://a.example/base");
  });

  test("refuses plaintext http to a remote host", () => {
    // The Access service token goes out on every request. Sending it in the
    // clear to a remote host is a disclosure, not a preference.
    assert.throws(() => normaliseBaseUrl("http://secrets.example.com"), ConfigError);
  });

  test("allows plaintext http to loopback, for `wrangler dev`", () => {
    assert.equal(normaliseBaseUrl("http://localhost:8787"), "http://localhost:8787");
    assert.equal(normaliseBaseUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  });

  test("refuses embedded credentials", () => {
    assert.throws(() => normaliseBaseUrl("https://user:pass@a.example"), ConfigError);
  });

  test("refuses a query string or fragment", () => {
    assert.throws(() => normaliseBaseUrl("https://a.example?token=x"), ConfigError);
    assert.throws(() => normaliseBaseUrl("https://a.example#x"), ConfigError);
  });

  test("refuses a non-URL and a non-http scheme", () => {
    assert.throws(() => normaliseBaseUrl("secrets.example.com"), ConfigError);
    assert.throws(() => normaliseBaseUrl("ftp://a.example"), ConfigError);
  });
});
