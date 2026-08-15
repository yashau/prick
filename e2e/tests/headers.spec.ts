/**
 * Response headers, from all three places they come from.
 *
 * This is the only suite in the repository where all three are in one process
 * at once, which is why it is worth having:
 *
 *   svelte.config.js   the CSP on server-rendered pages, emitted as a real
 *                      header by SvelteKit.
 *   _headers           the assets runtime, for responses that never invoke the
 *                      Worker at all -- so no Hono middleware can reach them.
 *   hono/secure-headers + the `noStore` middleware, for Worker responses.
 *
 * Two of those exist specifically to close gaps the third cannot: SvelteKit
 * emits its CSP as a `<meta>` tag on prerendered pages, and `frame-ancestors`
 * is specified to be IGNORED in meta CSP, so clickjacking protection has to
 * arrive as a real header from `_headers`; and static assets bypass the Worker
 * entirely.
 */

import { environmentPath, expect, harness, test } from "../fixtures";
import { ACCESS_AUD, ACCESS_KID, ACCESS_TEAM, SEED } from "../harness/constants";

const production = environmentPath(SEED.project, SEED.production);

test.describe("frame-ancestors 'none'", () => {
  test("is a real header on a server-rendered page", async ({ context }) => {
    const response = await context.request.get("/projects");
    const csp = response.headers()["content-security-policy"];

    expect(csp).toBeDefined();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    // No service worker is registered anywhere in this app, and a SW cache is a
    // plaintext secret store on disk. The directive makes an accidental
    // registration fail loudly rather than ship.
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("is a real header on the client-rendered secrets shell", async ({ context }) => {
    const response = await context.request.get(`/p/${SEED.project}/${SEED.production}`);
    const csp = response.headers()["content-security-policy"];

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  test("is a real header on a static asset, which never invokes the Worker", async ({
    context,
  }) => {
    const response = await context.request.get("/favicon.svg");
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});

test.describe("Cache-Control: no-store", () => {
  test("is on a reveal, with the two headers that make it stick", async ({ api }) => {
    const response = await api.raw(`${production}/secrets/DATABASE_URL?reason=reveal`);
    expect(response.status).toBe(200);

    expect(response.headers.get("cache-control")).toContain("no-store");
    // Cloudflare's own edge cache does not necessarily follow `Cache-Control`.
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    // So that a cached entry can never be served across identities.
    expect(response.headers.get("vary")).toBe("Cf-Access-Jwt-Assertion");
  });

  test("is on an export", async ({ api }) => {
    const response = await api.raw(`${production}/secrets:export`);
    expect(response.status).toBe(200);

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cf-Access-Jwt-Assertion");
  });

  /**
   * And NOT on the listing, which is the point of binding the middleware to two
   * paths rather than applying it globally: the choice is visible at each route,
   * and a value-returning route added without it is something to notice missing
   * rather than something to remember.
   */
  test("is not applied to routes that carry no value", async ({ api }) => {
    const response = await api.raw(`${production}/secrets`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });
});

test.describe("the API's other invariants", () => {
  /**
   * NO CORS HEADERS AT ALL, and their absence is the mechanism.
   *
   * Omitting `Access-Control-Allow-Origin` is the single thing that stops any
   * other site on the internet reading a response from this API in a logged-in
   * victim's browser. The browser enforces it for free, and it is the only
   * defence here that does not depend on this Worker getting a check right.
   */
  test("emit no CORS headers, on success or on failure", async ({ api }) => {
    const ok = await api.raw(`${production}/secrets`);
    const notFound = await api.raw("/projects/no-such-project-anywhere");

    for (const response of [ok, notFound]) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("access-control-allow-headers")).toBeNull();
    }
  });

  test("echo a supplied X-Request-Id, and mint one otherwise", async ({ api }) => {
    const supplied = "e2e-request-id-0001";
    const echoed = await api.raw("/whoami", { headers: { "X-Request-Id": supplied } });
    expect(echoed.headers.get("x-request-id")).toBe(supplied);

    const minted = await api.raw("/whoami");
    const id = minted.headers.get("x-request-id");
    expect(id).not.toBeNull();
    expect(id).not.toBe(supplied);
  });

  /**
   * A client-supplied id goes into a log line and a database column, so it is
   * length-bounded and pattern-checked. A newline in either would be a log
   * injection.
   */
  test("refuse to echo a request id that could carry a newline", async ({ api }) => {
    const response = await api.raw("/whoami", {
      headers: { "X-Request-Id": "not a valid id" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).not.toBe("not a valid id");
  });

  test("apply the transport hardening headers to Worker responses", async ({ api }) => {
    const response = await api.raw("/health");

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

test.describe("unauthenticated requests", () => {
  test("are refused with 401 and no data, except for /health", async () => {
    const base = harness.baseUrl;

    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);

    const projects = await fetch(`${base}/api/v1/projects`);
    expect(projects.status).toBe(401);

    const body = (await projects.json()) as { code: string };
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  test("are refused when the assertion is not signed by the Access key", async ({ api }) => {
    /*
     * A structurally perfect assertion -- right `kid`, right issuer, right
     * audience, an admin's address, unexpired -- whose signature is 256 bytes
     * of the number seven. Everything a verifier that decoded the claims and
     * skipped the cryptography would accept.
     */
    const forged = [
      Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", kid: ACCESS_KID })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({
          iss: `https://${ACCESS_TEAM}.cloudflareaccess.com`,
          aud: [ACCESS_AUD],
          sub: "9b1f0e6a-3c25-4f8d-9a71-2e6b4d8f0c31",
          email: "admin@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url"),
      Buffer.alloc(256, 7).toString("base64url"),
    ].join(".");

    const response = await fetch(`${api.baseUrl}/api/v1/projects`, {
      headers: { "Cf-Access-Jwt-Assertion": forged },
    });

    expect(response.status).toBe(401);
  });

  /**
   * The harness reaches no real Access origin, and the seam it uses is not a
   * weakened one.
   *
   * `ACCESS_CERTS_URL` is the only concession this application makes to being
   * testable, so it is worth asserting that the concession is exactly what it
   * claims: an override of WHERE the signing keys come from, subject to the
   * same rules as the default -- HTTPS, no embedded credentials. If it were
   * ever relaxed to accept `http://`, every deployment would gain a way to have
   * its signing keys substituted by anything on the network path, and this
   * suite would be the reason.
   *
   * Asserting `127.0.0.1` also proves the run is hermetic: a suite that had
   * quietly started fetching `https://<team>.cloudflareaccess.com` would pass
   * on a laptop and fail in an airgapped CI runner.
   */
  test("the Access seam is local and still HTTPS", () => {
    const certs = new URL(harness.certsUrl);

    expect(certs.protocol).toBe("https:");
    expect(certs.hostname).toBe("127.0.0.1");
    expect(certs.username).toBe("");
    expect(certs.password).toBe("");
    expect(certs.pathname).toBe("/cdn-cgi/access/certs");
  });
});
