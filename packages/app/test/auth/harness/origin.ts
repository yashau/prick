/**
 * A mock Cloudflare Access origin, served to the Worker under test through
 * miniflare's `outboundService`.
 *
 * WHY THIS EXISTS RATHER THAN A FAKE VERIFIER
 *
 * The obvious way to test authorization is to inject a stub that returns
 * ready-made claims. It is also the way that leaves JWT verification -- the one
 * component in this system where a security bug is both likely and fatal --
 * executed by nothing. So the certs URL is configuration instead: a real RS256
 * keypair is generated here, its public half is served as a real JWKS at a real
 * URL, and the tests mint real tokens with the private half. `verifyAccessJwt`
 * runs unmodified.
 *
 * WHICH INTERCEPTION MECHANISM
 *
 * `@cloudflare/vitest-pool-workers` 0.21 (the Vitest 4 / miniflare 5 line) no
 * longer exports `fetchMock` from `cloudflare:test` -- the undici `MockAgent`
 * types are still in the .d.ts, but nothing exports an instance, and miniflare
 * 5's worker options have no `fetchMock` field either. `outboundService` is
 * what exists, so that is what this is built on.
 *
 * The consequence is that this file runs in NODE, in the Vitest host process,
 * while the tests run in workerd. They share no memory, so the key material and
 * the fetch counters cross as JSON over the same intercepted fetch (see
 * `protocol.ts`).
 *
 * This module is imported by `vitest.config.ts` and by nothing under `src/`.
 */

import { fileURLToPath } from "node:url";

import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

import { generateAccessKey, jwksDocument, type AccessKeyMaterial } from "./keys.js";
import {
  HARNESS_ORIGIN,
  type CertsProfile,
  type HarnessKeysResponse,
  type HarnessStatsResponse,
} from "./protocol.js";

export interface AccessHarness {
  /** Pass as miniflare's `outboundService`. */
  fetch(request: Request): Promise<Response>;
}

const CERTS_PROFILES = new Set<string>([
  "primary",
  "both",
  "rotating",
  "empty",
  "malformed",
  "broken",
  "flaky",
  "no-alg",
  "enc-use",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jwks(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function createAccessHarness(): Promise<AccessHarness> {
  // Three keypairs for the whole run. Generating one per test would add ~150 ms
  // each for no extra coverage: the JWKS is scoped per certs path, so the same
  // RSA material published under a path-scoped key set is indistinguishable
  // from freshly generated material as far as the verifier is concerned.
  const [primary, rotated, foreign] = await Promise.all([
    generateAccessKey("access-primary"),
    generateAccessKey("access-rotated"),
    generateAccessKey("access-foreign"),
  ]);

  const keysResponse: HarnessKeysResponse = {
    primary: toWire(primary),
    rotated: toWire(rotated),
    foreign: toWire(foreign),
  };

  /** Fetch counts, keyed by the FULL certs pathname. */
  const fetches = new Map<string, number>();

  /*
   * The committed Drizzle migrations, read with the pool's own
   * `readD1Migrations` and served over the same intercepted channel.
   *
   * Handing them across this way rather than through a `TEST_MIGRATIONS`
   * binding keeps the whole harness inside `test/auth/` -- there is no second
   * place in the Worker configuration that a suite has to remember to keep in
   * step, and nothing test-shaped is bound into the Worker's environment.
   */
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../../drizzle/migrations", import.meta.url)),
  );

  return {
    fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.origin !== HARNESS_ORIGIN) {
        // Loud, not silent. A test that reaches for the real internet is a
        // test whose interception has stopped working, and a network timeout
        // three minutes later is a much worse way to find that out.
        return Promise.resolve(
          json(
            {
              error: "outbound_blocked",
              message: `The Access harness refused an outbound request to ${url.origin}.`,
            },
            403,
          ),
        );
      }

      const segments = url.pathname.split("/").filter((segment) => segment !== "");

      if (url.pathname === "/keys") {
        return Promise.resolve(json(keysResponse));
      }

      if (url.pathname === "/migrations") {
        return Promise.resolve(json(migrations));
      }

      const [root, profile] = segments;

      if ((root === "certs" || root === "stats") && segments.length === 3) {
        if (profile === undefined || !CERTS_PROFILES.has(profile)) {
          return Promise.resolve(json({ error: "unknown_profile", profile }, 404));
        }

        if (root === "stats") {
          const stats: HarnessStatsResponse = { fetches: fetches.get(certsKey(url)) ?? 0 };
          return Promise.resolve(json(stats));
        }

        const key = certsKey(url);
        const count = (fetches.get(key) ?? 0) + 1;
        fetches.set(key, count);

        return Promise.resolve(serveCerts(profile as CertsProfile, count, primary, rotated));
      }

      return Promise.resolve(json({ error: "not_found", path: url.pathname }, 404));
    },
  };
}

/** Counters are keyed by the certs path, so `/stats/...` maps onto `/certs/...`. */
function certsKey(url: URL): string {
  return url.pathname.replace(/^\/stats\//, "/certs/");
}

function serveCerts(
  profile: CertsProfile,
  count: number,
  primary: AccessKeyMaterial,
  rotated: AccessKeyMaterial,
): Response {
  switch (profile) {
    case "primary":
      return jwks(jwksDocument([primary.publicJwk]));
    case "both":
      return jwks(jwksDocument([primary.publicJwk, rotated.publicJwk]));
    case "rotating":
      return jwks(
        count <= 1
          ? jwksDocument([primary.publicJwk])
          : jwksDocument([primary.publicJwk, rotated.publicJwk]),
      );
    case "empty":
      return jwks(jwksDocument([]));
    case "malformed":
      return jwks(JSON.stringify({ certificates: [] }));
    case "broken":
      return new Response("upstream exploded", { status: 500 });
    case "flaky":
      return count <= 1
        ? jwks(jwksDocument([primary.publicJwk]))
        : new Response("upstream exploded", { status: 500 });
    case "no-alg": {
      const { alg: _dropped, ...withoutAlg } = primary.publicJwk;
      return jwks(JSON.stringify({ keys: [withoutAlg] }));
    }
    case "enc-use":
      return jwks(JSON.stringify({ keys: [{ ...primary.publicJwk, use: "enc" }] }));
  }
}

function toWire(material: AccessKeyMaterial) {
  return { kid: material.kid, privateJwk: material.privateJwk, publicJwk: material.publicJwk };
}
