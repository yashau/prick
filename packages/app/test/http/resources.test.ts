import { beforeEach, describe, expect, it } from "vitest";

import { environments, projects } from "../../src/lib/server/db/schema.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let owner: string;

beforeEach(async () => {
  api = await apiHarness();
  owner = await api.ownerToken();
});

describe("projects", () => {
  it("creates, reads, updates and deletes", async () => {
    const created = await api.json<{ slug: string; environmentCount: number }>("/api/v1/projects", {
      method: "POST",
      token: owner,
      ...body({ slug: "acme", name: "Acme", description: "the one" }),
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "acme", environmentCount: 0 });

    const patched = await api.json<{ name: string; description: string | null }>(
      "/api/v1/projects/acme",
      { method: "PATCH", token: owner, ...body({ name: "Acme Inc", description: null }) },
    );

    expect(patched.body).toMatchObject({ name: "Acme Inc", description: null });

    expect(
      (await api.fetch("/api/v1/projects/acme", { method: "DELETE", token: owner })).status,
    ).toBe(204);
    expect((await api.fetch("/api/v1/projects/acme", { token: owner })).status).toBe(404);
  });

  it("refuses a duplicate slug with a 409 that names it", async () => {
    await seedProject(api.db, "acme");

    const response = await api.fetch("/api/v1/projects", {
      method: "POST",
      token: owner,
      ...body({ slug: "acme", name: "Acme" }),
    });

    expect(response.status).toBe(409);
    // Naming the slug is safe: the caller supplied it in this request, so
    // telling them it is taken reveals nothing they did not just assert, and it
    // is the only message that lets them fix it.
    expect(await response.text()).toContain("acme");
  });

  it("rejects a slug the grammar does not permit", async () => {
    for (const slug of ["Acme", "acme_prod", "-acme", "acme-", "acme/prod", "acme:prod", ""]) {
      const response = await api.fetch("/api/v1/projects", {
        method: "POST",
        token: owner,
        ...body({ slug, name: "x" }),
      });

      expect(response.status, slug).toBe(422);
    }
  });

  it("matches a slug EXACTLY, never as a prefix", async () => {
    // The upstream defect this avoids was a prefix lookup that could resolve to
    // a different record than the one asked for -- which would authorize against
    // one project and operate on another, and would look correct in every test
    // that used distinct first characters.
    await seedProject(api.db, "acme");

    expect((await api.fetch("/api/v1/projects/acm", { token: owner })).status).toBe(404);
    expect((await api.fetch("/api/v1/projects/acme-corp", { token: owner })).status).toBe(404);
  });

  it("cascades to environments and secrets on delete", async () => {
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");
    await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
      method: "POST",
      token: owner,
      ...body({ mode: "merge", set: { A: "1" } }),
    });

    await api.fetch("/api/v1/projects/acme", { method: "DELETE", token: owner });

    // D1 enforces foreign keys, so `ON DELETE CASCADE` actually fires -- one
    // statement, one transaction, rather than four sequential deletes whose
    // third failure leaves a project whose environments are gone.
    expect(await api.db.select().from(projects)).toEqual([]);
    expect(await api.db.select().from(environments)).toEqual([]);
  });
});

describe("environments", () => {
  beforeEach(async () => {
    await seedProject(api.db, "acme");
  });

  it("creates and lists them", async () => {
    const created = await api.json<{ slug: string; rev: number; secretCount: number }>(
      "/api/v1/projects/acme/environments",
      { method: "POST", token: owner, ...body({ slug: "prod", name: "Production" }) },
    );

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "prod", rev: 0, secretCount: 0 });

    const listed = await api.json<{ slug: string }[]>("/api/v1/projects/acme/environments", {
      token: owner,
    });

    expect(listed.body.map((row) => row.slug)).toEqual(["prod"]);
  });

  it("scopes the slug to its project", async () => {
    // Environment slugs are unique only WITHIN a project, so a global
    // `WHERE slug = 'prod'` would find some other project's production
    // environment, authorize against the one the caller named, and operate on
    // the one it found.
    const otherId = await seedProject(api.db, "other");
    await seedEnvironment(api.db, otherId, "prod");

    expect((await api.fetch("/api/v1/p/acme/e/prod", { token: owner })).status).toBe(404);

    const created = await api.fetch("/api/v1/projects/acme/environments", {
      method: "POST",
      token: owner,
      ...body({ slug: "prod", name: "Production" }),
    });

    expect(created.status).toBe(201);
  });

  it("exposes rev, and it is the same number the secrets ETag carries", async () => {
    await seedEnvironment(api.db, (await api.db.select().from(projects))[0]?.id ?? "", "prod");

    await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
      method: "POST",
      token: owner,
      ...body({ mode: "merge", set: { A: "1" } }),
    });

    const environment = await api.json<{ rev: number }>("/api/v1/p/acme/e/prod", { token: owner });
    const listed = await api.fetch("/api/v1/p/acme/e/prod/secrets", { token: owner });

    expect(listed.headers.get("ETag")).toBe(`"${String(environment.body.rev)}"`);
  });
});

/**
 * THE NON-ORACLE PROPERTY, ASSERTED BYTE FOR BYTE.
 *
 * Returning 403 for a resource that exists but is invisible, and 404 for one
 * that does not exist, turns this API into a lookup service for which project
 * names are in use in an organisation the caller has no access to. Slugs are
 * things like `acme-payroll-migration`; that is a leak with no data attached to
 * it.
 *
 * The two responses are therefore compared in full -- status, code, message and
 * hint -- rather than only on status, because a differing hint is the same
 * oracle with an extra step.
 */
describe("absent and invisible are indistinguishable", () => {
  async function fingerprint(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await api.fetch(path, { ...init, token });
    const parsed = (await response.json()) as Record<string, unknown>;

    // The request id differs by construction and is not part of the answer.
    delete parsed["request_id"];

    return { status: response.status, body: parsed };
  }

  it("gives the same answer for a project that exists and one that does not", async () => {
    await seedProject(api.db, "secret-migration");
    await api.grant({ subject: "outsider@example.com", role: "reader", scopeType: "global" });

    // A global reader would SEE it, so the outsider needs no grant at all.
    const outsider = await api.userToken("nobody@example.com");

    const invisible = await fingerprint("/api/v1/projects/secret-migration", outsider);
    const absent = await fingerprint("/api/v1/projects/does-not-exist", outsider);

    expect(invisible).toEqual(absent);
    expect(invisible).toMatchObject({ status: 404 });
  });

  it("gives the same answer for an environment, too", async () => {
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");

    // Reader on a SIBLING environment: the project is visible, `prod` is not.
    const siblingId = await seedEnvironment(api.db, projectId, "staging");
    await api.grant({
      subject: "scoped@example.com",
      role: "reader",
      scopeType: "environment",
      projectId,
      environmentId: siblingId,
    });

    const scoped = await api.userToken("scoped@example.com");

    const invisible = await fingerprint("/api/v1/p/acme/e/prod", scoped);
    const absent = await fingerprint("/api/v1/p/acme/e/nope", scoped);

    expect(invisible).toEqual(absent);
    expect(invisible).toMatchObject({ status: 404 });
  });

  it("gives the same answer for a write, not just a read", async () => {
    // The tempting shortcut is to hide existence on reads and answer 403 on
    // writes, on the grounds that a writer "obviously" knows the resource. They
    // do not: an unauthenticated dictionary walk is a sequence of writes just as
    // easily as reads.
    await seedProject(api.db, "secret-migration");
    const outsider = await api.userToken("nobody@example.com");

    const patch = { method: "PATCH", ...body({ name: "x" }) };

    const invisible = await fingerprint("/api/v1/projects/secret-migration", outsider, patch);
    const absent = await fingerprint("/api/v1/projects/does-not-exist", outsider, patch);

    expect(invisible).toEqual(absent);
    expect(invisible).toMatchObject({ status: 404 });
  });
});
