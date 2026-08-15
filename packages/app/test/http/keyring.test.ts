import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApi } from "../../src/lib/server/http/app.js";
import { TEST_MASTER_KEY } from "../core/fixtures.js";

/**
 * THE FAIL-CLOSED KEYRING MIDDLEWARE.
 *
 * The property: a Worker whose `MASTER_KEY` is missing, not base64, or not
 * exactly 32 bytes serves 500 `SERVER_MISCONFIGURED` to EVERY route -- including
 * `/health`, and especially `/health`.
 *
 * Why `/health` is the important case rather than the awkward exception:
 * `prk login <url>` probes it before doing anything else, and every deployment
 * guide ends with a curl of it. It is the endpoint whose answer is trusted. A
 * secrets manager that cannot load its master key cannot read or write a single
 * value, and if that endpoint answers `{"status":"ok"}` anyway then the deploy
 * looks clean, the CI run after it looks clean, and the failure surfaces hours
 * later as a decrypt error on a production read. Answering 200 there is not
 * "degraded but useful", it is reporting the opposite of the truth.
 *
 * The test harness has no `MASTER_KEY` binding at all, so `SELF` -- the Worker
 * as the pool actually boots it -- IS the misconfigured case, and the happy path
 * has to be built explicitly. That is the right way round: the default state of
 * this app, absent a valid key, is refusing to serve.
 */

const ROUTES = ["/api/v1/health", "/api/v1/projects", "/api/v1/does-not-exist"];

async function fetchWith(masterKey: string | undefined, path: string): Promise<Response> {
  const api = createApi();
  const ctx = createExecutionContext();

  const bindings = { ...env } as Record<string, unknown>;
  if (masterKey === undefined) delete bindings["MASTER_KEY"];
  else bindings["MASTER_KEY"] = masterKey;

  const response = await api.fetch(
    new Request(`https://prick.test${path}`),
    bindings as unknown as Env,
    ctx,
  );

  await waitOnExecutionContext(ctx);
  return response;
}

describe("a valid master key", () => {
  it("lets /health answer 200", async () => {
    const response = await fetchWith(TEST_MASTER_KEY, "/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("still echoes X-Request-Id", async () => {
    const api = createApi();
    const ctx = createExecutionContext();

    const response = await api.fetch(
      new Request("https://prick.test/api/v1/health", {
        headers: { "X-Request-Id": "abc-123" },
      }),
      { ...env, MASTER_KEY: TEST_MASTER_KEY } as unknown as Env,
      ctx,
    );

    await waitOnExecutionContext(ctx);
    expect(response.headers.get("X-Request-Id")).toBe("abc-123");
  });
});

describe("a broken master key fails EVERY route closed", () => {
  const BROKEN: [string, string | undefined][] = [
    ["absent", undefined],
    ["not base64", "this is not base64 !!!"],
    ["empty", ""],
    // 31 bytes. The one that matters most, because it is the one that looks
    // right: a key generated with the wrong length argument decodes cleanly and
    // is simply the wrong size. Without the length check, HKDF would stretch it
    // and the install would work -- protected by less entropy than it claims.
    ["31 bytes", btoa("0".repeat(31))],
    ["33 bytes", btoa("0".repeat(33))],
    // The upstream defect: a passphrase where a key belongs. Silently accepted
    // by a build that feeds the base64 TEXT to HKDF.
    ["a passphrase", "hunter2"],
  ];

  for (const [name, key] of BROKEN) {
    for (const route of ROUTES) {
      it(`${name} -> 500 SERVER_MISCONFIGURED on ${route}`, async () => {
        const response = await fetchWith(key, route);

        expect(response.status).toBe(500);

        const body = (await response.json()) as { code: string; message: string };
        expect(body.code).toBe("SERVER_MISCONFIGURED");

        // The message names WHAT is wrong so an operator can fix it...
        expect(body.message.length).toBeGreaterThan(0);
        // ...and never any part of the key itself, not even a prefix.
        if (key !== undefined && key.length > 3) {
          expect(body.message).not.toContain(key);
        }
      });
    }
  }

  it("does not answer 404 for an unknown route either -- the guard runs first", async () => {
    // A misconfigured Worker that still routes would leak its route table
    // through the difference between 404 and 500. More importantly it would
    // mean the guard is mounted after routing, which is the mistake this
    // assertion exists to catch.
    const response = await fetchWith(undefined, "/api/v1/does-not-exist");
    expect(response.status).toBe(500);
  });
});

describe("the Worker as the pool actually boots it", () => {
  it("has no MASTER_KEY binding, and therefore refuses /health", async () => {
    // Not a contrived case: this is `SELF`, the real Worker entry, with the
    // real bindings from vitest.config.ts. It is proof that the fail-closed
    // path is the DEFAULT rather than something a test had to arrange.
    const response = await SELF.fetch("https://prick.test/api/v1/health");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "SERVER_MISCONFIGURED",
    });
  });

  it("echoes X-Request-Id even while failing closed", async () => {
    // The id is how a user reports the failure. A 500 that drops it is a 500
    // nobody can trace.
    const response = await SELF.fetch("https://prick.test/api/v1/health", {
      headers: { "X-Request-Id": "trace-me" },
    });

    expect(response.headers.get("X-Request-Id")).toBe("trace-me");
    await expect(response.json()).resolves.toMatchObject({ request_id: "trace-me" });
  });
});
