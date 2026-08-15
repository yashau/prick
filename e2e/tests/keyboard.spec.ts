/**
 * The secrets table, operated with a keyboard and nothing else.
 *
 * This is not an accessibility box-tick sitting next to the axe scan; the two
 * find different things. axe reads the static tree and reports what is
 * *labelled* wrongly. Only driving the thing finds a control that cannot be
 * reached by Tab, a shortcut that fires while the operator is typing in a
 * filter box, or a dialog that traps focus and never gives it back.
 *
 * It matters here more than it would elsewhere: the people who use a secrets
 * console are operators, mid-incident, and "click the eye icon" is not a
 * recovery procedure. Every destructive and every revealing control on this
 * screen has to be reachable and operable from the keyboard.
 *
 * As with the rest of the browser specs, nothing below names a key or a value:
 * the table's contents come from the fixture seam today and from D1 after
 * cutover, and these assertions must not care.
 */

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { MASK, SEED } from "../harness/constants";

const SECRETS = `/p/${SEED.project}/${SEED.production}`;

/** A description of whatever currently holds focus, for a readable failure. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "<body>";

    const label =
      element.getAttribute("aria-label") ??
      element.textContent?.trim().replace(/\s+/g, " ").slice(0, 60) ??
      "";

    return `${element.tagName.toLowerCase()}${label === "" ? "" : `[${label}]`}`;
  });
}

/**
 * Open the secrets screen and wait for the REAL table.
 *
 * The gate is the filter box, not a table row. `table-skeleton.svelte` renders
 * five `<tr>`s with the same column layout while the data loads -- deliberately,
 * so the page does not jump -- so "a row is visible" is true a beat before the
 * component that owns the `/` shortcut has mounted and registered its listener.
 * The filter box exists only in the loaded table.
 */
async function openSecrets(page: Page): Promise<Locator> {
  await page.goto(SECRETS);
  const filter = page.getByRole("textbox", { name: "Filter secrets by key name" });
  await expect(filter).toBeVisible();
  return filter;
}

/**
 * Move focus off whatever holds it, deterministically.
 *
 * Not `body.click()`: that clicks the centre of the viewport, which on this
 * screen is a table cell containing a text input -- and the `/` shortcut
 * correctly declines to fire while an input has focus, so the test would fail
 * on the very guard it is about to rely on.
 */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/**
 * Tab until `predicate` matches, or give up.
 *
 * Bounded rather than unbounded so that a focus trap fails as a test rather
 * than as a hung run, and the collected trail is what the failure reports --
 * "never reached the reveal control" is not actionable; the twenty things it
 * did reach is.
 */
async function tabUntil(
  page: Page,
  predicate: (description: string) => boolean,
  limit = 40,
): Promise<string[]> {
  const trail: string[] = [];

  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const description = await focused(page);
    trail.push(description);
    if (predicate(description)) return trail;
  }

  throw new Error(`Never reached the target in ${String(limit)} tabs. Trail:\n${trail.join("\n")}`);
}

test.describe("keyboard-only", () => {
  test("the / shortcut focuses the filter, and does not fire while typing", async ({ page }) => {
    const filter = await openSecrets(page);

    await blur(page);
    await page.keyboard.press("/");
    await expect(filter).toBeFocused();

    /*
     * And a literal slash reaches the box it just focused.
     *
     * The handler bails when the event target is an input, which is what stops
     * the shortcut from eating a keystroke out of the field it exists to focus.
     * A secret key cannot contain `/`, but the filter is a text box and an
     * operator typing a path into it should get the character.
     */
    await page.keyboard.type("a/b");
    await expect(filter).toHaveValue("a/b");
  });

  test("filtering narrows the table and can be cleared from the keyboard", async ({ page }) => {
    const filter = await openSecrets(page);

    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();

    await blur(page);
    await page.keyboard.press("/");
    await expect(filter).toBeFocused();

    await page.keyboard.type("zzz-matches-nothing");
    await expect(filter).toHaveValue("zzz-matches-nothing");

    // The registry's `empty` state, not a blank table body: "no rows" and "no
    // matches" look identical and mean different things.
    await expect(page.getByText(/^Nothing matches/i)).toBeVisible();

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(filter).toHaveValue("");
    await expect(rows).toHaveCount(total);
  });

  test("a value can be revealed and hidden without a mouse", async ({ page }) => {
    await openSecrets(page);

    const key = (
      (await page
        .getByRole("textbox", { name: /, hidden$/ })
        .first()
        .getAttribute("aria-label")) ?? ""
    ).replace(/, hidden$/, "");
    expect(key).not.toBe("");

    /*
     * Pinned to THIS key, matching either state.
     *
     * A locator of `{ name: /, hidden$/ }.first()` re-resolves on every use,
     * so the moment the row is revealed its accessible name changes and the
     * locator silently moves to the NEXT still-hidden row -- and the assertion
     * that the value appeared then fails against a cell nobody touched.
     */
    const input = page.getByRole("textbox", { name: new RegExp(`^${key}, (hidden|revealed)$`) });
    await expect(input).toBeVisible();

    // Start from a known place, then walk forwards the way an operator would.
    await page.getByRole("textbox", { name: "Filter secrets by key name" }).focus();
    const trail = await tabUntil(page, (description) => description.includes(`Reveal ${key}`));

    // Nothing in the trail is a dead end: every stop reported a tag, so focus
    // never landed on `<body>` mid-sequence, which is what a trap looks like.
    expect(trail).not.toContain("<body>");

    // Enter, not a click. A `<button>` that only responds to a pointer is the
    // classic form of this bug.
    await page.keyboard.press("Enter");
    await expect(input).not.toHaveValue(MASK);
    const value = await input.inputValue();

    // The same control now offers the inverse, and says so to assistive tech.
    const hide = page.getByRole("button", { name: `Hide ${key}` });
    await expect(hide).toBeVisible();
    await expect(hide).toHaveAttribute("aria-pressed", "true");

    // And it can be operated from the keyboard too.
    await hide.focus();
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue(MASK);
    expect(await page.content()).not.toContain(value);
  });

  /**
   * The defect this file used to record, now fixed.
   *
   * `secret-value-cell.svelte` used to set `disabled={busy}` on the reveal
   * toggle while `SecretsController.revealKey` held the key busy for the
   * duration of the request. Disabling a focused element blurs it, and nothing
   * focused it again -- so a keyboard operator who revealed a value was dropped
   * to the top of the document on EVERY reveal and had to Tab all the way back
   * in to hide it.
   *
   * The control is `aria-disabled` now, with the handler enforcing it, so focus
   * never moves in the first place. Asserted as "still focused after the state
   * settled", which is the property that matters and is agnostic about how it
   * was achieved: restoring focus explicitly would pass this too.
   */
  test("focus stays on the reveal toggle across the request", async ({ page }) => {
    await openSecrets(page);

    const key = (
      (await page
        .getByRole("textbox", { name: /, hidden$/ })
        .first()
        .getAttribute("aria-label")) ?? ""
    ).replace(/, hidden$/, "");

    const toggle = page.getByRole("button", { name: `Reveal ${key}` });
    await toggle.focus();
    await page.keyboard.press("Enter");

    /*
     * The SAME control, which has renamed itself to its inverse. Waiting on
     * `Hide` rather than on the reveal is what makes this a test of the settled
     * state -- asserting focus while the request is still in flight would pass
     * against the old `disabled` version for the first frame.
     */
    const hide = page.getByRole("button", { name: `Hide ${key}` });
    await expect(hide).toBeFocused({ timeout: 5000 });

    // And it is genuinely operable from where focus was left, rather than merely
    // holding a highlight: one more Enter puts the value back.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: `${key}, hidden` })).toHaveValue(MASK);
    await expect(page.getByRole("button", { name: `Reveal ${key}` })).toBeFocused();
  });

  test("Shift+Tab walks back out again, so the table is not a trap", async ({ page }) => {
    const filter = await openSecrets(page);
    await filter.focus();

    const forwards: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      forwards.push(await focused(page));
    }

    const backwards: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Shift+Tab");
      backwards.push(await focused(page));
    }

    // Back where it started, having visited the same stops in reverse.
    await expect(filter).toBeFocused();
    expect(backwards.slice(0, -1).reverse()).toEqual(forwards.slice(0, -1));
  });

  test("a dialog takes focus, traps it deliberately, and gives it back on Escape", async ({
    page,
  }) => {
    await openSecrets(page);

    const trigger = page.getByRole("button", { name: "Add secret" });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    /*
     * Inside a modal, a focus trap is CORRECT -- Tab must cycle within it, or
     * a keyboard user lands on the page behind an overlay they cannot see.
     * Twenty tabs and focus is still in the dialog.
     */
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return active === null ? false : active.closest("[role=dialog]") !== null;
      });
      expect(inside, "focus escaped the modal dialog").toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // And it is returned to the control that opened it, not to the top of the
    // document.
    await expect(trigger).toBeFocused();
  });

  test("nothing on the screen fights the document's own tab order", async ({ page }) => {
    await openSecrets(page);

    /*
     * A positive `tabindex` moves an element to the front of the whole
     * document's order, which reorders every other control on the page around
     * it. It is almost always a mistake and it is invisible until someone tries
     * to Tab through the screen -- which is this file's job.
     */
    const positive = await page.evaluate(() =>
      [...document.querySelectorAll("[tabindex]")]
        .map((element) => Number(element.getAttribute("tabindex")))
        .filter((value) => value > 0),
    );

    expect(positive).toEqual([]);
  });
});
