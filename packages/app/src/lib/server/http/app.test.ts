import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApi } from "./app.js";
import { TEST_MASTER_KEY } from "../../../../test/core/fixtures.js";

/**
 * Smoke test: the pool, the bindings and the Hono entry are wired together.
 *
 * NOTE ON WHY THIS BUILDS ITS OWN ENV rather than using `SELF`. The keyring
 * middleware is mounted ahead of every route, so an app with no `MASTER_KEY`
 * refuses everything -- and the test harness deliberately binds no master key.
 * `SELF` is therefore the FAIL-CLOSED case, and it is asserted as such in
 * `test/http/keyring.test.ts`. The happy path has to supply a key, which is the
 * right way round: serving is the thing that requires configuration.
 *
 * The suites that matter come later and in this order:
 *
 *   step 8  crypto: the AAD tamper suite, BEFORE any database code exists
 *   step 10 Access JWT: wrong aud / wrong iss / expired / nbf ABSENT /
 *           unknown kid / alg:none / RS->HS confusion
 *   step 11 the permission matrix, expired grants, disabled identities
 *   step 13 the partial-write regression test, the version race, expected_rev
 */
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const api = createApi();
  const ctx = createExecutionContext();

  const response = await api.fetch(
    new Request(`https://prick.test${path}`, { headers }),
    { ...env, MASTER_KEY: TEST_MASTER_KEY } as unknown as Env,
    ctx,
  );

  await waitOnExecutionContext(ctx);
  return response;
}

describe("GET /api/v1/health", () => {
  it("answers without authentication", async () => {
    const response = await get("/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("identifies the service, so a captive portal cannot pass for one", async () => {
    // A 200 with a JSON body is not on its own evidence of anything. `prk login`
    // compares this constant before it decides where to send a credential.
    const response = await get("/api/v1/health");

    await expect(response.json()).resolves.toMatchObject({ service: "prick" });
  });

  it("echoes a supplied X-Request-Id", async () => {
    const response = await get("/api/v1/health", { "X-Request-Id": "abc-123" });

    expect(response.headers.get("X-Request-Id")).toBe("abc-123");
  });

  it("generates a time-sortable request id when none is supplied", async () => {
    const response = await get("/api/v1/health");
    const id = response.headers.get("X-Request-Id") ?? "";

    // Version nibble 7. A v4 id here would sort arbitrarily against the audit
    // rows the request produced, which is the entire reason the id is not
    // `crypto.randomUUID()`.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("replaces a malformed client-supplied id rather than storing it", async () => {
    // The id reaches a log line and a database column, so it is
    // pattern-checked rather than trusted. An unrecognised value is REPLACED,
    // not echoed and not rejected -- a request should not fail because a proxy
    // put something unexpected in a tracing header.
    //
    // (A literal newline cannot even be tested from here: `Request` refuses to
    // construct with one. The bound and the character class are what stop
    // everything a header CAN carry.)
    const messy = `${"x".repeat(200)} ; drop`;
    const response = await get("/api/v1/health", { "X-Request-Id": messy });

    const id = response.headers.get("X-Request-Id") ?? "";
    expect(id).not.toBe(messy);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("unknown endpoints", () => {
  it("answer 401 to an unauthenticated caller, not 404", async () => {
    /*
     * The route table is not enumerable without a credential.
     *
     * Authentication is mounted with `v1.use("*", ...)` ahead of every route
     * under `/api/v1`, so an anonymous caller is refused BEFORE routing decides
     * whether the path exists. The alternative -- routing first, so an unknown
     * path 404s and a known one 401s -- turns the status code into a route
     * oracle: an unauthenticated attacker could map the whole surface, including
     * any endpoint added later, by diffing 404 against 401.
     *
     * It is the same argument as `test/http/keyring.test.ts`'s assertion that a
     * misconfigured Worker answers 500 rather than 404 for an unknown route:
     * whichever guard runs first must run before routing, or its absence shows
     * through the status code.
     */
    const response = await get("/api/v1/nope");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("still carry the standard envelope and the request id", async () => {
    const response = await get("/api/v1/nope", { "X-Request-Id": "trace-me" });

    expect(response.headers.get("X-Request-Id")).toBe("trace-me");
    await expect(response.json()).resolves.toMatchObject({ request_id: "trace-me" });
  });

  it("404 outside the versioned prefix, where there is nothing to protect", async () => {
    const response = await get("/nope");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });
});
