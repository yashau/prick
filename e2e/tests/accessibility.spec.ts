/**
 * `@axe-core/playwright` over every screen and every dialog, in BOTH themes.
 *
 * Both themes, because half of what axe finds on a console like this is colour
 * contrast, and contrast is a property of the palette in effect rather than of
 * the markup. That is not a hypothetical here: the light palette used to fail
 * WCAG AA on every screen in this application while the dark palette passed on
 * almost all of them. A suite that scanned one theme would have reported the
 * wrong answer, and which wrong answer it reported would have been a coin flip.
 * It is also what makes the fix checkable in both directions -- the light tokens
 * were darkened, and only a two-theme scan can show that this did not cost the
 * dark palette anything.
 *
 * The theme is selected through `prefers-color-scheme` rather than by clicking
 * the toggle, because `mode-watcher` defaults to "system" and the emulated
 * preference is what a real user with a dark desktop gets. Each block ASSERTS
 * the theme actually applied -- without that, a broken `mode-watcher` would
 * quietly turn this into the same scan run twice.
 *
 * ---------------------------------------------------------------------------
 * THE BASELINE, WHICH IS NOW EMPTY
 * ---------------------------------------------------------------------------
 * Each entry is the set of rule ids ALLOWED on that screen, and every one of
 * them is `[]`. The mechanism is kept rather than deleted, for two reasons: the
 * failure message it produces names the screen and the rule and says what to do
 * about it, and an empty list per screen is a stronger statement than no list at
 * all -- adding a screen to `SCREENS` without an entry gates it at zero too.
 *
 * The allowances that used to be here, and the changes that removed them, are
 * written out above `BASELINE`. They are kept because "why is this token
 * 0.546 and not the registry's 0.556" is a question someone will ask.
 *
 * The pressure to keep it empty is the last test in this file, which allows
 * nothing anywhere. It was a `test.fail()` while the palette was broken.
 *
 * Rule ids only, not node counts or selectors. Ids are stable; the generated
 * class selectors and `bits-*` ids are not, and node counts move with the
 * amount of data on screen.
 */

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, harness, test } from "../fixtures";
import { SEED, THEME_COOKIE } from "../harness/constants";

type Theme = "light" | "dark";

/**
 * Every screen the admin UI has.
 *
 * Listed rather than crawled: a crawl silently stops covering a screen the day
 * its link moves into a menu, and this list failing to resolve when a route is
 * renamed is the point.
 */
/**
 * The seeded administrator's identity row, so the per-identity permissions
 * screen has a static path to be listed at.
 *
 * Fixed in `e2e/seed.sql`, and fixed there deliberately — "so a failure message
 * names a row a human can find". Restated rather than imported for the same
 * reason every wire shape in `harness/api.ts` is: this project does not depend
 * on the application's source, and a row that moves should show up here as a
 * failing assertion rather than as a silently different id.
 *
 * The admin is the right subject for it: it holds a real global admin GRANT, so
 * the screen renders a scope entry, a decisive source and a role badge rather
 * than the empty state.
 */
const ADMIN_IDENTITY = "0199e2e0-0000-7000-8000-000000000021";

const SCREENS: { name: string; path: string }[] = [
  { name: "projects", path: "/projects" },
  { name: "project overview", path: `/p/${SEED.project}` },
  { name: "secrets", path: `/p/${SEED.project}/${SEED.production}` },
  { name: "history", path: `/p/${SEED.project}/${SEED.production}/history` },
  { name: "project access", path: `/p/${SEED.project}/access` },
  { name: "project settings", path: `/p/${SEED.project}/settings` },
  { name: "access", path: "/access" },
  { name: "users", path: "/users" },
  { name: "user permissions", path: `/users/${ADMIN_IDENTITY}` },
  { name: "groups", path: "/groups" },
  { name: "audit log", path: "/audit" },
  { name: "settings", path: "/settings" },
];

/**
 * WCAG 2.1 A and AA.
 *
 * `best-practice` is deliberately excluded. It mixes genuine advice with house
 * style, and a rule set that reports things a reviewer would argue with is a
 * rule set people learn to ignore.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * ---------------------------------------------------------------------------
 * EMPTY. Every screen, both themes, no allowances.
 * ---------------------------------------------------------------------------
 *
 * It did not start that way. What was listed here, and what closed it:
 *
 * `color-contrast` -- THE LIGHT PALETTE ONLY, and two distinct offenders, both
 *     of them TOKENS rather than markup, so both were one decision in
 *     `app.css` rather than nine changes to nine screens:
 *
 *       the sidebar avatar's fallback initials, `--muted-foreground` (#737373)
 *       on `--muted` (#f5f5f5), 4.34:1 against a required 4.5:1. On every
 *       screen, because it is in the app shell. `--muted-foreground` is now
 *       `oklch(0.546 0 0)`: #707070, 4.54:1.
 *
 *       the destructive badge, `text-destructive` (#e7000b) on
 *       `bg-destructive/10` (#fde6e7), 4.0:1. Audit outcomes, history
 *       tombstones, and the "cannot be decrypted" banner. `--destructive` is
 *       now `oklch(0.531 0.245 27.325)`: #d60000 on #fbe6e6, 4.55:1.
 *
 *     Lightness only, and the DARK tokens were left alone -- they are separate
 *     declarations and already cleared AA (5.86:1 and 5.31:1 respectively),
 *     which is why this file scans both themes and why a fix that traded one
 *     for the other would have been caught here.
 *
 * `aria-required-children` -- an `item-group` renders `role="list"` while
 *     containing `<button>` children, on the history and access screens. The
 *     two components that are always a direct child of one -- `audit-item` and
 *     the unknown-identities row -- now say `role="listitem"`.
 *
 * A new entry here is not a baseline, it is a regression, and the argument for
 * it has to be written down beside it.
 */
const BASELINE: Record<Theme, Record<string, string[]>> = {
  light: {
    "/projects": [],
    [`/p/${SEED.project}`]: [],
    [`/p/${SEED.project}/${SEED.production}`]: [],
    [`/p/${SEED.project}/${SEED.production}/history`]: [],
    [`/p/${SEED.project}/access`]: [],
    [`/p/${SEED.project}/settings`]: [],
    "/access": [],
    "/users": [],
    [`/users/${ADMIN_IDENTITY}`]: [],
    "/groups": [],
    "/audit": [],
    "/settings": [],
  },
  dark: {
    "/projects": [],
    [`/p/${SEED.project}`]: [],
    [`/p/${SEED.project}/${SEED.production}`]: [],
    [`/p/${SEED.project}/${SEED.production}/history`]: [],
    [`/p/${SEED.project}/access`]: [],
    [`/p/${SEED.project}/settings`]: [],
    "/access": [],
    "/users": [],
    [`/users/${ADMIN_IDENTITY}`]: [],
    "/groups": [],
    "/audit": [],
    "/settings": [],
  },
};

/**
 * The dialogs, scanned with the scope narrowed to the dialog itself.
 *
 * All three are CLEAN, in both themes, and that is a real result rather than a
 * gap: an earlier draft of this file reported contrast failures in all of them
 * and every one was an artefact of scanning mid-animation. See `settle()`.
 */
const DIALOG_BASELINE: Record<Theme, Record<string, string[]>> = {
  light: { "Add secret": [], Import: [], Export: [] },
  dark: { "Add secret": [], Import: [], Export: [] },
};

function describeViolations(violations: { id: string; help: string; nodes: unknown[] }[]): string {
  if (violations.length === 0) return "(none)";
  return violations
    .map((violation) => `${violation.id} x${String(violation.nodes.length)} — ${violation.help}`)
    .join("\n");
}

/**
 * Hold the page still, then scan.
 *
 * Both halves are load-bearing, and both were found the hard way:
 *
 *   THE PALETTE MUST ALREADY BE ON. It is now server-rendered from the
 *   `prick_theme` cookie, so a context that carries the cookie gets
 *   `class="dark"` in the first byte and there is no hydration race left to
 *   lose. The assertion is kept anyway: it is one line, and it is what would
 *   catch the cookie silently ceasing to be honoured.
 *
 *   CONTRAST IS COMPUTED FROM WHAT IS PAINTED. The registry's dialogs fade and
 *   scale in, and an element at 60% opacity has a different computed contrast
 *   ratio from the same element at rest. Zeroing the durations makes the answer
 *   the resting one, which is the only answer a user ever sees for longer than
 *   150 ms.
 */
async function settle(page: Page, theme: Theme): Promise<void> {
  const html = page.locator("html");
  if (theme === "dark") await expect(html).toHaveClass(/\bdark\b/);
  else await expect(html).not.toHaveClass(/\bdark\b/);

  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;" +
      "animation-duration:0s!important;animation-delay:0s!important}",
  });
}

async function ruleIds(page: Page, scope?: string): Promise<{ ids: string[]; detail: string }> {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (scope !== undefined) builder = builder.include(scope);

  const results = await builder.analyze();

  return {
    ids: results.violations.map((violation) => violation.id).sort(),
    detail: describeViolations(results.violations),
  };
}

const REBASELINE =
  "\n\nThis rule is not in the baseline for this screen, so it is a NEW accessibility " +
  "defect in packages/app. If it is meant to stay, it has to be argued for and added to " +
  "BASELINE in this file with a reason.";

/** The rule ids present that the baseline does not allow. */
function unexpected(ids: string[], allowed: string[]): string[] {
  return ids.filter((id) => !allowed.includes(id));
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    /*
     * `colorScheme` emulates the OS preference, which is what `mode-watcher`
     * RESOLVES from when the stored preference is "system". The cookie is what
     * the SERVER paints from. Both are set, and they agree -- setting only the
     * emulation would leave the first response light and let the class arrive
     * after hydration, which is the race this suite used to lose.
     */
    test.use({ colorScheme: theme });

    test.beforeEach(async ({ context }) => {
      // `url` alone, not `url` plus `path`: Playwright rejects the pair and
      // derives the path from the URL.
      await context.addCookies([{ name: THEME_COOKIE, value: theme, url: harness.baseUrl }]);
    });

    test(`the theme under test really is ${theme}, in the served HTML`, async ({ context }) => {
      /*
       * ASSERTED ON THE RAW RESPONSE, not on the live DOM.
       *
       * The point of moving the theme into a cookie was to put the class in the
       * first byte so there is no flash of the wrong palette, and a DOM
       * assertion cannot tell "server-rendered" from "added a moment later by
       * a script" -- which is exactly the thing that was fixed.
       */
      const html = await (await context.request.get("/projects")).text();
      const root = /<html[^>]*>/.exec(html)?.[0] ?? "";

      expect(root, "the <html> tag should be in the response").not.toBe("");
      if (theme === "dark") expect(root).toMatch(/\bclass="[^"]*\bdark\b/);
      else expect(root).not.toMatch(/\bclass="[^"]*\bdark\b/);

      // And the UA is told, so form controls and scrollbars match the page.
      expect(root).toContain(`color-scheme: ${theme}`);
    });

    for (const screen of SCREENS) {
      test(`${screen.name} matches its accessibility baseline`, async ({ page }) => {
        await page.goto(screen.path);
        // Every screen has a heading. Waiting for one means the scan runs
        // against the rendered screen rather than against a skeleton.
        await expect(page.getByRole("heading").first()).toBeVisible();
        await settle(page, theme);

        const { ids, detail } = await ruleIds(page);

        expect(
          unexpected(ids, BASELINE[theme][screen.path] ?? []),
          `axe on ${screen.path} (${theme}):\n${detail}${REBASELINE}`,
        ).toEqual([]);
      });
    }

    for (const trigger of ["Add secret", "Import", "Export"]) {
      /**
       * A dialog is a screen too.
       *
       * Each one is a portal rendered outside the page's landmark structure --
       * exactly where an unlabelled control survives a scan of the page behind
       * it. The scope is narrowed to the dialog so that the shell's own
       * violations are not attributed to it.
       */
      test(`the ${trigger} dialog matches its accessibility baseline`, async ({ page }) => {
        await page.goto(`/p/${SEED.project}/${SEED.production}`);
        await expect(
          page.getByRole("textbox", { name: "Filter secrets by key name" }),
        ).toBeVisible();

        await page.getByRole("button", { name: trigger, exact: true }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await settle(page, theme);

        const { ids, detail } = await ruleIds(page, "[role=dialog]");

        expect(
          unexpected(ids, DIALOG_BASELINE[theme][trigger] ?? []),
          `axe in the ${trigger} dialog (${theme}):\n${detail}${REBASELINE}`,
        ).toEqual([]);
      });
    }
  });
}

/**
 * The standard, stated as a test rather than as an aspiration.
 *
 * This was a `test.fail()` for as long as the palette was broken. It is a plain
 * assertion now, and it is deliberately NOT the same test as the per-screen
 * baselines above: those allow a listed rule through, so a partial regression
 * that re-added an allowance would still pass them. This one allows nothing, so
 * it is the thing that keeps the lists above empty.
 */
test.describe("the standard this suite is holding to", () => {
  test.use({ colorScheme: "light" });

  test("no screen has any WCAG A/AA violation at all", async ({ page }) => {
    const found: string[] = [];

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await settle(page, "light");

      const { ids } = await ruleIds(page);
      for (const id of ids) found.push(`${screen.path}: ${id}`);
    }

    expect(found).toEqual([]);
  });
});
