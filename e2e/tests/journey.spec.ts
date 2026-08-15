/**
 * THE FLOW, END TO END, THROUGH THE BROWSER.
 *
 *   create a project -> create an environment -> add a secret ->
 *   the value is absent from the DOM until Reveal is clicked AND a network
 *   request completes -> import a `.env` and check the dry-run diff -> apply it
 *   -> export and diff the download -> the audit log records it against the
 *   right actor -> revoke a grant, reload, and the screen degrades honestly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SERIAL AND EVERYTHING ELSE IS NOT
 * ---------------------------------------------------------------------------
 * The rest of the suite is fully parallel and each test arranges its own state,
 * because that is how a suite stays fast and how a failure stays local. This
 * one is a JOURNEY: each step depends on the last, and the thing being tested
 * is partly the sequence. `test.describe.serial` makes the dependency explicit
 * -- and makes a failure abort the rest of the journey rather than produce nine
 * cascading failures that all say the same thing.
 *
 * It works in a project of its own, created in the first step, so that running
 * it in parallel with the rest of the suite is safe.
 *
 * The audit assertions go through `/api/v1` rather than the audit SCREEN. Not
 * because the screen does not work -- `tests/accessibility.spec.ts` renders it
 * -- but because what is being asserted is the CONTENT of a row (its actor, its
 * action, its detail, and the absence of any plaintext in it), and reading that
 * off a rendered table would be asserting on the formatter.
 */

import type { Page } from "@playwright/test";

import { environmentPath, expect, harness, test } from "../fixtures";
import type { AuditPage } from "../fixtures";
import { MASK, SUBJECTS } from "../harness/constants";

const PROJECT = `journey-${Date.now().toString(36)}`;
const ENVIRONMENT = "production";
const KEY = "DATABASE_URL";
const VALUE = "postgres://journey:e2ejourney7c31d@db.internal:5432/journey?sslmode=require";

/** The `.env` the journey imports. One change, one addition. */
const IMPORT_FILE = [
  "# imported by the journey spec",
  `DATABASE_URL="postgres://journey:e2ejourney-rotated@db.internal:5432/journey?sslmode=require"`,
  'FEATURE_FLAGS="journey_v2"',
  "",
].join("\n");

const secretsPath = `/p/${PROJECT}/${ENVIRONMENT}`;

/** Wait for the real table rather than `table-skeleton.svelte`'s five rows. */
async function tableReady(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();
}

/**
 * Open a dialog on a SERVER-RENDERED screen.
 *
 * The projects and environments screens are SSR, so their buttons are in the
 * document -- and clickable, and inert -- from the first byte, until SvelteKit
 * hydrates and attaches the handler. A single click is therefore a race that
 * this suite loses often enough to matter and quietly enough to be blamed on
 * something else.
 *
 * Retrying is the honest fix rather than a fixed sleep: it converts "hydration
 * took longer than usual" into a slower pass instead of a red test, and it
 * still fails if the button is genuinely wired to nothing. The guard means a
 * dialog that DID open is never clicked closed again on the next attempt.
 *
 * The client-rendered secrets screen needs none of this: its table cannot
 * appear before hydration, so waiting for the table IS waiting for hydration.
 */
async function openDialog(page: Page, trigger: string) {
  const button = page.getByRole("button", { name: trigger }).first();
  await expect(button).toBeVisible();

  const dialog = page.getByRole("dialog");

  await expect(async () => {
    if (!(await dialog.isVisible())) await button.click();
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  return dialog;
}

async function readDownload(download: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test.describe.serial("the journey", () => {
  test("create a project", async ({ page }) => {
    await page.goto("/projects");

    const dialog = await openDialog(page, "New project");

    await dialog.getByLabel("Name", { exact: true }).fill("Journey");
    await dialog.getByLabel("Slug", { exact: true }).fill(PROJECT);
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: "Journey" })).toBeVisible();
  });

  test("create an environment", async ({ page }) => {
    await page.goto(`/p/${PROJECT}`);

    const dialog = await openDialog(page, "New environment");

    await dialog.getByLabel("Name", { exact: true }).fill("Production");
    await dialog.getByLabel("Slug", { exact: true }).fill(ENVIRONMENT);
    await dialog.getByRole("button", { name: "Create environment" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: ENVIRONMENT }).first()).toBeVisible();
  });

  test("add a secret, and it is masked the moment it exists", async ({ page }) => {
    await page.goto(secretsPath);
    await tableReady(page);

    const dialog = await openDialog(page, "Add secret");

    await dialog.getByLabel("Key", { exact: true }).fill(KEY);
    await dialog.getByLabel("Value", { exact: true }).fill(VALUE);
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();

    /*
     * The value the operator typed a second ago is NOT carried into the new
     * row. The table re-reads from the server, which returns key names only, so
     * looking at it again costs an audited reveal like any other read.
     */
    const input = page.getByRole("textbox", { name: `${KEY}, hidden` });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(MASK);

    expect(await page.content()).not.toContain(VALUE);
  });

  test("the value appears only after Reveal, and only after the request completes", async ({
    page,
  }) => {
    await page.goto(secretsPath);
    await tableReady(page);

    const input = page.getByRole("textbox", { name: new RegExp(`^${KEY}, (hidden|revealed)$`) });
    await expect(input).toHaveValue(MASK);

    // Nothing on the page holds it before the click -- not the DOM, not a
    // script the page loaded.
    expect(await page.content()).not.toContain(VALUE);

    const reveal = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/") &&
        response.url().includes(`/secrets/${KEY}`) &&
        response.request().method() === "GET",
    );

    await page.getByRole("button", { name: `Reveal ${KEY}` }).click();

    const response = await reveal;
    expect(response.status()).toBe(200);

    /*
     * THE VALUE CAME FROM THE RESPONSE, not from anywhere the page already had
     * it. Asserted by equality with the body the browser actually received,
     * rather than by equality with a constant this file happens to know.
     */
    const body = (await response.json()) as { key: string; value: string };
    expect(body.value).toBe(VALUE);

    await expect(input).toHaveValue(VALUE);

    // And the response that carried it is uncacheable, in the three ways that
    // matter: the browser, Cloudflare's own edge, and across identities.
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBe("no-store");
    expect(response.headers()["vary"]).toBe("Cf-Access-Jwt-Assertion");
  });

  test("import a .env: the dry run diffs, then the apply lands", async ({ page }) => {
    await page.goto(secretsPath);
    await tableReady(page);

    const dialog = await openDialog(page, "Import");

    await dialog.getByLabel("Contents").fill(IMPORT_FILE);
    await dialog.getByRole("button", { name: "Preview changes" }).click();

    // Key names and counts. The diff carries no value in either direction.
    await expect(dialog.getByText("1 addition", { exact: false })).toBeVisible();
    await expect(dialog.getByText("1 changed")).toBeVisible();
    await expect(dialog.getByText("0 removed")).toBeVisible();

    const diff = dialog.locator("dl");
    await expect(diff).toContainText("FEATURE_FLAGS");
    await expect(diff).toContainText(KEY);
    expect(await diff.textContent()).not.toContain("postgres://");

    await dialog.getByRole("button", { name: "Apply import" }).click();
    await expect(dialog).toBeHidden();

    // Two rows now, and both masked.
    await expect(page.getByRole("textbox", { name: `${KEY}, hidden` })).toHaveValue(MASK);
    await expect(page.getByRole("textbox", { name: "FEATURE_FLAGS, hidden" })).toHaveValue(MASK);

    // The value the import replaced is gone from the screen and from the API:
    // an update writes a NEW version under fresh AAD rather than editing a blob.
    expect(await page.content()).not.toContain(VALUE);
  });

  test("export, and the download matches the API byte for byte", async ({ page, api }) => {
    await page.goto(secretsPath);
    await tableReady(page);

    const dialog = await openDialog(page, "Export");

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`${ENVIRONMENT}.env`);

    const text = await readDownload(download);
    const fromApi = await api.request<Record<string, string>>(
      `${environmentPath(PROJECT, ENVIRONMENT)}/secrets:export`,
    );

    // Rendered by `toDotenv`: sorted keys, every value double-quoted.
    const expected = `${Object.keys(fromApi)
      .sort()
      .map((key) => `${key}="${fromApi[key] ?? ""}"`)
      .join("\n")}\n`;

    expect(text).toBe(expected);

    // And the file was never on screen. `export-dialog.svelte` fetches, hands
    // the text to a Blob, and drops it -- a rendered preview would put the whole
    // environment into a screenshot and into the accessibility tree at once.
    const html = await page.content();
    for (const value of Object.values(fromApi)) expect(html).not.toContain(value);
  });

  test("the audit log records it all, against the right actor", async ({ adminApi }) => {
    const audit = await adminApi.request<AuditPage>(`/audit?project=${PROJECT}&limit=100`);

    const actions = audit.entries.map((entry) => entry.action);
    expect(actions).toContain("project.create");
    expect(actions).toContain("environment.create");
    expect(actions).toContain("secret.reveal");
    expect(actions).toContain("secret.export");

    // Every row is the admin, who is who the browser was.
    for (const entry of audit.entries) {
      expect(entry.actorKind).toBe("user");
      expect(entry.actorSubject).toBe(SUBJECTS.admin);
    }

    const reveal = audit.entries.find((entry) => entry.action === "secret.reveal");
    expect(reveal?.outcome).toBe("success");
    expect(reveal?.targetKey).toBe(KEY);
    expect(reveal?.detail).toMatchObject({ reason: "reveal", count: 1 });

    /*
     * THE IMPORT IS AUDITED AS `secret.import`, AND THE HAND WRITE IS NOT.
     *
     * `importSecrets` still hands the write to `writeSecrets` -- one batch, one
     * audit row, the row last -- and passes the action down, so the log can tell
     * "somebody pasted a `.env` over this environment" from "somebody changed one
     * key". Both were done through the browser earlier in this file, so both rows
     * are here and the pair is the assertion.
     */
    const imported = audit.entries.find(
      (entry) =>
        entry.action === "secret.import" &&
        Array.isArray((entry.detail as { added?: unknown }).added) &&
        ((entry.detail as { added: string[] }).added.includes("FEATURE_FLAGS") ||
          (entry.detail as { changed?: string[] }).changed?.includes(KEY) === true),
    );
    expect(imported, "the import should have produced an audited import").toBeDefined();

    // The "add a secret" step earlier in the journey. Still a write, and still
    // separate from the import.
    const write = audit.entries.find(
      (entry) =>
        entry.action === "secret.write" &&
        (entry.detail as { added?: string[] }).added?.includes(KEY) === true,
    );
    expect(write, "adding a secret by hand should still be an audited write").toBeDefined();

    // No row carries plaintext, in its detail or anywhere else.
    expect(JSON.stringify(audit)).not.toContain("postgres://");
  });

  test("revoke the grant, reload, and the screen degrades honestly", async ({
    browser,
    adminApi,
  }) => {
    // A second identity, granted onto this project and then cut off. The
    // service token is the realistic case: it is what CI holds.
    const identities = await adminApi.request<{ id: string; subject: string }[]>("/identities");
    const service = identities.find((identity) => identity.subject === SUBJECTS.service);
    expect(service).toBeDefined();

    const grant = await adminApi.request<{ id: string }>("/grants", {
      method: "POST",
      body: { scope_type: "project", project: PROJECT, identity_id: service?.id, role: "reader" },
    });

    const context = await browser.newContext({
      storageState: harness.storageState("service"),
      baseURL: harness.baseUrl,
    });

    try {
      const page = await context.newPage();

      // --- granted: the rows are there, masked ------------------------------
      await page.goto(secretsPath);
      await tableReady(page);
      await expect(page.getByRole("textbox", { name: `${KEY}, hidden` })).toHaveValue(MASK);

      // --- revoked ----------------------------------------------------------
      await adminApi.raw(`/grants/${grant.id}`, { method: "DELETE" });

      await page.reload();

      /*
       * A 404, NOT A 403, and the distinction is deliberate.
       *
       * `assertVisible` runs before `assertRole`, and its failure is
       * indistinguishable from absence -- a 403 would confirm that a project
       * called `journey-…` exists to a caller who has just been told they may
       * not know that. The plan's verification section says "assert 403"; the
       * system answers 404 and the system is right.
       *
       * What matters for the SCREEN is that it says something. Not a spinner
       * that never resolves, and not an empty table -- "there are no secrets
       * here" and "you may not see them" are the same pixels and opposite
       * meanings.
       */
      await expect(page.getByRole("alert")).toContainText("NOT_FOUND");
      await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();

      // And nothing from behind the boundary is in the document.
      expect(await page.content()).not.toContain("journey:");
    } finally {
      await context.close();
    }
  });
});
