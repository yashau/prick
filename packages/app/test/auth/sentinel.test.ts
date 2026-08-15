import { describe, expect, it } from "vitest";

import { HARNESS_ORIGIN } from "./harness/protocol.js";

/**
 * The harness must never reach the deployed Worker.
 *
 * The seam that makes the real verifier testable is `ACCESS_CERTS_URL` -- a
 * legitimate piece of Worker configuration -- and NOT a code path. Nothing
 * under `src/` may reference the mock origin, import anything from `test/`, or
 * carry a branch that behaves differently under test. This asserts exactly
 * that, over the whole shipped source tree rather than over a list somebody has
 * to remember to extend.
 *
 * Vite inlines these at transform time, so the check runs against the same
 * files the bundler will consume.
 */
const SHIPPED_SOURCES = import.meta.glob(
  // Colocated `*.test.ts` files are not shipped -- nothing in the Worker graph
  // imports them -- so they are excluded rather than allowed to fail the check.
  ["../../src/**/*.ts", "!../../src/**/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Substrings that would mean a test-only seam had leaked into the Worker. */
const FORBIDDEN: [name: string, needle: string][] = [
  ["the mock Access origin", HARNESS_ORIGIN],
  ["the mock Access hostname", "access-harness"],
  ["an import from the test tree", "test/auth/"],
  ["an import from the harness", "harness/"],
  ["a vitest import", "from \"vitest\""],
  ["the cloudflare:test module", "cloudflare:test"],
  ["a NODE_ENV test branch", "NODE_ENV"],
  ["an import.meta.vitest block", "import.meta.vitest"],
];

describe("the Access harness never ships", () => {
  it("finds the shipped source tree", () => {
    const paths = Object.keys(SHIPPED_SOURCES);

    expect(paths.length).toBeGreaterThan(10);
    expect(paths.some((path) => path.endsWith("/auth/access.ts"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/auth/jwks.ts"))).toBe(true);
  });

  for (const [name, needle] of FORBIDDEN) {
    it(`has no ${name} anywhere under src/`, () => {
      const offenders = Object.entries(SHIPPED_SOURCES)
        .filter(([, contents]) => contents.includes(needle))
        .map(([path]) => path);

      expect(offenders).toEqual([]);
    });
  }

  /**
   * The certs URL is configuration, and its DEFAULT is the real Access
   * endpoint. A default that pointed anywhere else would make "forgot to set
   * ACCESS_CERTS_URL" a silent authentication bypass rather than a 503.
   */
  it("defaults the certs URL to the real Cloudflare Access endpoint", async () => {
    const { accessCertsUrl, resolveCertsUrl } = await import(
      "../../src/lib/server/auth/jwks.js"
    );

    expect(accessCertsUrl("acme")).toBe("https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
    expect(resolveCertsUrl("acme", undefined)).toBe(
      "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
    );
  });
});
