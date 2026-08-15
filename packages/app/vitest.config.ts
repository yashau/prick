import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { createAccessHarness } from "./test/auth/harness/origin.js";

/**
 * The mock Cloudflare Access origin.
 *
 * Built once for the whole run, in Node, because miniflare's `outboundService`
 * runs in the Vitest host process. See `test/auth/harness/origin.ts` for why
 * this is an `outboundService` and not a `fetchMock`, and for why the verifier
 * is exercised for real rather than replaced by a stub.
 */
const accessHarness = await createAccessHarness();

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
 * RESOLVED (plan, "Open items to resolve during build" #3): this pinned pool
 * exposes `outboundService`, NOT `fetchMock`. `cloudflare:test` in 0.21 no
 * longer exports a `fetchMock` MockAgent (the undici mock TYPES survive in the
 * .d.ts, but nothing exports an instance), and miniflare 5 has no `fetchMock`
 * worker option either. The JWKS harness is therefore built on
 * `outboundService` -- which runs in NODE, so key material and fetch counters
 * cross into workerd as JSON. See `test/auth/harness/`.
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
        // EVERY outbound fetch from the Worker under test -- and from the test
        // files, which share its isolate -- lands here. The harness serves the
        // Access certs endpoint and refuses everything else with a 403, so a
        // test that loses its interception fails immediately and loudly rather
        // than reaching the real internet.
        outboundService: (request: Request) => accessHarness.fetch(request),
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
    // `test/` holds the suites that are about a LAYER rather than about a
    // module -- the crypto tamper matrix is the first of them. It lives outside
    // `src/` because it is deliberately written against the public surface of
    // `lib/server/crypto`, the same one the write path will use, rather than
    // against internals it could be quietly co-adapted with.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],

    /*
     * 20 s rather than Vitest's 5 s default, and this is a correctness fix
     * rather than a comfort setting.
     *
     * `singleWorker: true` above puts every test in ONE workerd isolate, while
     * Vitest still runs the test FILES in parallel. So the route-matrix tests --
     * `authentication.test.ts`'s "is a 401 on every authenticated route" and
     * `permissions.test.ts`'s per-actor matrix, each issuing dozens of requests
     * in a loop -- queue behind every other file's requests at that one isolate.
     * Their wall-clock scales with the size of the route table and with whatever
     * else is running, neither of which says anything about whether the code is
     * right.
     *
     * At 5 s that was a cliff: the full suite failed roughly one run in three on
     * a developer machine, always with `Test timed out in 5000ms` and always on a
     * different row, while the same files passed in isolation. A gate that cries
     * wolf at that rate is one people learn to re-run instead of read.
     *
     * The cost of the higher bound is that a genuinely hung test takes 20 s to
     * report instead of 5. That is worth paying against a suite that already
     * takes over a minute.
     */
    testTimeout: 20_000,
  },
});
