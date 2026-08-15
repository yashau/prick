import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Worker integration tests: the real Hono app, against a real D1, in miniflare.
 *
 * API NOTE: as of @cloudflare/vitest-pool-workers 0.21 (the Vitest 4 line) the
 * `@cloudflare/vitest-pool-workers/config` subpath and `defineWorkersConfig()`
 * no longer exist. The pool is now a Vite PLUGIN -- `cloudflareTest(options)`
 * -- taking what used to be `test.poolOptions.workers`. The package ships a
 * codemod (`@cloudflare/vitest-pool-workers/codemods/vitest-v3-to-v4`) that
 * performs exactly this rewrite; every tutorial still shows the old shape.
 *
 * `main` points at the Hono-only test entry rather than at the deployed
 * `.svelte-kit/cloudflare/_worker.js`, so the server suite never needs a
 * SvelteKit build. The crypto and write-path tests are the ones that must stay
 * fast and always-green; making them wait on a UI build is how a suite stops
 * being run.
 *
 * Access is stubbed by making the certs URL CONFIGURATION: the setup generates
 * a real RS256 keypair and serves it as JWKS, so the tests exercise the REAL
 * verifier end to end rather than injecting a fake one. That distinction is the
 * whole point -- JWT verification is exactly where a security bug would live,
 * so it is the last thing that should be mocked out. A sentinel grep on the
 * built Worker ensures the test URL never ships.
 *
 * OPEN ITEM (plan, "Open items to resolve during build" #3): confirm whether
 * this pinned pool exposes `fetchMock` or `outboundService` before building the
 * JWKS harness on either.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/lib/server/http/test-entry.ts",
      // One isolate for the whole run: fixtures are seeded per test and
      // cross-worker isolation would only buy parallelism this suite does not
      // need yet.
      singleWorker: true,
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          ACCESS_TEAM: "test-team",
          ACCESS_AUD: "test-aud",
          BOOTSTRAP_ADMINS: "",
          REQUIRE_CTX_ACCESS: "false",
          SECRET_MAX_BYTES: "65536",
          ENV_MAX_SECRETS: "500",
          BODY_MAX_BYTES: "1048576",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
