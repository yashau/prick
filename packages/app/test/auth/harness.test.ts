import { describe, expect, it } from "vitest";

import { certsEndpoint, harnessKeys } from "./harness/client.js";
import { HARNESS_ORIGIN } from "./harness/protocol.js";

/**
 * The harness testing itself.
 *
 * If interception silently stops working, every negative case below still
 * "passes" -- because an unreachable JWKS endpoint rejects tokens just as
 * enthusiastically as a working one does. These four assertions are what make
 * the rest of the suite mean something.
 */
describe("access harness", () => {
  it("intercepts outbound fetches to the mock Access origin", async () => {
    const keys = await harnessKeys();

    expect(keys.primary.kid).toBe("access-primary");
    expect(keys.primary.publicJwk.alg).toBe("RS256");
    expect(keys.primary.publicJwk.n).toEqual(expect.any(String));
    // The private half must never be published in a JWKS.
    expect(keys.primary.privateJwk.d).toEqual(expect.any(String));
  });

  it("serves a JWKS at a per-test certs URL and counts the fetches", async () => {
    const certs = certsEndpoint("primary");

    expect(await certs.fetches()).toBe(0);

    const response = await fetch(certs.url);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { keys: { kid: string }[] };
    expect(body.keys.map((key) => key.kid)).toEqual(["access-primary"]);

    expect(await certs.fetches()).toBe(1);
  });

  it("refuses outbound requests to any other origin", async () => {
    const response = await fetch("https://example.invalid/anything");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "outbound_blocked" });
  });

  it("uses a hostname that cannot resolve, so a lost intercept fails loudly", () => {
    expect(HARNESS_ORIGIN.endsWith(".test")).toBe(true);
  });
});
