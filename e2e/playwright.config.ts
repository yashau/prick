import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite, run against `wrangler dev` (miniflare) -- the same runtime
 * the Worker is deployed to, with real D1.
 *
 * The `webServer` block is deliberately left commented out until the local
 * Access/JWKS harness exists. Starting `wrangler dev` now would produce a suite
 * that cannot authenticate and therefore cannot assert anything, and a suite of
 * skipped tests is worse than an honestly empty one.
 *
 * What this suite is FOR, once wired (plan, "Verification"):
 *
 *   - create project -> environment -> secret
 *   - assert the value is ABSENT FROM THE DOM until Reveal is clicked and the
 *     request completes; then assert auto-mask
 *   - .env import dry-run diff; export and diff
 *   - assert the audit log has secret.reveal / secret.import with the right actor
 *   - revoke a grant, reload, assert 403
 *   - assert `frame-ancestors 'none'` and `Cache-Control: no-store` land on the
 *     right responses
 *   - keyboard-only walkthrough
 *   - axe scan, both themes
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,

  // A committed `test.only` is a suite that silently stops covering anything.
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,

  // Locally: `list` only. The HTML reporter writes a `playwright-report/`
  // directory of vendored, minified JavaScript into the working tree on every
  // run -- which in this repo is not merely untidy: CI greps the whole tree
  // case-insensitively for a forbidden substring, and a megabyte of minified
  // third-party code is an excellent way to produce a false positive.
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env["PRICK_E2E_BASE_URL"] ?? "http://127.0.0.1:8787",
    trace: "on-first-retry",

    // Never `on`. A Playwright screenshot of the secrets table after a Reveal
    // is a plaintext secret written to a CI artifact that outlives the run.
    screenshot: "off",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // TODO(build order step 16): enable once the local JWKS harness exists.
  //
  // webServer: {
  //   command: 'pnpm --filter @prick/app run preview',
  //   url: 'http://127.0.0.1:8787/api/v1/health',
  //   reuseExistingServer: !process.env['CI'],
  //   timeout: 120_000
  // }
});
