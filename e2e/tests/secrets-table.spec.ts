/**
 * The masked value cell, in a real browser.
 *
 * Every assertion is written NAMELESS: the suite reveals whatever the first
 * readable row happens to be, learns its value from the screen, and asserts
 * things about that value. Hard-coding a key would tie these tests to the
 * seeded dataset and make them fail for a reason that has nothing to do with
 * masking.
 */

import type { Locator, Page } from "@playwright/test";

import { environmentPath, expect, test } from "../fixtures";
import { MASK, REVEAL_TTL_MS, SEED } from "../harness/constants";

const SECRETS = `/p/${SEED.project}/${SEED.production}`;

/**
 * The value input of the first readable row.
 *
 * Located by its accessible name rather than by key or by DOM position, so the
 * spec survives a change to what the seed puts in this environment and a change
 * to how the table is built. An undecryptable row renders an alert instead of
 * an input, so it never matches -- which is why "first readable row" needs no
 * filtering.
 */
function firstValueInput(page: Page): Locator {
  return page.getByRole("textbox", { name: /, hidden$|, revealed$/ }).first();
}

async function openSecrets(page: Page): Promise<void> {
  await page.goto(SECRETS);
  // The table is client-rendered; wait for a real row rather than a skeleton.
  await expect(firstValueInput(page)).toBeVisible();
}

test.describe("reveal", () => {
  test("the value is absent from the DOM until Reveal is clicked", async ({ page }) => {
    await openSecrets(page);

    const input = firstValueInput(page);
    const label = (await input.getAttribute("aria-label")) ?? "";
    const key = label.replace(/, (hidden|revealed)$/, "");

    // --- before -------------------------------------------------------------
    await expect(input).toHaveValue(MASK);
    await expect(input).toHaveAttribute("aria-label", `${key}, hidden`);
    /*
     * The password-manager opt-outs, which are not cosmetic: 1Password,
     * LastPass and Bitwarden all capture and SYNC field contents they believe
     * to be credentials, which would put every revealed value into a
     * third-party vault the operator never chose.
     */
    for (const attribute of ["data-1p-ignore", "data-lpignore", "data-bwignore"]) {
      expect(
        await input.getAttribute(attribute),
        `the value cell must carry ${attribute}`,
      ).not.toBeNull();
    }
    await expect(input).toHaveAttribute("readonly", /.*/);

    // --- reveal -------------------------------------------------------------
    await page.getByRole("button", { name: `Reveal ${key}` }).click();
    await expect(input).not.toHaveValue(MASK);

    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(0);
    await expect(input).toHaveAttribute("aria-label", `${key}, revealed`);

    /*
     * A reveal moves no focus, so it is silent to a screen reader without this.
     * Polite, not assertive: it announces, it does not interrupt.
     *
     * `div[aria-live]` rather than `[aria-live]`: the sonner toaster mounts a
     * `<section aria-live="polite">` on every screen, so the bare selector is
     * ambiguous and Playwright's strict mode refuses it.
     */
    const live = page.locator('div[aria-live="polite"]');
    await expect(live).toContainText(`${key} revealed`);
    // The announcement names the key. It must never carry the value.
    expect(await live.textContent()).not.toContain(value);

    // --- and it was NOT there before ----------------------------------------
    /*
     * Proved by reloading rather than by searching the document before the
     * click, because before the click the test does not know what to search
     * for. `reveal.svelte.ts` holds revealed values in a `SvelteMap` in memory
     * and nowhere else -- not in a page store, not in `localStorage` -- so a
     * reload is a complete wipe, and the freshly served document is exactly the
     * state the cell was in before anything was revealed.
     */
    await page.reload();
    await expect(firstValueInput(page)).toHaveValue(MASK);
    expect(await page.content()).not.toContain(value);
  });

  test("the value only appears after the reveal request completes", async ({ page }) => {
    await openSecrets(page);

    const input = firstValueInput(page);
    const key = ((await input.getAttribute("aria-label")) ?? "").replace(/, hidden$/, "");

    const reveal = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/") &&
        response.url().includes("/secrets/") &&
        response.status() === 200,
    );

    await page.getByRole("button", { name: `Reveal ${key}` }).click();

    // The value is not on screen while the request is in flight.
    await expect(input).toHaveValue(MASK);
    const response = await reveal;

    await expect(input).not.toHaveValue(MASK);
    expect(await input.inputValue()).toBe(((await response.json()) as { value: string }).value);
  });

  test("hiding a revealed value removes it from the document", async ({ page }) => {
    await openSecrets(page);

    const input = firstValueInput(page);
    const key = ((await input.getAttribute("aria-label")) ?? "").replace(/, hidden$/, "");

    await page.getByRole("button", { name: `Reveal ${key}` }).click();
    await expect(input).not.toHaveValue(MASK);
    const value = await input.inputValue();

    await page.getByRole("button", { name: `Hide ${key}` }).click();

    await expect(input).toHaveValue(MASK);
    expect(await page.content()).not.toContain(value);
  });

  /**
   * The auto-mask, waited out for real.
   *
   * Faking the clock would be quicker and would stop testing the thing: the
   * mask has to come back because the 250 ms sweep in `reveal.svelte.ts` ran,
   * found the entry expired, deleted it from a `SvelteMap`, and the deletion
   * re-rendered the cell. A plain `Map` would expire the value in memory and
   * leave it on the screen, which is the worst of both -- and a mocked clock
   * would pass either way.
   */
  test("a revealed value re-masks itself after the timer @slow", async ({ page }) => {
    test.setTimeout(REVEAL_TTL_MS + 30_000);

    await openSecrets(page);

    const input = firstValueInput(page);
    const key = ((await input.getAttribute("aria-label")) ?? "").replace(/, hidden$/, "");

    await page.getByRole("button", { name: `Reveal ${key}` }).click();
    await expect(input).not.toHaveValue(MASK);
    const value = await input.inputValue();

    // The countdown is live, so the cell is telling the truth about the timer
    // rather than merely having one.
    await expect(page.getByText(/^\d{1,2}s$/).first()).toBeVisible();

    await expect(input).toHaveValue(MASK, { timeout: REVEAL_TTL_MS + 10_000 });
    expect(await page.content()).not.toContain(value);

    // And the control is back to offering a reveal rather than a hide.
    await expect(page.getByRole("button", { name: `Reveal ${key}` })).toBeVisible();
  });

  test("revealing two rows and wiping clears both at once", async ({ page }) => {
    await openSecrets(page);

    const inputs = page.getByRole("textbox", { name: /, hidden$|, revealed$/ });
    const count = await inputs.count();
    test.skip(count < 2, "this environment has fewer than two readable secrets");

    const keys: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const label = (await inputs.nth(index).getAttribute("aria-label")) ?? "";
      keys.push(label.replace(/, (hidden|revealed)$/, ""));
    }

    const values: string[] = [];
    for (const key of keys) {
      await page.getByRole("button", { name: `Reveal ${key}` }).click();
      const input = page.getByRole("textbox", { name: `${key}, revealed` });
      await expect(input).not.toHaveValue(MASK);
      values.push(await input.inputValue());
    }

    await expect(page.getByText("2 revealed")).toBeVisible();

    await page.getByRole("button", { name: /hide all/i }).click();

    const html = await page.content();
    for (const value of values) expect(html).not.toContain(value);
  });
});

test.describe("adding a secret", () => {
  /**
   * In an environment of its own.
   *
   * The suite is fully parallel against one D1, and the seeded `atlas` project
   * is read-only for that reason. A write into it from here would change the
   * row set another spec is counting.
   */
  test("the new row appears masked, and the typed value leaves the document", async ({
    page,
    adminApi,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("add");
    await adminApi.request("/projects", { method: "POST", body: { slug: project, name: "Add" } });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    await page.goto(`/p/${project}/production`);
    await expect(page.getByRole("button", { name: "Add secret" }).first()).toBeVisible();

    const key = "E2E_ADDED_KEY";
    const value = "e2e-typed-value-3f9c1a";

    await page.getByRole("button", { name: "Add secret" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Key", { exact: true }).fill(key);
    await dialog.getByLabel("Value", { exact: true }).fill(value);
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(dialog).toBeHidden();

    /*
     * MASKED IMMEDIATELY. The value the operator just typed is not carried into
     * the new row -- the table re-reads from the server, which returns key
     * names only, so seeing it again costs an audited reveal like any other.
     */
    const input = page.getByRole("textbox", { name: `${key}, hidden` });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(MASK);

    expect(await page.content()).not.toContain(value);
  });
});

test.describe("a row that cannot be decrypted", () => {
  /*
   * `e2e/seed.sql` puts a v0.1 envelope with an all-zero `kid` -- a key id no
   * ring can hold, because `kid` is derived by HKDF from the master key and
   * cannot come out as sixteen zeroes -- alone in `atlas/quarantine`. Alone,
   * so that the export specs have an environment they can legitimately export
   * in full.
   */
  test("renders a destructive alert, not a silent gap", async ({ page }) => {
    await page.goto(`/p/${SEED.project}/${SEED.quarantine}`);

    /*
     * The whole point. Upstream's `catch { /* skip *\/ }` turned a tampered row
     * into a quietly SHORTER `.env` file, which is how an environment deploys
     * without its `DATABASE_URL` and nobody finds out until the outage. Here
     * the row is present, marked, and says which of the two possible causes to
     * investigate -- "the key id is gone" and "these bytes were altered" need
     * opposite responses.
     */
    const rowAlert = page.getByRole("alert").filter({ hasText: "Cannot decrypt" });
    await expect(rowAlert).toBeVisible();
    await expect(rowAlert).toContainText(/sealed under a key id|bytes have been altered/i);

    // And a banner above the table, so the count is visible without scrolling.
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /cannot be decrypted/i })
        .first(),
    ).toBeVisible();

    // The broken row has no reveal control at all: there is nothing to reveal,
    // and offering one would produce an error toast instead of an explanation.
    await expect(page.getByRole("button", { name: /^Reveal LEGACY_API_TOKEN$/ })).toHaveCount(0);
  });

  test("the API refuses to reveal it and refuses to export around it", async ({ api }) => {
    const quarantine = environmentPath(SEED.project, SEED.quarantine);

    const listing = await api.raw(`${quarantine}/secrets`);
    expect(listing.status).toBe(200);

    const rows = listing.body as { key: string; unreadable: boolean; kid: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unreadable).toBe(true);
    expect(rows[0]?.kid).toBe("0000000000000000");

    // A reveal FAILS. It is never downgraded to an empty string, an omitted
    // key or a null.
    const revealed = await api.raw(`${quarantine}/secrets/LEGACY_API_TOKEN?reason=reveal`);
    expect(revealed.status).toBe(500);
    expect(["UNKNOWN_KID", "DECRYPT_FAILED"]).toContain((revealed.body as { code: string }).code);

    // And ONE unreadable row fails the WHOLE export, rather than producing a
    // file that is silently one variable short.
    const exported = await api.raw(`${quarantine}/secrets:export`);
    expect(exported.status).toBe(500);
  });
});
