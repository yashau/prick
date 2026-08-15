import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Smoke test only -- it proves the pool, the bindings and the Hono entry are
 * wired together. The suites that matter come later and in this order:
 *
 *   step 8  crypto: the AAD tamper suite, BEFORE any database code exists
 *   step 10 Access JWT: wrong aud / wrong iss / expired / nbf ABSENT /
 *           unknown kid / alg:none / RS->HS confusion
 *   step 11 the permission matrix, expired grants, disabled identities
 *   step 13 the partial-write regression test, the version race, expected_rev
 */
describe("GET /api/v1/health", () => {
  it("answers without authentication", async () => {
    const response = await SELF.fetch("https://prick.test/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("echoes a supplied X-Request-Id", async () => {
    const response = await SELF.fetch("https://prick.test/api/v1/health", {
      headers: { "X-Request-Id": "abc-123" },
    });

    expect(response.headers.get("X-Request-Id")).toBe("abc-123");
  });
});
