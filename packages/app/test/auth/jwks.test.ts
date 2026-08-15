import { beforeAll, describe, expect, it } from "vitest";

import { verifyAccessJwt } from "../../src/lib/server/auth/access.js";
import {
  JWKS_MIN_REFETCH_INTERVAL_MS,
  JWKS_TTL_MS,
  accessCertsUrl,
  findJwksKey,
  getJwks,
  resolveCertsUrl,
} from "../../src/lib/server/auth/jwks.js";
import { certsEndpoint, harnessKeys } from "./harness/client.js";
import { mintUserToken } from "./harness/mint.js";
import type { HarnessKeysResponse } from "./harness/protocol.js";
import { rejectsWith, throwsWith } from "./rejects.js";

const TEAM = "test-team";
const AUD = "test-aud";
const NOW = 1_800_000_000_000;

let keys: HarnessKeysResponse;

beforeAll(async () => {
  keys = await harnessKeys();
});

function token(kid: string, privateJwk: JsonWebKey): Promise<string> {
  return mintUserToken({ privateJwk, kid, team: TEAM, aud: AUD, now: NOW });
}

describe("certs URL resolution", () => {
  it("derives the team certs endpoint", () => {
    expect(accessCertsUrl("acme")).toBe(
      "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
    );
  });

  it("REJECTS a team name that is not a hostname label", () => {
    throwsWith(() => accessCertsUrl("acme.evil.example/"), "SERVER_MISCONFIGURED");
    throwsWith(() => accessCertsUrl(""), "SERVER_MISCONFIGURED");
    throwsWith(() => accessCertsUrl("-acme"), "SERVER_MISCONFIGURED");
  });

  it("falls back to the team default when the override is blank", () => {
    expect(resolveCertsUrl("acme", "")).toBe(accessCertsUrl("acme"));
    expect(resolveCertsUrl("acme", null)).toBe(accessCertsUrl("acme"));
    expect(resolveCertsUrl("acme", undefined)).toBe(accessCertsUrl("acme"));
  });

  it("REJECTS a plaintext certs URL", () => {
    throwsWith(() => resolveCertsUrl("acme", "http://acme.example/certs"), "SERVER_MISCONFIGURED");
  });

  it("REJECTS a certs URL carrying credentials", () => {
    throwsWith(() => resolveCertsUrl("acme", "https://u:p@acme.example/certs"), "SERVER_MISCONFIGURED");
  });

  it("REJECTS a certs URL that is not a URL", () => {
    throwsWith(() => resolveCertsUrl("acme", "not a url"), "SERVER_MISCONFIGURED");
  });
});

describe("JWKS caching", () => {
  it("fetches once and then serves from the module cache", async () => {
    const certs = certsEndpoint("primary");

    await getJwks(certs.url, NOW);
    await getJwks(certs.url, NOW + 1);
    await getJwks(certs.url, NOW + JWKS_TTL_MS - 1);

    expect(await certs.fetches()).toBe(1);
  });

  it("refetches once the 1 hour TTL has elapsed", async () => {
    const certs = certsEndpoint("primary");

    await getJwks(certs.url, NOW);
    expect(await certs.fetches()).toBe(1);

    await getJwks(certs.url, NOW + JWKS_TTL_MS);
    expect(await certs.fetches()).toBe(2);
  });

  it("keeps serving a cached key set when a refetch fails", async () => {
    const certs = certsEndpoint("flaky");

    const first = await getJwks(certs.url, NOW);
    expect(first.map((key) => key.kid)).toEqual(["access-primary"]);

    // The TTL has elapsed and the origin is now returning 500. The cached keys
    // still verify real traffic, so they are kept rather than discarded.
    const second = await getJwks(certs.url, NOW + JWKS_TTL_MS);
    expect(second.map((key) => key.kid)).toEqual(["access-primary"]);
    expect(await certs.fetches()).toBe(2);
  });

  it("keys the cache by URL, so two teams never share signing keys", async () => {
    const a = certsEndpoint("primary");
    const b = certsEndpoint("both");

    expect((await getJwks(a.url, NOW)).map((key) => key.kid)).toEqual(["access-primary"]);
    expect((await getJwks(b.url, NOW)).map((key) => key.kid)).toEqual([
      "access-primary",
      "access-rotated",
    ]);
  });
});

/**
 * Access rotates signing keys roughly every 6 weeks with a 7-day overlap. A
 * pure-TTL cache is CORRECT and still wrong in practice: for up to an hour
 * after a rotation it rejects perfectly valid tokens, intermittently, with no
 * signal an operator can act on.
 */
describe("unknown kid -- rate-limited refetch", () => {
  it("refetches on an unknown kid and picks up the rotated key", async () => {
    const certs = certsEndpoint("rotating");

    // Warm the cache while only the primary key is published.
    await verifyAccessJwt(await token(keys.primary.kid, keys.primary.privateJwk), {
      team: TEAM,
      aud: AUD,
      certsUrl: certs.url,
      now: NOW,
    });
    expect(await certs.fetches()).toBe(1);

    // A token signed by the newly rotated key. The cache cannot know it yet.
    const claims = await verifyAccessJwt(await token(keys.rotated.kid, keys.rotated.privateJwk), {
      team: TEAM,
      aud: AUD,
      certsUrl: certs.url,
      now: NOW + JWKS_MIN_REFETCH_INTERVAL_MS + 1,
    });

    expect(claims.email).toBe("Operator@Example.COM");
    expect(await certs.fetches()).toBe(2);
  });

  it("RATE-LIMITS the refetch to once per 60 s", async () => {
    const certs = certsEndpoint("primary");
    const base = { team: TEAM, aud: AUD, certsUrl: certs.url };

    // Cold cache: one fetch, and no refetch, because the data is already fresh.
    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.foreign.kid, keys.foreign.privateJwk), {
          ...base,
          now: NOW,
        }),
      "UNAUTHENTICATED",
    );
    expect(await certs.fetches()).toBe(1);

    // Past the window: one refetch.
    const afterWindow = NOW + JWKS_MIN_REFETCH_INTERVAL_MS + 1;
    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.foreign.kid, keys.foreign.privateJwk), {
          ...base,
          now: afterWindow,
        }),
      "UNAUTHENTICATED",
    );
    expect(await certs.fetches()).toBe(2);

    // Ten more attempts inside the SAME window buy the attacker nothing. This
    // is the amplification guard: an unconditional refetch-on-unknown-kid turns
    // one forged token into one outbound request to the Access origin.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await rejectsWith(
        async () =>
          verifyAccessJwt(await token(keys.foreign.kid, keys.foreign.privateJwk), {
            ...base,
            now: afterWindow + attempt,
          }),
        "UNAUTHENTICATED",
      );
    }
    expect(await certs.fetches()).toBe(2);

    // The next window opens and exactly one more fetch is allowed.
    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.foreign.kid, keys.foreign.privateJwk), {
          ...base,
          now: afterWindow + JWKS_MIN_REFETCH_INTERVAL_MS + 1,
        }),
      "UNAUTHENTICATED",
    );
    expect(await certs.fetches()).toBe(3);
  });

  it("REJECTS an unknown kid rather than trying every key", async () => {
    const certs = certsEndpoint("primary");

    await rejectsWith(
      async () => findJwksKey(certs.url, "no-such-kid", NOW),
      "UNAUTHENTICATED",
    );
  });
});

describe("JWKS documents that must not be trusted", () => {
  it("REJECTS a certs endpoint that returns HTTP 500, as RETRYABLE", async () => {
    // 503, not 500. An upstream 5xx is Access being degraded, which resolves on
    // its own -- so the caller should retry. Reporting SERVER_MISCONFIGURED here
    // would tell them to give up, and would send a human to check settings that
    // were never wrong. A 4xx from the same endpoint IS misconfiguration and is
    // covered separately below.
    const certs = certsEndpoint("broken");

    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.primary.kid, keys.primary.privateJwk), {
          team: TEAM,
          aud: AUD,
          certsUrl: certs.url,
          now: NOW,
        }),
      "IDENTITY_PROVIDER_UNAVAILABLE",
    );
  });

  it("REJECTS a JWKS document with no keys array", async () => {
    const certs = certsEndpoint("malformed");

    await rejectsWith(async () => getJwks(certs.url, NOW), "SERVER_MISCONFIGURED");
  });

  it("REJECTS every token when the JWKS is empty", async () => {
    const certs = certsEndpoint("empty");

    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.primary.kid, keys.primary.privateJwk), {
          team: TEAM,
          aud: AUD,
          certsUrl: certs.url,
          now: NOW,
        }),
      "UNAUTHENTICATED",
    );
  });

  /**
   * An entry with no `alg` is DROPPED, not tolerated.
   *
   * `verifyWithJwks` cross-checks the header algorithm against the JWKS entry
   * only when the entry declares one. An entry without `alg` therefore hands
   * the choice of algorithm back to the token header -- the exact condition
   * this module exists to make impossible. Dropping the entry turns that into
   * an unknown-kid rejection.
   */
  it("REJECTS a JWKS entry that declares no alg", async () => {
    const certs = certsEndpoint("no-alg");

    expect(await getJwks(certs.url, NOW)).toEqual([]);

    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.primary.kid, keys.primary.privateJwk), {
          team: TEAM,
          aud: AUD,
          certsUrl: certs.url,
          now: NOW,
        }),
      "UNAUTHENTICATED",
    );
  });

  it("REJECTS a JWKS entry published for encryption rather than signing", async () => {
    const certs = certsEndpoint("enc-use");

    expect(await getJwks(certs.url, NOW)).toEqual([]);

    await rejectsWith(
      async () =>
        verifyAccessJwt(await token(keys.primary.kid, keys.primary.privateJwk), {
          team: TEAM,
          aud: AUD,
          certsUrl: certs.url,
          now: NOW,
        }),
      "UNAUTHENTICATED",
    );
  });
});
