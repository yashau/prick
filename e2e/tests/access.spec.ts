/**
 * Authorization, as four storage-state fixtures rather than four login flows.
 *
 * `test.use({ role })` selects one of the seeded identities, and every `page`,
 * `context` and `api` in the block is that identity -- the browser carrying the
 * `CF_Authorization` cookie, the API client carrying the
 * `Cf-Access-Jwt-Assertion` header. Both are genuine Access JWTs that the
 * unmodified verifier accepted.
 *
 * The four cover the whole shape of the model deliberately:
 *
 *   admin    global admin, from a real `scope_type = 'global'` GRANT and not
 *            from `BOOTSTRAP_ADMINS`. There is no god mode to lean on -- a
 *            global admin is an ordinary row resolved by the ordinary query --
 *            so the fixture is an ordinary row too.
 *   writer   project-scoped on `atlas`. Proves downward inheritance (it reaches
 *            every environment in the project) and the absence of sideways
 *            inheritance (it reaches nothing in `ledger`).
 *   reader   environment-scoped on `atlas/production`. Proves that grants are
 *            never inherited UPWARDS: an environment reader is not a project
 *            reader, so `atlas/staging` is a 403.
 *   service  an Access SERVICE TOKEN: empty `sub`, a `common_name`, no `email`
 *            and NO `nbf`. A verifier that requires `nbf`, or a non-empty
 *            `sub`, or an `email`, rejects every machine client in the estate.
 *            That negative case is not a footnote here; it is the whole reason
 *            this role exists as a fixture.
 */

import { environmentPath, expect, test } from "../fixtures";
import type { AuditPage, GrantRecord, IdentityRecord, SecretListEntry, Whoami } from "../fixtures";
import { SEED, SUBJECTS } from "../harness/constants";

const production = environmentPath(SEED.project, SEED.production);
const staging = environmentPath(SEED.project, SEED.staging);
const ledger = environmentPath(SEED.otherProject, "production");

test.describe("global admin", () => {
  test("is a grant, and reaches every project", async ({ api }) => {
    const whoami = await api.request<Whoami>("/whoami");

    expect(whoami).toMatchObject({ kind: "user", subject: SUBJECTS.admin, role: "admin" });
    // The banner this drives is a guard, not decoration: an installation whose
    // only admin comes from a var has an administrator nobody can revoke.
    expect(whoami.bootstrap).toBe(false);
    expect(whoami.identityId).not.toBeNull();

    const slugs = (await api.request<{ slug: string }[]>("/projects")).map((p) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining([SEED.project, SEED.otherProject]));

    expect((await api.raw(`${ledger}/secrets`)).status).toBe(200);
  });
});

test.describe("project-scoped writer", () => {
  test.use({ role: "writer" });

  test("reaches every environment in its project", async ({ api, uniqueSlug }) => {
    const whoami = await api.request<Whoami>("/whoami");
    expect(whoami).toMatchObject({ kind: "user", subject: SUBJECTS.writer });

    // A project grant covers environments created after it was made, because
    // it is resolved against the project id rather than a list of environments.
    const slug = uniqueSlug("wr");
    await api.request(`/projects/${SEED.project}/environments`, {
      method: "POST",
      body: { slug, name: "Writer scratch" },
    });

    const scratch = environmentPath(SEED.project, slug);
    const write = await api.raw(`${scratch}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { OK: "1" } },
    });
    expect(write.status).toBe(200);
  });

  /**
   * 404, NOT 403 -- and that is the interesting part.
   *
   * `assertVisible` runs before `assertRole`, and its failure is
   * indistinguishable from absence. A 403 here would be a statement that the
   * project EXISTS, which lets anyone with a token walk a slug dictionary and
   * read off the project names of an organisation they have no access to.
   * Slugs are things like `acme-payroll-migration`.
   *
   * A 403 is only ever produced for something already shown to be visible --
   * see the reader's write attempt below, which is exactly that case.
   */
  test("cannot see another project at all, and is told nothing about it", async ({ api }) => {
    const listing = await api.raw(`${ledger}/secrets`);
    expect(listing.status).toBe(404);
    expect((listing.body as { code: string }).code).toBe("NOT_FOUND");
    // The response body says "project", never which project, and never why.
    expect(listing.text).not.toContain(SEED.otherProject);

    const create = await api.raw(`/projects/${SEED.otherProject}/environments`, {
      method: "POST",
      body: { slug: "nope", name: "Nope" },
    });
    expect(create.status).toBe(404);
  });

  test("cannot read the audit log, which is global-admin only", async ({ api }) => {
    expect((await api.raw("/audit?limit=1")).status).toBe(403);
  });
});

test.describe("environment-scoped reader", () => {
  test.use({ role: "reader" });

  test("can read the one environment it was granted", async ({ api }) => {
    expect(await api.request<Whoami>("/whoami")).toMatchObject({
      kind: "user",
      subject: SUBJECTS.reader,
      // No GLOBAL role. The grant is environment-scoped, and `whoami` reports
      // the global one -- a reader that showed up here as "reader" would mean
      // the scope had been flattened away.
      role: null,
    });

    const rows = (await api.raw(`${production}/secrets`)).body as SecretListEntry[];
    expect(rows.map((row) => row.key)).toContain("DATABASE_URL");

    const revealed = await api.raw(`${production}/secrets/DATABASE_URL?reason=reveal`);
    expect(revealed.status).toBe(200);
  });

  test("cannot write what it can read", async ({ api }) => {
    const write = await api.raw(`${production}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { DATABASE_URL: "nope" } },
    });

    // 403 rather than 404, because this environment IS visible to this actor --
    // saying so leaks nothing they were not already shown.
    expect(write.status).toBe(403);
    expect((write.body as { code: string }).code).toBe("FORBIDDEN");
  });

  test("does not inherit upwards to a sibling environment", async ({ api }) => {
    // The load-bearing negative. An environment admin is not a project admin,
    // and an environment reader is not a project reader. Invisible, so 404.
    const listing = await api.raw(`${staging}/secrets`);
    expect(listing.status).toBe(404);
    expect(listing.text).not.toContain("db-staging.internal");
  });
});

test.describe("access service token", () => {
  test.use({ role: "service" });

  test("is accepted despite an empty sub, no email and no nbf", async ({ api }) => {
    const whoami = await api.request<Whoami>("/whoami");

    expect(whoami.kind).toBe("service");
    expect(whoami.subject).toBe(SUBJECTS.service);
    expect(whoami.identityId).not.toBeNull();
  });

  test("reads under its project grant and cannot write", async ({ api }) => {
    expect((await api.raw(`${production}/secrets`)).status).toBe(200);
    expect((await api.raw(`${staging}/secrets`)).status).toBe(200);

    const write = await api.raw(`${production}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { NOPE: "1" } },
    });
    expect(write.status).toBe(403);
  });
});

test.describe("revocation", () => {
  test("a revoked grant stops working immediately, and the denial is audited", async ({
    adminApi,
    apiAs,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("revoke");

    await adminApi.request("/projects", {
      method: "POST",
      body: { slug: project, name: "Revocation" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const env = environmentPath(project, "production");
    await adminApi.request(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { API_TOKEN: "granted-for-now" } },
    });

    const identities = await adminApi.request<IdentityRecord[]>("/identities");
    const service = identities.find((identity) => identity.subject === SUBJECTS.service);
    expect(service, "the service identity is created on its first request").toBeDefined();

    const grant = await adminApi.request<GrantRecord>("/grants", {
      method: "POST",
      body: {
        scope_type: "project",
        project,
        identity_id: service?.id,
        role: "reader",
      },
    });

    // --- granted ------------------------------------------------------------
    const asService = apiAs("service");

    expect((await asService.raw(`${env}/secrets`)).status).toBe(200);
    expect((await asService.raw(`${env}/secrets/API_TOKEN?reason=run`)).status).toBe(200);

    // --- revoked ------------------------------------------------------------
    const revoked = await adminApi.raw(`/grants/${grant.id}`, { method: "DELETE" });
    expect(revoked.status).toBeLessThan(300);

    /*
     * IMMEDIATELY, and as a 404.
     *
     * Immediately, because the authorization snapshot is memoised per REQUEST,
     * keyed by the context object -- a revocation cannot be masked by a cache
     * that outlives the request that populated it.
     *
     * 404 rather than 403, because with the grant gone the project is no longer
     * VISIBLE, and `assertVisible` runs first. Worth stating plainly: the plan's
     * verification section says "revoke grant, reload, assert 403", and the
     * system produces 404. The 404 is the better answer and the plan is what is
     * out of date -- a 403 would confirm the project exists to a caller who has
     * just been told they may not know that.
     */
    const afterList = await asService.raw(`${env}/secrets`);
    expect(afterList.status).toBe(404);

    const afterReveal = await asService.raw(`${env}/secrets/API_TOKEN?reason=run`);
    expect(afterReveal.status).toBe(404);
    expect(afterReveal.text).not.toContain("granted-for-now");

    /*
     * The denial is AUDITED. That is what populates "Seen but not granted" --
     * a service token's `common_name` is opaque, and the denial row is the only
     * introduction an operator ever gets.
     */
    const audit = await adminApi.request<AuditPage>(
      `/audit?project=${project}&outcome=denied&limit=20`,
    );
    expect(audit.entries.length).toBeGreaterThan(0);
    for (const entry of audit.entries) {
      expect(entry.actorSubject).toBe(SUBJECTS.service);
      expect(entry.actorKind).toBe("service");
      expect(entry.outcome).toBe("denied");
    }
  });
});

test.describe("a screen the viewer may not see", () => {
  // The environment-scoped reader, pointed at the sibling environment its grant
  // does not reach. A genuine 403 from the real API, produced by the ordinary
  // authorization path rather than by a contrived route.
  test.use({ role: "reader" });

  test("degrades to an explanation and an action, never a blank table", async ({ page }) => {
    await page.goto(`/p/${SEED.project}/${SEED.staging}`);

    /*
     * WHAT ACTUALLY ARRIVES IS A 404, NOT A 403.
     *
     * `assertVisible` runs before `assertRole`, so an environment the actor has
     * no grant on is reported as absent. The secrets page has a dedicated 403
     * branch -- an `empty` state reading "No grant covers <env>" with a link to
     * the access screen -- and that branch is UNREACHABLE on load for exactly
     * this reason: a load either sees the environment or is told it does not
     * exist. It is reachable only for a write the actor may not perform, which
     * is a toast rather than a page state.
     *
     * So the assertion is on the branch that does run: a destructive alert
     * naming the error code, with a retry. Not a spinner that never resolves,
     * and not an empty table -- "there are no secrets here" and "you may not see
     * them" are the same pixels and opposite meanings.
     */
    await expect(page.getByRole("alert")).toContainText("NOT_FOUND");
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();

    // And nothing from behind that boundary reached the document.
    expect(await page.content()).not.toContain("db-staging.internal");
  });
});
