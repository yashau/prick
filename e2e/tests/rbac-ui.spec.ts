/**
 * The `/users` and `/groups` screens, driven as a person drives them.
 *
 * `groups.spec.ts` proves the MODEL: a group grant confers a role, removing the
 * membership takes it back, and `effective-permissions` explains both. It does
 * that entirely through the API, because until now there was no UI to navigate
 * to. This file is the other half — the same properties, asserted against what
 * is actually rendered, because a screen that reads the right data and displays
 * the wrong thing is a screen that will be trusted during an incident.
 *
 * Three things are worth stating about what is checked here:
 *
 *   THE DECISIVE SOURCE IS ON THE PAGE. `GET /grants` lists direct grants only;
 *   a group's grants live under `/groups/{id}/grants`. So "why can this identity
 *   write production" is not answerable from either list, and the assertion that
 *   matters is that the identity screen NAMES the group and marks it decisive.
 *
 *   THE AUTHORIZATION SPLIT IS RENDERED, not merely enforced. Creating a group
 *   and changing its membership need GLOBAL admin; granting it a role needs
 *   admin AT THAT SCOPE. A project admin is therefore shown the grant control
 *   and not the membership one — a button that 403s is a worse answer than no
 *   button.
 *
 *   THE GROUP SCREEN IS SCANNED BY AXE. `accessibility.spec.ts` lists screens
 *   statically and `/groups/{id}` is addressed by a uuid that does not exist
 *   until a group does, so its two-theme scan lives here instead, against a
 *   group that has members and grants rather than an empty one.
 *
 * ---------------------------------------------------------------------------
 * EVERY INTERACTION BELOW IS HYDRATION-SAFE, AND HAS TO BE
 * ---------------------------------------------------------------------------
 * These screens are server-rendered, so their buttons and tabs are in the
 * document — visible, clickable and inert — from the first byte until SvelteKit
 * attaches the handlers. A single click is a race the suite loses often enough
 * to matter and quietly enough to be blamed on something else. `openDialog` and
 * `selectTab` retry against the STATE they are trying to reach rather than
 * sleeping, so a slow hydration is a slower pass and a control genuinely wired
 * to nothing is still a failure. `journey.spec.ts` solves the same problem the
 * same way, for the same reason.
 */

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, harness, test } from "../fixtures";
import type { IdentityRecord } from "../fixtures";
import { SUBJECTS, THEME_COOKIE } from "../harness/constants";

interface GroupRecord {
  id: string;
  slug: string;
  name: string;
}

/** WCAG 2.1 A and AA, matching `accessibility.spec.ts`. `best-practice` is excluded there too. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function identityId(
  api: { request: <T>(path: string) => Promise<T> },
  subject: string,
): Promise<string> {
  const identities = await api.request<IdentityRecord[]>("/identities");
  const identity = identities.find((entry) => entry.subject === subject);
  expect(identity, `the ${subject} identity exists after its first request`).toBeDefined();
  return identity?.id ?? "";
}

/** Open a dialog on a server-rendered screen. See the header. */
async function openDialog(page: Page, trigger: string | RegExp): Promise<Locator> {
  const button = page.getByRole("button", { name: trigger }).first();
  await expect(button).toBeVisible();

  const dialog = page.getByRole("dialog");

  await expect(async () => {
    if (!(await dialog.isVisible())) await button.click();
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  return dialog;
}

/** Select a tab, retrying until it reports itself selected. */
async function selectTab(page: Page, name: RegExp): Promise<void> {
  const tab = page.getByRole("tab", { name });
  await expect(tab).toBeVisible();

  await expect(async () => {
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

/** Click a control that only does anything once hydrated, and wait for the effect. */
async function clickUntil(button: Locator, settled: () => Promise<void>): Promise<void> {
  await expect(button).toBeVisible();
  await expect(async () => {
    await button.click();
    await settled();
  }).toPass({ timeout: 20_000 });
}

test.describe("the users screen", () => {
  test("lists every identity and says what the grants tab leaves out", async ({ page }) => {
    await page.goto("/users");

    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();

    // The four seeded identities, by subject — the only handle a service token
    // has, and the reason the subject is always rendered next to the name.
    for (const subject of Object.values(SUBJECTS)) {
      await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
    }

    /*
     * The caveat that makes the permissions screen necessary. The grants tab
     * lists DIRECT grants; anything conferred by a group is not in it, and a
     * table that quietly omitted them would be read as complete.
     */
    await selectTab(page, /Direct grants/);
    await expect(page.getByText("This is not the whole access graph")).toBeVisible();
  });
});

test.describe("a group, from creation to a role somebody actually holds", () => {
  test("names the group as the decisive source, and stops when the membership does", async ({
    page,
    adminApi,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("rbac");
    const slug = uniqueSlug("deploy");
    const name = `Deploy ${slug}`;

    await adminApi.request("/projects", {
      method: "POST",
      body: { slug: project, name: "RBAC UI" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const reader = await identityId(adminApi, SUBJECTS.reader);

    // --- create it, in the browser ------------------------------------------
    await page.goto("/groups");

    const create = await openDialog(page, "New group");
    await create.getByLabel("Name", { exact: true }).fill(name);
    await create.getByLabel("Slug", { exact: true }).fill(slug);
    await create.getByRole("button", { name: "Create group" }).click();
    await expect(create).toBeHidden();

    const row = page.getByRole("link", { name, exact: true });
    await expect(row).toBeVisible();

    await row.click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    const groupId = new URL(page.url()).pathname.split("/").pop() ?? "";

    // A group with no grants is a list, and the screen says so rather than
    // showing a bare zero that reads like an error.
    await expect(page.getByText("confers nothing").first()).toBeVisible();

    try {
      // --- put somebody on it ------------------------------------------------
      await selectTab(page, /Members/);

      const addMember = await openDialog(page, "Add member");
      await addMember.getByRole("combobox").click();
      await page.getByPlaceholder("Search by name or subject").fill(SUBJECTS.reader);
      await page.getByRole("option").filter({ hasText: SUBJECTS.reader }).first().click();
      await addMember.getByRole("button", { name: "Add member" }).click();
      await expect(addMember).toBeHidden();

      // The ROW, not a cell: the subject appears twice in it — once as the
      // identity and once inside the Remove button's screen-reader label, which
      // is exactly the redundancy that makes the button safe to press.
      await expect(page.getByRole("row").filter({ hasText: SUBJECTS.reader })).toBeVisible();

      // --- and grant it something -------------------------------------------
      await selectTab(page, /Grants/);

      const grant = await openDialog(page, "Grant to this group");
      await grant.locator("#grant-role").click();
      await page.getByRole("option", { name: "writer", exact: true }).click();
      await grant.getByLabel("Scope", { exact: true }).selectOption("project");
      await grant.getByLabel("Project", { exact: true }).selectOption(project);
      await grant.getByRole("button", { name: "Create grant" }).click();
      await expect(grant).toBeHidden();

      // The row, for the same reason as the member row above: the scope is
      // named once in the Scope cell and once in the Revoke button's
      // screen-reader label.
      const held = page.getByRole("row").filter({ hasText: project });
      await expect(held).toBeVisible();
      await expect(held).toContainText("writer");

      // --- the identity screen answers "why" --------------------------------
      await page.goto(`/users/${reader}`);

      const scope = page.getByRole("listitem").filter({ hasText: project });
      await expect(scope).toBeVisible();

      // The role it resolves to, and the sentence naming what to remove.
      await expect(scope).toContainText("Effective role");
      await expect(scope).toContainText("writer");
      await expect(scope).toContainText(`comes from the ${slug} group`);

      // The decisive source is the GROUP, named, and marked as the one that
      // decided. This is the assertion the whole screen exists for.
      const decisive = scope.getByRole("row").filter({ hasText: "decisive" });
      await expect(decisive).toContainText("group");
      await expect(decisive).toContainText(slug);

      // Direct grants are separately, honestly, listed: nothing was granted to
      // this identity itself in this project.
      await expect(page.getByRole("heading", { name: "Direct grants" })).toBeVisible();

      // --- take the membership away, in the browser -------------------------
      await clickUntil(
        page.getByRole("button", { name: new RegExp(`Remove.*${slug}`) }),
        async () => {
          await expect(page.getByText("Not in any group")).toBeVisible({ timeout: 2000 });
        },
      );

      // And the role is gone from the explanation, because the explanation is
      // recomputed from the same rows the enforcement reads.
      await expect(page.getByRole("listitem").filter({ hasText: project })).toHaveCount(0);
    } finally {
      // This group held a grant reachable by a SHARED identity. Leaving it
      // behind would silently widen what `reader` can do in every spec that
      // runs after this one.
      await adminApi.raw(`/groups/${groupId}`, { method: "DELETE" });
    }
  });
});

test.describe("the authorization split, as rendered", () => {
  /**
   * A PROJECT admin. Not global, and not a bystander.
   *
   * The seeded fixtures do not include one — `writer` is a project WRITER — so
   * the grant is made here and revoked at the end. Admin on a project of this
   * test's own making widens nothing another spec asserts on: `writer` still
   * cannot see `ledger`, still cannot read the audit log, and still holds
   * exactly `writer` on `atlas`.
   */
  test.use({ role: "writer" });

  test("offers a project admin the grant control and not the roster", async ({
    page,
    adminApi,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("scoped");
    const slug = uniqueSlug("roster");

    await adminApi.request("/projects", {
      method: "POST",
      body: { slug: project, name: "Delegated" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const group = await adminApi.request<GroupRecord>("/groups", {
      method: "POST",
      body: { slug, name: `Roster ${slug}` },
    });

    const writer = await identityId(adminApi, SUBJECTS.writer);
    const delegated = await adminApi.request<{ id: string }>("/grants", {
      method: "POST",
      body: { scope_type: "project", project, identity_id: writer, role: "admin" },
    });

    try {
      await page.goto("/groups");

      // Creating a group is global-admin only, so the control is absent rather
      // than present-and-refused — and the screen says which authority it needs.
      await expect(page.getByRole("button", { name: "New group" })).toHaveCount(0);
      await expect(page.getByText("You can grant to a group, but not change one")).toBeVisible();

      await page.goto(`/groups/${group.id}`);

      // Granting IS theirs, inside their scope.
      await expect(page.getByRole("button", { name: "Grant to this group" })).toBeVisible();

      await selectTab(page, /Members/);
      await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
      await expect(page.getByText("Changing this roster needs an install-wide")).toBeVisible();

      /*
       * And the scope selector offers only what they can actually use. A
       * project admin shown "Everything in this install" learns their real
       * authority from a 403 after deciding what they wanted to do.
       */
      await selectTab(page, /Grants/);
      const grant = await openDialog(page, "Grant to this group");

      const scope = grant.getByLabel("Scope", { exact: true });
      await expect(scope.locator("option", { hasText: "Everything in this install" })).toHaveCount(
        0,
      );
      await expect(scope.locator("option", { hasText: "One project" })).toHaveCount(1);
    } finally {
      await adminApi.raw(`/grants/${delegated.id}`, { method: "DELETE" });
      await adminApi.raw(`/groups/${group.id}`, { method: "DELETE" });
    }
  });
});

/**
 * The group detail screen, scanned in both themes.
 *
 * Against a POPULATED group: an empty one renders none of the rows, badges or
 * destructive buttons that contrast rules actually fire on, so scanning one
 * would be a green result about nothing.
 */
for (const theme of ["light", "dark"] as const) {
  test.describe(`a group screen in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test.beforeEach(async ({ context }) => {
      await context.addCookies([{ name: THEME_COOKIE, value: theme, url: harness.baseUrl }]);
    });

    test("has no WCAG A/AA violation", async ({ page, adminApi, uniqueSlug }) => {
      const project = uniqueSlug("axe");
      const slug = uniqueSlug("axe-group");

      await adminApi.request("/projects", {
        method: "POST",
        body: { slug: project, name: "Axe" },
      });

      const group = await adminApi.request<GroupRecord>("/groups", {
        method: "POST",
        body: { slug, name: `Axe ${slug}`, description: "Scanned with members and grants." },
      });

      await adminApi.request(`/groups/${group.id}/members`, {
        method: "POST",
        body: { identity_id: await identityId(adminApi, SUBJECTS.admin) },
      });
      await adminApi.request(`/groups/${group.id}/grants`, {
        method: "POST",
        body: { scope_type: "project", project, role: "reader" },
      });

      try {
        await page.goto(`/groups/${group.id}`);
        await expect(page.getByRole("heading", { name: `Axe ${slug}`, level: 1 })).toBeVisible();
        await settle(page, theme);

        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(
          results.violations.map((violation) => violation.id),
          summarise(results.violations),
        ).toEqual([]);
      } finally {
        await adminApi.raw(`/groups/${group.id}`, { method: "DELETE" });
      }
    });
  });
}

function summarise(violations: { id: string; help: string; nodes: unknown[] }[]): string {
  if (violations.length === 0) return "(none)";
  return violations
    .map((violation) => `${violation.id} x${String(violation.nodes.length)} — ${violation.help}`)
    .join("\n");
}

/**
 * Hold the page still, then scan. The same two moves as `accessibility.spec.ts`
 * and for the same reasons: the palette has to already be on, and contrast is
 * computed from what is painted — an element mid-fade has a different ratio
 * from the same element at rest.
 */
async function settle(page: Page, theme: "light" | "dark"): Promise<void> {
  const html = page.locator("html");
  if (theme === "dark") await expect(html).toHaveClass(/\bdark\b/);
  else await expect(html).not.toHaveClass(/\bdark\b/);

  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;" +
      "animation-duration:0s!important;animation-delay:0s!important}",
  });
}
