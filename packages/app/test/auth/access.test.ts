import { beforeAll, describe, expect, it } from "vitest";

import {
  ACCESS_ASSERTION_COOKIE,
  ACCESS_ASSERTION_HEADER,
  accessOptionsFromConfig,
  actorFromClaims,
  assertCtxAccess,
  extractAssertion,
  requireAssertion,
  verifyAccessJwt,
  verifyAccessRequest,
  type AccessVerifyOptions,
} from "../../src/lib/server/auth/access.js";
import { testConfig } from "./fixtures.js";
import { certsEndpoint, harnessKeys } from "./harness/client.js";
import { mintJwt, mintServiceToken, mintUserToken, type AccessTokenOptions } from "./harness/mint.js";
import type { CertsProfile, HarnessKeysResponse } from "./harness/protocol.js";
import { rejectsWith, throwsWith } from "./rejects.js";

const TEAM = "test-team";
const AUD = "test-aud";

/** A fixed instant. Nothing in the verifier reads the wall clock when `now` is set. */
const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);

let keys: HarnessKeysResponse;

beforeAll(async () => {
  keys = await harnessKeys();
});

/** Options against a certs URL nobody else in the suite uses. */
function options(profile: CertsProfile = "primary"): AccessVerifyOptions {
  return { team: TEAM, aud: AUD, certsUrl: certsEndpoint(profile).url, now: NOW };
}

type TokenOverrides = Partial<AccessTokenOptions>;

function userToken(overrides: TokenOverrides = {}): Promise<string> {
  return mintUserToken({
    privateJwk: keys.primary.privateJwk,
    kid: keys.primary.kid,
    team: TEAM,
    aud: AUD,
    now: NOW,
    ...overrides,
  });
}

function serviceToken(overrides: TokenOverrides = {}): Promise<string> {
  return mintServiceToken({
    privateJwk: keys.primary.privateJwk,
    kid: keys.primary.kid,
    team: TEAM,
    aud: AUD,
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The shapes that must be ACCEPTED
// ---------------------------------------------------------------------------

describe("verifyAccessJwt -- accepted", () => {
  it("verifies a genuine RS256 user token against the served JWKS", async () => {
    const claims = await verifyAccessJwt(await userToken(), options());

    expect(claims.iss).toBe(`https://${TEAM}.cloudflareaccess.com`);
    expect(claims.aud).toEqual([AUD]);
    expect(claims.sub).not.toBe("");
    expect(claims.email).toBe("Operator@Example.COM");
    expect(claims.exp).toBeGreaterThan(NOW_SECONDS);
  });

  it("maps a user token to a lower-cased, trimmed email subject", async () => {
    const actor = actorFromClaims(await verifyAccessJwt(await userToken(), options()));

    expect(actor).toEqual({
      kind: "user",
      subject: "operator@example.com",
      identityId: null,
      bootstrap: false,
    });
  });

  /**
   * THE service-token case. `sub` is the empty string, there is no `email`, and
   * -- the part that breaks naive verifiers -- there is NO `nbf` claim at all.
   */
  it("accepts a service token with an empty sub, a common_name and NO nbf", async () => {
    const token = await serviceToken();

    // Prove the fixture really omits nbf rather than merely back-dating it.
    const payload = JSON.parse(atob((token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).not.toContain("nbf");
    expect(Object.keys(payload)).not.toContain("email");
    expect(payload["sub"]).toBe("");

    const claims = await verifyAccessJwt(token, options());
    expect(claims.nbf).toBeUndefined();
    expect(claims.sub).toBe("");
    expect(claims.common_name).toBe("e367826f93b8d71185e03fe518aff3b4.access");

    expect(actorFromClaims(claims)).toEqual({
      kind: "service",
      subject: "e367826f93b8d71185e03fe518aff3b4.access",
      identityId: null,
      bootstrap: false,
    });
  });

  it("accepts an aud ARRAY that contains ours alongside others", async () => {
    const claims = await verifyAccessJwt(
      await userToken({ claims: { aud: ["someone-elses-aud", AUD, "another"] } }),
      options(),
    );

    expect(claims.aud).toContain(AUD);
  });

  it("accepts a token with no iat", async () => {
    const claims = await verifyAccessJwt(await userToken({ claims: { iat: undefined } }), options());
    expect(claims.iat).toBeUndefined();
  });

  it("accepts an nbf that is in the past", async () => {
    const claims = await verifyAccessJwt(
      await userToken({ claims: { nbf: NOW_SECONDS - 600 } }),
      options(),
    );
    expect(claims.nbf).toBe(NOW_SECONDS - 600);
  });
});

// ---------------------------------------------------------------------------
// The negative matrix. Every one asserts a REJECTION.
// ---------------------------------------------------------------------------

describe("verifyAccessJwt -- claim rejections", () => {
  it("rejects a wrong aud", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ claims: { aud: ["not-our-aud"] } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an aud array that does not contain ours", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(await userToken({ claims: { aud: ["alpha", "beta", "gamma"] } }), options()),
      "UNAUTHENTICATED",
    );
  });

  /**
   * A bare-string `aud` is what a generic JWT library emits and what a verifier
   * written against `aud === expected` would accept. Access never issues it.
   */
  it("rejects an aud that is a bare string rather than an array", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ claims: { aud: AUD } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an empty aud array", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ claims: { aud: [] } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a wrong iss", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await userToken({ claims: { iss: "https://evil-team.cloudflareaccess.com" } }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });

  /** Exact equality, so an issuer that merely STARTS with ours is still wrong. */
  it("rejects an iss that only has ours as a prefix", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await userToken({ claims: { iss: `https://${TEAM}.cloudflareaccess.com.evil.example` } }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an exp in the past", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ claims: { exp: NOW_SECONDS - 1 } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a missing exp", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ claims: { exp: undefined } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an nbf in the future", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(await userToken({ claims: { nbf: NOW_SECONDS + 3600 } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an iat in the future", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(await userToken({ claims: { iat: NOW_SECONDS + 3600 } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects claims carrying neither an email nor a common_name", async () => {
    const claims = await verifyAccessJwt(
      await userToken({ claims: { email: undefined } }),
      options(),
    );
    throwsWith(() => actorFromClaims(claims), "UNAUTHENTICATED");
  });

  it("rejects claims carrying BOTH an email and a common_name", async () => {
    const claims = await verifyAccessJwt(
      await userToken({ claims: { common_name: "svc.access" } }),
      options(),
    );
    throwsWith(() => actorFromClaims(claims), "UNAUTHENTICATED");
  });
});

// ---------------------------------------------------------------------------
// Signature and algorithm attacks
// ---------------------------------------------------------------------------

describe("verifyAccessJwt -- algorithm and signature rejections", () => {
  it('rejects alg: "none"', async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await userToken({ header: { alg: "none" }, strategy: { kind: "none" } }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });

  it('rejects alg: "none" spelled with capitals', async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await userToken({ header: { alg: "NONE" }, strategy: { kind: "none" } }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });

  /**
   * RS256 -> HS256 confusion, the classic.
   *
   * The RSA modulus is public: it is served in the JWKS this very test fetched.
   * If the verifier took `alg` from the token header it would import that public
   * value as an HMAC secret, recompute the same MAC the attacker did, and admit
   * the token. Taking `alg` from the JWKS ENTRY is what makes that impossible.
   */
  it("rejects an HS256 token signed with the RSA public modulus as the HMAC secret", async () => {
    const certs = certsEndpoint("primary");

    // Read the public key the way an attacker would: from the published JWKS.
    const published = (await (await fetch(certs.url)).json()) as {
      keys: { kid: string; n: string }[];
    };
    const publicModulus = published.keys[0]?.n;
    expect(publicModulus).toEqual(expect.any(String));

    const forged = await mintJwt(
      { alg: "HS256", kid: keys.primary.kid },
      {
        iss: `https://${TEAM}.cloudflareaccess.com`,
        aud: [AUD],
        sub: "attacker",
        email: "attacker@example.com",
        exp: NOW_SECONDS + 3600,
      },
      { kind: "hs256", secret: publicModulus as string },
    );

    await rejectsWith(
      async () =>
        verifyAccessJwt(forged, { team: TEAM, aud: AUD, certsUrl: certs.url, now: NOW }),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a token signed by a different keypair under a known kid", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await userToken({ strategy: { kind: "rs256", privateJwk: keys.foreign.privateJwk } }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a token whose signature is random bytes", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ strategy: { kind: "garbage" } }), options()),
      "UNAUTHENTICATED",
    );
  });

  /** The header claims a stronger RSA variant than the JWKS entry declares. */
  it("rejects a header alg that disagrees with the JWKS entry alg", async () => {
    await rejectsWith(
      async () => verifyAccessJwt(await userToken({ header: { alg: "RS512" } }), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a header with no kid", async () => {
    const token = await mintJwt(
      { alg: "RS256" },
      { iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], sub: "x", exp: NOW_SECONDS + 60 },
      { kind: "rs256", privateJwk: keys.primary.privateJwk },
    );

    await rejectsWith(async () => verifyAccessJwt(token, options()), "UNAUTHENTICATED");
  });

  it("rejects a kid that is not in the JWKS", async () => {
    await rejectsWith(
      async () =>
        verifyAccessJwt(
          await mintUserToken({
            privateJwk: keys.foreign.privateJwk,
            kid: keys.foreign.kid,
            team: TEAM,
            aud: AUD,
            now: NOW,
          }),
          options(),
        ),
      "UNAUTHENTICATED",
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe("verifyAccessJwt -- malformed tokens", () => {
  const malformed: [name: string, token: string][] = [
    ["empty string", ""],
    ["whitespace", "   "],
    ["one segment", "abc"],
    ["two segments", "abc.def"],
    ["four segments", "a.b.c.d"],
    ["empty header segment", ".eyJhIjoxfQ.sig"],
    ["non-base64url header", "!!!.eyJhIjoxfQ.sig"],
    ["header that is not JSON", "bm90LWpzb24.eyJhIjoxfQ.sig"],
    ["header that is a JSON array", "WzFd.eyJhIjoxfQ.sig"],
  ];

  for (const [name, token] of malformed) {
    it(`rejects a token that is ${name}`, async () => {
      await rejectsWith(async () => verifyAccessJwt(token, options()), "UNAUTHENTICATED");
    });
  }

  it("rejects a truncated but otherwise genuine token", async () => {
    const token = await userToken();
    await rejectsWith(
      async () => verifyAccessJwt(token.slice(0, token.length - 20), options()),
      "UNAUTHENTICATED",
    );
  });

  it("rejects a genuine token with one flipped character in its payload", async () => {
    const [header, payload, signature] = (await userToken()).split(".");
    const tampered = `${header ?? ""}.${(payload ?? "").replace(/^./, "X")}.${signature ?? ""}`;

    await rejectsWith(async () => verifyAccessJwt(tampered, options()), "UNAUTHENTICATED");
  });

  it("rejects an absurdly long assertion without decoding it", async () => {
    const token = `${"A".repeat(9000)}.${"B".repeat(10)}.${"C".repeat(10)}`;
    await rejectsWith(async () => verifyAccessJwt(token, options()), "UNAUTHENTICATED");
  });
});

// ---------------------------------------------------------------------------
// Where the assertion comes from
// ---------------------------------------------------------------------------

describe("assertion extraction", () => {
  it("prefers the Cf-Access-Jwt-Assertion header", () => {
    const request = new Request("https://prick.test/api/v1/projects", {
      headers: {
        [ACCESS_ASSERTION_HEADER]: "from-header",
        Cookie: `${ACCESS_ASSERTION_COOKIE}=from-cookie`,
      },
    });

    expect(extractAssertion(request)).toBe("from-header");
  });

  it("matches the header case-insensitively", () => {
    const request = new Request("https://prick.test/", {
      headers: { "cf-access-jwt-assertion": "from-header" },
    });

    expect(extractAssertion(request)).toBe("from-header");
  });

  it("falls back to the CF_Authorization cookie", () => {
    const request = new Request("https://prick.test/", {
      headers: { Cookie: `other=1; ${ACCESS_ASSERTION_COOKIE}=from-cookie; another=2` },
    });

    expect(extractAssertion(request)).toBe("from-cookie");
  });

  it("ignores an empty header and falls through to the cookie", () => {
    const request = new Request("https://prick.test/", {
      headers: {
        [ACCESS_ASSERTION_HEADER]: "   ",
        Cookie: `${ACCESS_ASSERTION_COOKIE}=from-cookie`,
      },
    });

    expect(extractAssertion(request)).toBe("from-cookie");
  });

  it("does not confuse a cookie whose name merely ends with ours", () => {
    const request = new Request("https://prick.test/", {
      headers: { Cookie: `NOT_CF_Authorization=nope` },
    });

    expect(extractAssertion(request)).toBeNull();
  });

  it("REJECTS a request carrying neither the header nor the cookie", () => {
    const request = new Request("https://prick.test/api/v1/projects");

    expect(extractAssertion(request)).toBeNull();
    throwsWith(() => requireAssertion(request), "UNAUTHENTICATED");
  });

  it("REJECTS a request whose cookie header has no CF_Authorization", async () => {
    const request = new Request("https://prick.test/", {
      headers: { Cookie: "session=abc; theme=dark" },
    });

    await rejectsWith(async () => verifyAccessRequest(request, options()), "UNAUTHENTICATED");
  });

  it("verifies a genuine token presented in the header", async () => {
    const request = new Request("https://prick.test/", {
      headers: { [ACCESS_ASSERTION_HEADER]: await userToken() },
    });

    const claims = await verifyAccessRequest(request, options());
    expect(claims.email).toBe("Operator@Example.COM");
  });

  it("verifies a genuine token presented in the cookie", async () => {
    const request = new Request("https://prick.test/", {
      headers: { Cookie: `${ACCESS_ASSERTION_COOKIE}=${await userToken()}` },
    });

    const claims = await verifyAccessRequest(request, options());
    expect(claims.email).toBe("Operator@Example.COM");
  });
});

// ---------------------------------------------------------------------------
// Configuration must fail closed
// ---------------------------------------------------------------------------

describe("accessOptionsFromConfig", () => {
  it("derives the certs URL from the team when none is configured", () => {
    const resolved = accessOptionsFromConfig(
      testConfig({ accessTeam: "acme", accessAud: "aud-tag" }),
    );

    expect(resolved.team).toBe("acme");
    expect(resolved.aud).toBe("aud-tag");
    expect(resolved.certsUrl).toBeUndefined();
  });

  it("passes the configured certs URL through", () => {
    const resolved = accessOptionsFromConfig(
      testConfig({ accessCertsUrl: "https://acme.example/certs" }),
    );

    expect(resolved.certsUrl).toBe("https://acme.example/certs");
  });

  it("REJECTS an unset ACCESS_AUD rather than making the aud check vacuous", () => {
    throwsWith(
      () => accessOptionsFromConfig(testConfig({ accessAud: "" })),
      "SERVER_MISCONFIGURED",
    );
  });

  it("REJECTS an unset ACCESS_TEAM", () => {
    throwsWith(
      () => accessOptionsFromConfig(testConfig({ accessTeam: "  " })),
      "SERVER_MISCONFIGURED",
    );
  });

  /** The parsed config is the only reader of these vars now. */
  it("verifies a real token from options built out of the config", async () => {
    const certs = certsEndpoint("primary");
    const resolved = accessOptionsFromConfig(
      testConfig({ accessTeam: TEAM, accessAud: AUD, accessCertsUrl: certs.url }),
      NOW,
    );

    const claims = await verifyAccessJwt(await userToken(), resolved);
    expect(claims.email).toBe("Operator@Example.COM");
  });
});

describe("assertCtxAccess", () => {
  it("is inert while REQUIRE_CTX_ACCESS is false", () => {
    expect(() => {
      assertCtxAccess({}, { requireCtxAccess: false });
    }).not.toThrow();
  });

  it("REJECTS a request with no ctx.access once it is required", () => {
    throwsWith(() => {
      assertCtxAccess({}, { requireCtxAccess: true });
    }, "UNAUTHENTICATED");
  });

  it("passes when ctx.access is present and required", () => {
    expect(() => {
      assertCtxAccess({ access: { email: "operator@example.com" } }, { requireCtxAccess: true });
    }).not.toThrow();
  });
});
