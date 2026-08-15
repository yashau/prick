/**
 * The import diff and the export download, driven through the dialogs.
 *
 * Two properties are worth a browser test rather than an API one, because
 * neither is visible from the wire:
 *
 *   THE DIFF SHOWS NO VALUES. The API's diff carries key names only, and the
 *   dialog must not helpfully render an old-vs-new comparison out of what the
 *   operator pasted -- that shape looks like a diff and leaks two secrets where
 *   the naive version leaks one.
 *
 *   THE EXPORT IS NEVER RENDERED. `export-dialog.svelte` fetches, hands the
 *   text straight to a `Blob` download, and drops it. If the file ever reached
 *   the DOM it would survive in a screenshot, in a detached node, and in the
 *   accessibility tree -- so the assertion is that the exported bytes appear
 *   nowhere in the document that produced them.
 *
 * `atlas/staging` is the target throughout: it holds no undecryptable row, so
 * an export of it is legitimately complete. The import is DRY RUN ONLY -- the
 * suite runs fully parallel against one D1, and applying an import here would
 * move the ground under another spec.
 */

import { environmentPath, expect, test } from "../fixtures";
import { SEED } from "../harness/constants";

const SCREEN = `/p/${SEED.project}/${SEED.staging}`;

/** A `.env` file as `toDotenv` writes it: sorted, every value double-quoted. */
function parseDotenv(source: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(line);
    expect(match, `not a line this exporter should ever write: ${line}`).not.toBeNull();
    if (match === null) continue;

    values[match[1] ?? ""] = (match[2] ?? "").replace(/\\(["\\nrt])/g, (_, escaped: string) =>
      escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped,
    );
  }

  return values;
}

test.describe("import", () => {
  test("the dry run shows a diff of key names and writes nothing", async ({ page }) => {
    await page.goto(SCREEN);
    await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();

    const before = await page.locator("tbody tr").count();

    await page.getByRole("button", { name: "Import" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // One key that already exists and one that does not, so the diff has to
    // produce both an `added` and a `changed` entry.
    const incoming = "e2e-import-value-must-not-be-rendered";
    await dialog
      .getByLabel("Contents")
      .fill(
        [
          "# pasted by the e2e suite",
          `DATABASE_URL="${incoming}"`,
          `E2E_IMPORTED_KEY="${incoming}"`,
          "",
        ].join("\n"),
      );

    await dialog.getByRole("button", { name: "Preview changes" }).click();

    // The counts, from the registry's badges.
    await expect(dialog.getByText("1 addition", { exact: false })).toBeVisible();
    await expect(dialog.getByText("1 changed")).toBeVisible();
    await expect(dialog.getByText("0 removed")).toBeVisible();

    // The key names, in the diff list.
    const diff = dialog.locator("dl");
    await expect(diff).toContainText("E2E_IMPORTED_KEY");
    await expect(diff).toContainText("DATABASE_URL");

    /*
     * AND NO VALUE, in either direction. Not the incoming one -- which is in
     * the textarea because the operator put it there, and must not be echoed
     * back out of it into the diff -- and not the one being replaced, which
     * would require decrypting an existing value to show, on the screen whose
     * whole purpose is to avoid doing that.
     */
    expect(await diff.textContent()).not.toContain(incoming);
    expect(await diff.textContent()).not.toContain("postgres://");

    // Nothing was applied: the Apply button exists but has not been pressed,
    // and the table behind the dialog is untouched.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator("tbody tr")).toHaveCount(before);
    await expect(page.getByRole("textbox", { name: /^E2E_IMPORTED_KEY, / })).toHaveCount(0);
  });

  /**
   * A malformed line REFUSES THE WHOLE FILE. It is not skipped.
   *
   * `core/dotenv.ts` throws `DotenvParseError` -- a `VALIDATION_FAILED` naming
   * the LINE and never the text -- rather than dropping the line and carrying
   * on. That is the same choice as refusing an export around an undecryptable
   * row: a file that imported "mostly" is a file whose author believes all of
   * it landed.
   */
  test("a line that is not a POSIX name refuses the whole import", async ({ page }) => {
    await page.goto(SCREEN);
    await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();

    await page.getByRole("button", { name: "Import" }).click();
    const dialog = page.getByRole("dialog");

    await dialog
      .getByLabel("Contents")
      .fill(['E2E_FINE="ok"', "not-a-posix-name=whatever", ""].join("\n"));

    await dialog.getByRole("button", { name: "Preview changes" }).click();

    const failure = dialog.getByRole("alert");
    await expect(failure).toContainText("VALIDATION_FAILED");
    // Names the line. Never the text on it -- that line is somebody's secret.
    await expect(failure).toContainText(/line 2/i);
    expect(await failure.textContent()).not.toContain("whatever");

    // And nothing may be applied off the back of a failed preview.
    await expect(dialog.getByRole("button", { name: "Apply import" })).toBeDisabled();
  });

  /**
   * A `$VAR`-shaped value IS a warning rather than a refusal, and the
   * difference is the point: the file is unambiguous, it just does not mean
   * what a shell would make it mean. The warning names the KEY, which is
   * plaintext metadata, and no part of the value.
   */
  test("a $VAR-like value is warned about and stored literally", async ({ page }) => {
    await page.goto(SCREEN);
    await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();

    await page.getByRole("button", { name: "Import" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Contents").fill('E2E_INTERPOLATED="prefix-${HOME}-suffix"\n');
    await dialog.getByRole("button", { name: "Preview changes" }).click();

    const warning = dialog.getByRole("alert");
    await expect(warning).toContainText(/line skipped/i);
    // Names the line and the KEY, and describes the behaviour. The value that
    // triggered it appears nowhere.
    await expect(warning).toContainText("Line 1 (E2E_INTERPOLATED)");
    await expect(warning).toContainText(/no interpolation/i);
    expect(await warning.textContent()).not.toContain("prefix-");
  });
});

test.describe("export", () => {
  test("downloads a .env whose contents never reach the document", async ({ page }) => {
    await page.goto(SCREEN);
    await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();

    // The keys the screen says are here, before anything is exported.
    const labels = await page.getByRole("textbox", { name: /, hidden$/ }).all();
    const keysOnScreen = await Promise.all(
      labels.map(async (input) =>
        ((await input.getAttribute("aria-label")) ?? "").replace(/, hidden$/, ""),
      ),
    );
    expect(keysOnScreen.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Export" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The dialog says what this costs before the button is pressed.
    await expect(dialog).toContainText("secret.export");

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`${SEED.staging}.env`);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");

    const values = parseDotenv(text);
    const keysInFile = Object.keys(values);

    // Every key the screen showed is in the file. An export that is silently
    // one variable short is how a deploy loses a key nobody notices is missing.
    expect([...keysInFile].sort()).toEqual([...keysOnScreen].sort());

    // Sorted, so two exports of the same environment are byte-identical.
    expect(keysInFile).toEqual([...keysInFile].sort());

    /*
     * AND THE FILE WAS NEVER ON SCREEN.
     *
     * `export-dialog.svelte` fetches, hands the text to a `Blob`, and drops it.
     * A rendered preview would put the whole environment into a screenshot, a
     * detached DOM node and the accessibility tree at once.
     */
    const html = await page.content();
    for (const value of Object.values(values)) {
      expect(html, "an exported value reached the DOM").not.toContain(value);
    }
  });

  test("the download is byte-identical to the API's export", async ({ page, api }) => {
    await page.goto(SCREEN);
    await expect(page.getByRole("textbox", { name: "Filter secrets by key name" })).toBeVisible();

    await page.getByRole("button", { name: "Export" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));

    const fromBrowser = parseDotenv(Buffer.concat(chunks).toString("utf8"));

    const fromApi = await api.request<Record<string, string>>(
      `${environmentPath(SEED.project, SEED.staging)}/secrets:export`,
    );

    expect(fromBrowser).toEqual(fromApi);
  });
});
