/**
 * The whole flow, end to end, against the real Worker.
 *
 *   create project -> create environment -> add a secret -> reveal it ->
 *   import a .env as a dry run and check the diff -> apply it -> export and
 *   diff the result -> assert the audit log records the reveal and the import
 *   against the right actor.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAME FLOW EXISTS TWICE
 * ---------------------------------------------------------------------------
 * `tests/journey.spec.ts` walks this flow through the BROWSER, which is what
 * proves the screens work. This file walks it through `/api/v1`, which is what
 * proves the things a screen cannot show: that the listing response carries no
 * value anywhere in its bytes, that a dry run leaves the revision untouched,
 * that an update writes a new version rather than editing a blob in place, that
 * a stale `If-Match` aborts the whole batch, and that the audit detail carries
 * no plaintext.
 *
 * Every request below is authenticated by a genuine Access JWT that the
 * unmodified verifier accepted, lands in a real D1, and encrypts through the
 * real keyring.
 */

import { environmentPath, expect, test } from "../fixtures";
import type {
  AuditPage,
  EnvironmentSummary,
  ImportResult,
  SecretListEntry,
  WriteSecretsResult,
} from "../fixtures";
import { SUBJECTS } from "../harness/constants";

test.describe("the flow, end to end", () => {
  test("project, environment, secret, reveal, import, export, audit", async ({
    api,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("flow");

    // --- create project ----------------------------------------------------
    const created = await api.request<{ slug: string; environmentCount: number }>("/projects", {
      method: "POST",
      body: { slug: project, name: "Flow", description: "Created by the e2e suite." },
    });
    expect(created.slug).toBe(project);
    expect(created.environmentCount).toBe(0);

    // --- create environment ------------------------------------------------
    const environment = await api.request<EnvironmentSummary>(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });
    expect(environment.rev).toBe(0);
    expect(environment.secretCount).toBe(0);

    const env = environmentPath(project, "production");

    // --- add a secret ------------------------------------------------------
    const value = "postgres://flow:e2e-only@db.internal:5432/flow?sslmode=require";

    const write = await api.request<WriteSecretsResult>(`${env}/secrets:batch`, {
      method: "POST",
      body: {
        mode: "merge",
        set: { DATABASE_URL: value },
        expected_rev: environment.rev,
        reason: "e2e: first write",
      },
    });
    expect(write.rev).toBe(environment.rev + 1);
    expect(write.added).toEqual(["DATABASE_URL"]);

    // --- the LISTING never carries a value ---------------------------------
    const listing = await api.raw(`${env}/secrets`);
    expect(listing.status).toBe(200);
    expect(listing.headers.get("etag")).toBe(`"${String(write.rev)}"`);

    const rows = listing.body as SecretListEntry[];
    expect(rows.map((row) => row.key)).toEqual(["DATABASE_URL"]);
    expect(rows[0]?.unreadable).toBe(false);
    expect(rows[0]?.version).toBe(1);

    // Not "the value field is absent" -- the whole serialised response, so a
    // future field that happened to carry one would fail this too.
    expect(listing.text).not.toContain(value);

    // --- reveal ------------------------------------------------------------
    const revealed = await api.raw(`${env}/secrets/DATABASE_URL?reason=reveal`);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toEqual({ key: "DATABASE_URL", value });

    // --- import, DRY RUN ---------------------------------------------------
    const dotenv = [
      "# added by the e2e suite",
      'DATABASE_URL="postgres://flow:rotated@db.internal:5432/flow?sslmode=require"',
      'FEATURE_FLAGS="checkout_v2,dark_mode"',
      "export STRIPE_SECRET_KEY=example-not-a-real-key",
      "",
    ].join("\n");

    const dryRun = await api.request<ImportResult>(`${env}/secrets:import`, {
      method: "POST",
      body: { format: "env", content: dotenv, mode: "merge", dry_run: true },
    });

    expect(dryRun.applied).toBe(false);
    expect(dryRun.added.sort()).toEqual(["FEATURE_FLAGS", "STRIPE_SECRET_KEY"]);
    expect(dryRun.changed).toEqual(["DATABASE_URL"]);
    expect(dryRun.removed).toEqual([]);
    expect(dryRun.warnings).toEqual([]);

    /*
     * THE WIRE SHAPE, ASSERTED ON PURPOSE.
     *
     * The browser client's `ImportPreview` declares `dryRun`, `unchanged` and
     * `rev`; the server sends `applied` and no other three. The import dialog
     * renders `preview.unchanged.length`, so it reads `undefined.length` the
     * moment `USE_FIXTURES` is flipped to false. Pinning the real shape here
     * makes that a known cutover task rather than a crash on the day.
     */
    expect(Object.keys(dryRun).sort()).toEqual([
      "added",
      "applied",
      "changed",
      "removed",
      "warnings",
    ]);

    /*
     * A DRY RUN WRITES NOTHING. Asserted against the revision rather than by
     * re-listing: `rev` is bumped by exactly one statement, the first in every
     * secrets batch, so an unchanged `rev` is proof that no batch ran at all.
     */
    const afterDryRun = await api.request<EnvironmentSummary>(env);
    expect(afterDryRun.rev).toBe(write.rev);
    expect(afterDryRun.secretCount).toBe(1);

    // The diff carries KEY NAMES and counts. Never a value, in either
    // direction -- not the incoming one, not the one being replaced.
    const dryRunText = JSON.stringify(dryRun);
    expect(dryRunText).not.toContain(value);
    expect(dryRunText).not.toContain("postgres://flow:rotated");
    expect(dryRunText).not.toContain("example-not-a-real-key");

    // --- import, for real --------------------------------------------------
    const applied = await api.request<ImportResult>(`${env}/secrets:import`, {
      method: "POST",
      body: {
        format: "env",
        content: dotenv,
        mode: "merge",
        dry_run: false,
        expected_rev: afterDryRun.rev,
        reason: "e2e: import",
      },
    });
    expect(applied.applied).toBe(true);

    const afterImport = await api.request<EnvironmentSummary>(env);
    expect(afterImport.rev).toBe(afterDryRun.rev + 1);
    expect(afterImport.secretCount).toBe(3);

    // --- export, and diff it against what went in --------------------------
    const exported = await api.raw(`${env}/secrets:export`);
    expect(exported.status).toBe(200);
    expect(exported.body).toEqual({
      DATABASE_URL: "postgres://flow:rotated@db.internal:5432/flow?sslmode=require",
      FEATURE_FLAGS: "checkout_v2,dark_mode",
      STRIPE_SECRET_KEY: "example-not-a-real-key",
    });

    // The original value is GONE: an update writes a new version under fresh
    // AAD rather than editing a blob in place, so the export cannot still
    // contain what the first write put there.
    expect(exported.text).not.toContain("flow:e2e-only");

    // --- the audit log -----------------------------------------------------
    const audit = await api.request<AuditPage>(
      `/audit?project=${project}&environment=production&limit=50`,
    );

    const actions = audit.entries.map((entry) => entry.action);
    expect(actions).toContain("secret.reveal");
    expect(actions).toContain("secret.export");

    /*
     * THE IMPORT IS AUDITED AS `secret.import`.
     *
     * `importSecrets` still delegates the write to `writeSecrets` -- one batch,
     * one audit row, the row last -- and tells it which action to record. So the
     * provenance survives into the log without a second write, and "someone
     * pasted a `.env` over production" no longer reads exactly like "someone
     * changed one key" for want of a `reason`.
     *
     * Matched on the ACTION and the reason together, because the flow above
     * also performs a hand-written batch, and the point of the distinction is
     * that the two rows are now tellable apart.
     */
    const importRow = audit.entries.find(
      (entry) =>
        entry.action === "secret.import" &&
        (entry.detail as { reason?: string }).reason === "e2e: import",
    );
    expect(importRow, "the import should have produced an audited import").toBeDefined();

    // And the hand-written batch that created DATABASE_URL is still a
    // `secret.write`: this changed what an import is called, not what a write
    // is called.
    expect(actions).toContain("secret.write");

    for (const entry of audit.entries) {
      expect(entry.actorSubject).toBe(SUBJECTS.admin);
      expect(entry.actorKind).toBe("user");
    }

    const reveal = audit.entries.find((entry) => entry.action === "secret.reveal");
    expect(reveal?.outcome).toBe("success");
    expect(reveal?.targetKey).toBe("DATABASE_URL");
    // `reason` is what makes the log answer "did anyone TAKE this", rather than
    // merely "did anyone look at it".
    expect(reveal?.detail).toMatchObject({ reason: "reveal", count: 1 });

    expect(importRow?.outcome).toBe("success");
    expect(importRow?.detail).toMatchObject({
      added: expect.arrayContaining(["FEATURE_FLAGS", "STRIPE_SECRET_KEY"]),
      changed: ["DATABASE_URL"],
    });

    // No audit row may carry a value, in the detail or anywhere else.
    expect(JSON.stringify(audit)).not.toContain("postgres://");
  });

  /**
   * The gap this file used to record, now closed.
   *
   * `importSecrets` still hands the write to `writeSecrets` -- there is exactly
   * one batch and exactly one audit row, and the row is still the last statement
   * in it -- but it passes the action, so the row says `secret.import`.
   *
   * The narrowest possible case on purpose: a fresh project, one import, nothing
   * else. If the action were ever inferred from the shape of the write rather
   * than from the caller, a one-key import like this one is exactly what would
   * fall back to `secret.write` and go unnoticed in the larger flow above.
   */
  test("an import is audited as secret.import", async ({ api, uniqueSlug }) => {
    const project = uniqueSlug("import-action");
    await api.request("/projects", { method: "POST", body: { slug: project, name: "Import" } });
    await api.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const env = environmentPath(project, "production");
    await api.request<ImportResult>(`${env}/secrets:import`, {
      method: "POST",
      body: { format: "env", content: 'A="1"\n', mode: "merge", dry_run: false },
    });

    const audit = await api.request<AuditPage>(`/audit?project=${project}&limit=50`);
    const actions = audit.entries.map((entry) => entry.action);

    expect(actions).toContain("secret.import");
    // INSTEAD OF, not as well as. One mutation is one audit row in one batch, so
    // labelling the import must not have bought a second row alongside it.
    expect(actions).not.toContain("secret.write");
    expect(actions.filter((action) => action === "secret.import")).toHaveLength(1);
  });

  test("a reveal is one audit row per read, and a copy is distinguishable", async ({
    api,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("audit-reason");
    await api.request("/projects", { method: "POST", body: { slug: project, name: "Reasons" } });
    await api.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const env = environmentPath(project, "production");
    await api.request(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { TOKEN: "a-value-nobody-should-see-twice" } },
    });

    await api.request(`${env}/secrets/TOKEN?reason=reveal`);
    await api.request(`${env}/secrets/TOKEN?reason=copy`);

    const audit = await api.request<AuditPage>(
      `/audit?project=${project}&action=secret.reveal&limit=50`,
    );

    /*
     * TWO rows, not one. The UI refetches on copy rather than reading the value
     * out of the reveal store precisely so that "someone looked at this" and
     * "someone took this" are different events in the log; a cache would make
     * the second one leave no trace at all.
     */
    expect(audit.entries).toHaveLength(2);
    expect(
      audit.entries.map((entry) => (entry.detail as { reason: string }).reason).sort(),
    ).toEqual(["copy", "reveal"]);
  });

  test("a conditional write against a stale revision is refused and changes nothing", async ({
    api,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("etag");
    await api.request("/projects", { method: "POST", body: { slug: project, name: "ETag" } });
    await api.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const env = environmentPath(project, "production");
    await api.request(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { A: "1" } },
    });

    const listing = await api.raw(`${env}/secrets`);
    const etag = listing.headers.get("etag");
    expect(etag).not.toBeNull();

    // Somebody else writes, so the tag we are holding is now stale.
    await api.request(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { B: "2" } },
    });

    const refused = await api.raw(`${env}/secrets:batch`, {
      method: "POST",
      headers: { "If-Match": etag ?? "" },
      body: { mode: "replace", set: { C: "3" } },
    });

    expect(refused.status).toBe(412);
    expect((refused.body as { code: string }).code).toBe("PRECONDITION_FAILED");

    /*
     * BYTE-FOR-BYTE UNCHANGED. The guard is a deliberate constraint violation
     * inside the same `batch()`, so the guard's failure IS the rollback -- a
     * `replace` that got halfway would have deleted A and B.
     */
    const after = (await api.raw(`${env}/secrets`)).body as SecretListEntry[];
    expect(after.map((row) => row.key).sort()).toEqual(["A", "B"]);
  });
});
