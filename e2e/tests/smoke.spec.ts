import { expect, test } from "@playwright/test";

/**
 * Placeholder. It asserts that the Playwright config, the TypeScript setup and
 * the runner are wired together, and nothing else.
 *
 * It deliberately does NOT hit a server: there is no `webServer` block yet
 * (see playwright.config.ts) because the local Cloudflare Access / JWKS harness
 * does not exist, and a browser test that cannot authenticate cannot assert
 * anything about an app whose every screen is behind Access.
 */
test.describe("harness", () => {
  test("the e2e project is wired up", () => {
    expect(true).toBe(true);
  });
});
