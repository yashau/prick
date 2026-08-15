import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RUNS AGAINST
 * ---------------------------------------------------------------------------
 * `wrangler dev` -- the same `workerd` and the same miniflare-backed D1 that
 * `wrangler deploy` produces, with the SvelteKit half present. `global-setup.ts`
 * builds it, makes a fresh database, migrates it, seeds it, and boots it; the
 * server is torn down when the run ends. There is no `webServer` block because
 * a `webServer` cannot do the parts that matter here: generate the Access
 * keypair the Worker will be configured against, and establish the TLS trust
 * that lets the real JWT verifier fetch a local JWKS.
 *
 * ---------------------------------------------------------------------------
 * ARTEFACTS
 * ---------------------------------------------------------------------------
 * `screenshot` and `video` are OFF, unconditionally, and this is a security
 * setting rather than a preference: a screenshot of the secrets table taken
 * after a Reveal is a plaintext secret written into a CI artifact that outlives
 * the run and is downloadable by anyone with read access to the repository.
 * Traces are kept only on a retry, and Playwright redacts nothing.
 *
 * The HTML reporter is CI-only for a different reason: it writes a directory of
 * vendored minified JavaScript into the working tree, and CI greps the whole
 * tree case-insensitively for a forbidden substring. A megabyte of third-party
 * minified code is an excellent way to produce a false positive.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",

  fullyParallel: true,

  // A committed `test.only` is a suite that silently stops covering anything.
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 2 : undefined,

  /*
   * 45 s rather than the 30 s default.
   *
   * `reveal.svelte.ts` holds a value for exactly 30 000 ms, and the auto-mask
   * test waits for that to elapse for real. Faking the clock would be quicker
   * and would stop testing the thing: the mask has to come back because the
   * sweep ran and the SvelteMap deletion re-rendered the cell, not because a
   * test told the page what time it was.
   */
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    /*
     * `baseURL` is deliberately NOT set here.
     *
     * The Worker's port is chosen during global setup, and this file is
     * evaluated before that runs. `e2e/fixtures.ts` overrides the option with
     * the port that was actually taken, so two runs on one machine cannot
     * collide over a hard-coded 8787.
     */
    trace: "on-first-retry",
    screenshot: "off",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
