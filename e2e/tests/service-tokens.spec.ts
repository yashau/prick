/**
 * The service tokens screen, on both kinds of deployment.
 *
 * The primary Worker has no Cloudflare API token, which is the state an install
 * starts in: a global administrator is told what to set, and nobody else is
 * offered the screen at all. The second Worker holds a token for a fake
 * Cloudflare API (`harness/cloudflare-api.ts`), so the whole create, reveal and
 * revoke path runs against the Worker's real Cloudflare client.
 *
 * ---------------------------------------------------------------------------
 * THE ONE-TIME SECRET IS CHECKED WHERE IT COULD LEAK
 * ---------------------------------------------------------------------------
 * A client secret appears in exactly one response, the create, and the screen
 * holds it in component state while its panel is open. So the spec reads the
 * secret the fake issued and searches the artefacts that outlive that moment:
 * the raw HTML of the page, every `__data.json` payload SvelteKit fetched, and
 * the DOM after the panel closes. The raw HTML is the one that reaches proxy
 * logs and the back/forward cache, which is why it is fetched separately rather
 * than read off the rendered page.
 */

import type { Page } from "@playwright/test";

import { expect, harness, test } from "../fixtures";
import { SEED } from "../harness/constants";

const MASK = "•".repeat(16);

/**
 * The sidebar's link to the screen. Scoped to the sidebar because the
 * breadcrumb renders the current page as a disabled `role="link"` too.
 */
function sidebarLink(page: Page) {
  return page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Service tokens" });
}

/** Every client secret the fake Cloudflare API has issued in this run. */
async function issuedSecrets(page: Page): Promise<string[]> {
  const response = await page.request.get(`${harness.cloudflareApiUrl}/__e2e/issued`);
  return ((await response.json()) as { secrets: string[] }).secrets;
}

async function setOutage(page: Page, on: boolean): Promise<void> {
  await page.request.post(`${harness.cloudflareApiUrl}/__e2e/outage`, { data: { on } });
}

test.describe("on a Worker without a Cloudflare API token", () => {
  test("a global admin is shown the configuration hint, and no link", async ({ page }) => {
    await page.goto("/access/tokens");

    await expect(page.getByRole("heading", { name: "Service tokens", level: 1 })).toBeVisible();
    const notice = page.getByTestId("service-tokens-unconfigured");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("CF_API_TOKEN");
    await expect(notice).toContainText("CF_ACCOUNT_ID");

    // The sidebar offers the screen only once it works.
    await expect(sidebarLink(page)).toHaveCount(0);

    // The access screen carries the same hint, where an admin will look first.
    await page.goto("/access");
    await expect(page.getByTestId("service-tokens-unconfigured")).toContainText("CF_API_TOKEN");
  });

  test.describe("as a non-admin", () => {
    test.use({ role: "writer" });

    test("there is no link, and the screen explains who manages tokens", async ({ page }) => {
      await page.goto("/projects");
      await expect(page.getByRole("link", { name: "Projects" }).first()).toBeVisible();
      await expect(sidebarLink(page)).toHaveCount(0);

      await page.goto("/access/tokens");
      await expect(
        page.getByText("Service tokens are managed by global administrators"),
      ).toBeVisible();

      // The configuration hint is for global administrators only.
      await expect(page.getByTestId("service-tokens-unconfigured")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("CF_API_TOKEN");
      await expect(page.getByRole("button", { name: "Create service token" })).toHaveCount(0);
    });
  });
});

test.describe("on a Worker that manages service tokens", () => {
  // One fake Cloudflare account, and an outage toggle that affects every
  // request to it: these run one after another.
  test.describe.configure({ mode: "serial" });

  test("the sidebar links to the screen", async ({ page }) => {
    await page.goto(`${harness.cloudflareBaseUrl}/projects`);
    const link = sidebarLink(page);
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/access\/tokens$/);
    await expect(page.getByRole("button", { name: "Create service token" }).first()).toBeVisible();
  });

  test("create, reveal once, close: the secret is in no payload and gone afterwards", async ({
    page,
    uniqueSlug,
  }) => {
    const payloads: Promise<string>[] = [];
    page.on("response", (response) => {
      if (response.url().includes("__data.json")) payloads.push(response.text());
    });

    const name = uniqueSlug("deploy");
    const before = await issuedSecrets(page);

    await page.goto(`${harness.cloudflareBaseUrl}/access/tokens`);
    await page.getByRole("button", { name: "Create service token" }).first().click();

    const form = page.getByRole("dialog", { name: "Create a service token" });
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Grant a role now").click();
    await form.getByLabel("Scope").selectOption("project");
    await form.getByLabel("Project").selectOption(SEED.project);
    await form.getByRole("button", { name: "Create", exact: true }).click();

    const reveal = page.getByTestId("service-token-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText("The secret is shown once");

    const secretCell = reveal.getByTestId("service-token-secret");
    await expect(secretCell).toHaveText(MASK);
    await reveal.getByRole("button", { name: "Show client secret" }).click();

    const after = await issuedSecrets(page);
    const secret = after.find((candidate) => !before.includes(candidate));
    expect(secret, "the fake Cloudflare API should have issued one new secret").toBeDefined();
    await expect(secretCell).toHaveText(secret as string);

    // The raw HTML: no server render, so no payload and no secret.
    const html = await (
      await page.request.get(`${harness.cloudflareBaseUrl}/access/tokens`)
    ).text();
    expect(html).toContain("kit.start(app, element)");
    expect(html, "the shell must carry no hydration payload").not.toContain("node_ids");
    expect(html).not.toContain(secret);

    // The layout data the client fetches holds no secret either.
    const data = await (
      await page.request.get(`${harness.cloudflareBaseUrl}/access/tokens/__data.json`)
    ).text();
    expect(data).not.toContain(secret);
    for (const body of await Promise.all(payloads)) {
      expect(body, "a __data.json payload must not carry the client secret").not.toContain(secret);
    }

    // Closing the panel forgets it.
    await reveal.getByRole("button", { name: "I have stored the secret" }).click();
    await expect(reveal).toBeHidden();
    expect(await page.content()).not.toContain(secret);

    // The token is listed, with the record prick keeps: no secret.
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("active");
    expect(await page.content()).not.toContain(secret);
  });

  test("records stay listed when Cloudflare cannot be reached", async ({ page, uniqueSlug }) => {
    const name = uniqueSlug("outage");

    await page.goto(`${harness.cloudflareBaseUrl}/access/tokens`);
    await page.getByRole("button", { name: "Create service token" }).first().click();
    const form = page.getByRole("dialog", { name: "Create a service token" });
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: "I have stored the secret" }).click();

    await setOutage(page, true);
    try {
      await page.reload();
      await expect(page.getByTestId("service-tokens-cloudflare-unavailable")).toContainText(
        "Cloudflare could not be reached",
      );
      await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
    } finally {
      await setOutage(page, false);
    }
  });

  test("revoke, behind a confirmation, and revoked tokens on request", async ({
    page,
    uniqueSlug,
  }) => {
    const name = uniqueSlug("revoke");

    await page.goto(`${harness.cloudflareBaseUrl}/access/tokens`);
    await page.getByRole("button", { name: "Create service token" }).first().click();
    const form = page.getByRole("dialog", { name: "Create a service token" });
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: "I have stored the secret" }).click();

    const row = page.getByRole("row").filter({ hasText: name });
    // The fake, like Cloudflare, reports an expiry and no last-seen time; the
    // latter reads as unknown, never as "never used".
    await expect(row).toContainText("Expires");
    await expect(row).toContainText("Unknown");
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Revoke…" }).click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Revoke ${name}`);
    // Issued here, not adopted: no warning about other Access applications.
    await expect(confirm.getByTestId("service-token-revoke-adopted-warning")).toHaveCount(0);
    await confirm.getByRole("button", { name: "Revoke", exact: true }).click();

    await expect(row).toHaveCount(0);

    await page.getByLabel(/Show revoked/).click();
    await expect(row).toBeVisible();
    await expect(row).toContainText("revoked");
  });
});
