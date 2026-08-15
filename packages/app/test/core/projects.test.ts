import { Slug } from "@prick/shared";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
} from "../../src/lib/server/core/environments.js";
import {
  createProject,
  deleteProject,
  getProjectBySlug,
  listProjects,
  updateProject,
} from "../../src/lib/server/core/projects.js";
import { writeSecrets } from "../../src/lib/server/core/secrets.js";
import type { Keyring } from "../../src/lib/server/crypto/index.js";
import type { Database } from "../../src/lib/server/db/client.js";
import {
  auditLog,
  environments,
  grants,
  secrets,
  secretVersions,
} from "../../src/lib/server/db/schema.js";
import { rejectsWith } from "../auth/rejects.js";
import {
  freshDatabase,
  secretsContext,
  seedEnvironment,
  seedGlobalAdmin,
  seedGrant,
  seedIdentity,
  seedProject,
  testKeyring,
  userActor,
} from "./fixtures.js";

const ADMIN = "admin@example.com";
const SCOPED = "scoped@example.com";
const NOBODY = "nobody@example.com";

let db: Database;
let keyring: Keyring;

beforeEach(async () => {
  db = await freshDatabase();
  keyring = await testKeyring();
  await seedGlobalAdmin(db, ADMIN);
});

function as(subject: string) {
  return secretsContext(db, userActor(subject), keyring);
}

describe("an invisible resource is INDISTINGUISHABLE from an absent one", () => {
  /**
   * The rule, and why it is worth the loss of diagnostic precision.
   *
   * A 403 on a project the actor cannot see is a statement that the project
   * EXISTS. An actor with no grant anywhere can then walk a slug dictionary and
   * read off which projects an organisation has -- and slugs are things like
   * `acme-payroll-migration`. The API has leaked exactly the fact it was asked
   * to protect, through its error codes rather than its responses.
   */
  it("returns NOT_FOUND for a project that exists but is not visible", async () => {
    await seedProject(db, "secret-project");
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    await rejectsWith(() => getProjectBySlug(as(NOBODY), "secret-project"), "NOT_FOUND");
  });

  it("returns NOT_FOUND for a project that does not exist", async () => {
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    await rejectsWith(() => getProjectBySlug(as(NOBODY), "no-such-project"), "NOT_FOUND");
  });

  it("produces byte-identical errors for the two cases", async () => {
    await seedProject(db, "secret-project");
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    const invisible = await rejectsWith(
      () => getProjectBySlug(as(NOBODY), "secret-project"),
      "NOT_FOUND",
    );
    const absent = await rejectsWith(
      () => getProjectBySlug(as(NOBODY), "no-such-project"),
      "NOT_FOUND",
    );

    // Same code, same status, same message, same hint. There is no field for a
    // caller to diff.
    expect(absent.message).toBe(invisible.message);
    expect(absent.hint).toBe(invisible.hint);
    expect(absent.status).toBe(invisible.status);
  });

  it("audits the denial even though the caller is told nothing", async () => {
    await seedProject(db, "secret-project");
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    await rejectsWith(() => getProjectBySlug(as(NOBODY), "secret-project"), "NOT_FOUND");

    // The 404 tells the caller nothing; the log tells the operator everything.
    // This is what feeds "Seen but not granted", and without it the standard
    // provisioning flow -- point CI at prick, watch it fail, click Grant --
    // would not work for the most common first request.
    const rows = await db.select().from(auditLog);
    const denial = rows.find((row) => row.outcome === "denied");

    expect(denial?.actorSubject).toBe(NOBODY);
    expect(denial?.action).toBe("access.denied");
  });

  it("does NOT audit a denial for a project that never existed", async () => {
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    await rejectsWith(() => getProjectBySlug(as(NOBODY), "no-such-project"), "NOT_FOUND");

    // Nothing was denied -- there was nothing to deny. Recording one would fill
    // the "Seen but not granted" screen with the noise of mistyped slugs.
    const rows = await db.select().from(auditLog);
    expect(rows.filter((row) => row.outcome === "denied")).toHaveLength(0);
  });

  it("returns 403, not 404, once the actor CAN see the resource", async () => {
    // Visibility first, capability second. A 403 here leaks nothing, because
    // the actor has already been shown that the project exists.
    const projectId = await seedProject(db, "acme");
    const identityId = await seedIdentity(db, { kind: "user", subject: SCOPED });
    await seedGrant(db, { identityId, role: "reader", scopeType: "project", projectId });

    await expect(getProjectBySlug(as(SCOPED), "acme")).resolves.toMatchObject({ slug: "acme" });

    await rejectsWith(() => updateProject(as(SCOPED), "acme", { name: "Renamed" }), "FORBIDDEN");
  });
});

describe("listing is scoped in the query", () => {
  it("shows a global admin everything", async () => {
    await seedProject(db, "one");
    await seedProject(db, "two");

    expect((await listProjects(as(ADMIN))).map((row) => row.slug)).toEqual(["one", "two"]);
  });

  it("shows a project-scoped reader exactly their project", async () => {
    const projectId = await seedProject(db, "one");
    await seedProject(db, "two");

    const identityId = await seedIdentity(db, { kind: "user", subject: SCOPED });
    await seedGrant(db, { identityId, role: "reader", scopeType: "project", projectId });

    expect((await listProjects(as(SCOPED))).map((row) => row.slug)).toEqual(["one"]);
  });

  it("makes a project visible through an ENVIRONMENT-scoped grant", async () => {
    const projectId = await seedProject(db, "one");
    await seedProject(db, "two");
    const environmentId = await seedEnvironment(db, projectId, "prod");
    await seedEnvironment(db, projectId, "dev");

    const identityId = await seedIdentity(db, { kind: "user", subject: SCOPED });
    await seedGrant(db, { identityId, role: "reader", scopeType: "environment", environmentId });

    // You cannot navigate to an environment whose project you cannot see, so
    // the grant makes the project visible...
    expect((await listProjects(as(SCOPED))).map((row) => row.slug)).toEqual(["one"]);

    // ...but not its sibling environments. That is the leak the scope exists
    // to prevent, and it is why `listEnvironments` re-checks per row.
    expect((await listEnvironments(as(SCOPED), "one")).map((row) => row.slug)).toEqual(["prod"]);
  });

  it("shows an ungranted actor nothing at all", async () => {
    await seedProject(db, "one");
    await seedIdentity(db, { kind: "user", subject: NOBODY });

    expect(await listProjects(as(NOBODY))).toEqual([]);
  });
});

describe("cascade delete is the database's job", () => {
  it("removes environments, secrets, versions and grants in ONE statement", async () => {
    const projectId = await seedProject(db, "acme");
    const environmentId = await seedEnvironment(db, projectId, "prod");

    await writeSecrets(as(ADMIN), "acme", "prod", {
      mode: "replace",
      set: { A: "1", B: "2" },
    });

    const identityId = await seedIdentity(db, { kind: "user", subject: SCOPED });
    await seedGrant(db, { identityId, role: "reader", scopeType: "project", projectId });
    await seedGrant(db, {
      identityId,
      role: "reader",
      scopeType: "environment",
      environmentId,
    });

    await deleteProject(as(ADMIN), "acme");

    // Upstream hand-rolled this across four sequential non-atomic statements,
    // whose third failure left a project whose environments were gone and whose
    // grants still pointed at them. D1 enforces foreign keys, so ON DELETE
    // CASCADE fires and there is no hand-rolled cascade to get wrong.
    expect(await db.select().from(environments)).toHaveLength(0);
    expect(await db.select().from(secrets)).toHaveLength(0);
    expect(await db.select().from(secretVersions)).toHaveLength(0);
    expect(await db.select().from(grants).where(undefined)).toHaveLength(1); // the admin's global grant
  });

  it("does NOT cascade into the audit log", async () => {
    const projectId = await seedProject(db, "acme");
    await seedEnvironment(db, projectId, "prod");

    await writeSecrets(as(ADMIN), "acme", "prod", { mode: "replace", set: { A: "1" } });
    await deleteProject(as(ADMIN), "acme");

    // `audit_log` deliberately has NO foreign key to anything. A cascade there
    // would delete exactly the history you need after removing a project --
    // "who deleted it, and what did it contain" is the question the log exists
    // to answer.
    const rows = await db.select().from(auditLog);
    expect(rows.filter((row) => row.action === "secret.write")).toHaveLength(1);
    expect(rows.filter((row) => row.action === "project.delete")).toHaveLength(1);
  });

  it("deleting an environment cascades to its secrets only", async () => {
    const projectId = await seedProject(db, "acme");
    await seedEnvironment(db, projectId, "prod");
    await seedEnvironment(db, projectId, "dev");

    await writeSecrets(as(ADMIN), "acme", "prod", { mode: "replace", set: { A: "1" } });
    await writeSecrets(as(ADMIN), "acme", "dev", { mode: "replace", set: { B: "2" } });

    await deleteEnvironment(as(ADMIN), "acme", "prod");

    const remaining = await db.select().from(secrets);
    expect(remaining.map((row) => row.key)).toEqual(["B"]);
  });
});

describe("every mutation carries its audit row", () => {
  const MUTATIONS: [string, () => Promise<unknown>, string][] = [
    [
      "project.create",
      () => createProject(as(ADMIN), { slug: "made", name: "Made" }),
      "project.create",
    ],
  ];

  for (const [name, run, action] of MUTATIONS) {
    it(`${name} writes one`, async () => {
      await run();
      const rows = await db.select().from(auditLog);
      expect(rows.filter((row) => row.action === action)).toHaveLength(1);
    });
  }

  it("environment.create and .delete too", async () => {
    await createProject(as(ADMIN), { slug: "acme", name: "Acme" });
    await createEnvironment(as(ADMIN), "acme", { slug: "prod", name: "Production" });
    await deleteEnvironment(as(ADMIN), "acme", "prod");

    const actions = (await db.select().from(auditLog)).map((row) => row.action);
    expect(actions).toContain("environment.create");
    expect(actions).toContain("environment.delete");
  });

  it("records field NAMES on an update, never their contents", async () => {
    await createProject(as(ADMIN), { slug: "acme", name: "Acme" });
    await updateProject(as(ADMIN), "acme", { description: "internal codename: bluebird" });

    const row = (await db.select().from(auditLog)).find(
      (entry) => entry.action === "project.update",
    );

    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ fields: ["description"] });
    expect(row?.detail).not.toContain("bluebird");
  });
});

describe("slug handling", () => {
  it("refuses a duplicate slug with CONFLICT", async () => {
    await createProject(as(ADMIN), { slug: "acme", name: "Acme" });

    await rejectsWith(
      () => createProject(as(ADMIN), { slug: "acme", name: "Acme Again" }),
      "CONFLICT",
    );
  });

  it("resolves environments by the slug PAIR, never by environment slug alone", async () => {
    // Environment slugs are unique only WITHIN a project. A global
    // `WHERE slug = 'prod'` would find another project's production
    // environment, authorize against the one named and operate on the one
    // found -- and every test using distinct names would still pass.
    await createProject(as(ADMIN), { slug: "one", name: "One" });
    await createProject(as(ADMIN), { slug: "two", name: "Two" });
    await createEnvironment(as(ADMIN), "one", { slug: "prod", name: "Prod" });
    await createEnvironment(as(ADMIN), "two", { slug: "prod", name: "Prod" });

    await writeSecrets(as(ADMIN), "one", "prod", { mode: "replace", set: { WHICH: "one" } });
    await writeSecrets(as(ADMIN), "two", "prod", { mode: "replace", set: { WHICH: "two" } });

    const { exportSecrets } = await import("../../src/lib/server/core/secrets.js");
    expect(await exportSecrets(as(ADMIN), "one", "prod")).toEqual({ WHICH: "one" });
    expect(await exportSecrets(as(ADMIN), "two", "prod")).toEqual({ WHICH: "two" });
  });

  it("matches slugs EXACTLY, never as a prefix", async () => {
    await createProject(as(ADMIN), { slug: "acme", name: "Acme" });

    await rejectsWith(() => getProjectBySlug(as(ADMIN), "acm"), "NOT_FOUND");
    await rejectsWith(() => getProjectBySlug(as(ADMIN), "acme-2"), "NOT_FOUND");
  });

  /**
   * The grammar property the CLI's `project:environment` syntax rests on.
   *
   * Asserted here rather than assumed, because relaxing `Slug` to permit a
   * colon would not break anything in this package -- it would break the CLI's
   * scope parsing, silently, in a repository the JS test suite does not reach.
   * This is the tripwire for that change.
   */
  describe("the scope-string grammar", () => {
    it("excludes the two characters that would make a scope ambiguous", () => {
      // `:` separates project from environment in a CLI scope.
      expect(Slug.safeParse("acme:prod").success).toBe(false);
      // `/` would add a path segment to the `/p/:slug/e/:slug` alias routes.
      expect(Slug.safeParse("acme/prod").success).toBe(false);

      // And the shapes that ARE legal stay legal.
      expect(Slug.safeParse("acme").success).toBe(true);
      expect(Slug.safeParse("acme-payroll-2").success).toBe(true);
    });

    it("means a scope string has exactly one parse, for every legal pair", () => {
      // With colons outside the grammar, first-colon splitting and
      // split-on-every-colon agree for all reachable inputs -- which is what
      // makes the CLI's first-colon rule pure defence in depth rather than a
      // behaviour anything depends on today.
      for (const project of ["acme", "a", "acme-payroll-2"]) {
        for (const environment of ["prod", "eu-west-1", "x"]) {
          const scope = `${project}:${environment}`;
          const colon = scope.indexOf(":");

          expect(scope.slice(0, colon)).toBe(project);
          expect(scope.slice(colon + 1)).toBe(environment);
        }
      }
    });

    it("first-colon splitting stays wrong-and-loud if the grammar is ever relaxed", () => {
      // `acme:eu:prod` under split-on-every-colon-and-take-[1] resolves to the
      // environment `eu` -- a different, possibly existing environment,
      // addressed silently. First-colon splitting yields `eu:prod`, which
      // either names the environment the user meant or 404s.
      const scope = "acme:eu:prod";
      const colon = scope.indexOf(":");

      expect(scope.slice(0, colon)).toBe("acme");
      expect(scope.slice(colon + 1)).toBe("eu:prod");
      expect(scope.split(":")[1]).toBe("eu"); // the failure mode, for contrast
    });
  });
});
