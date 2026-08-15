import { describe, expect, it } from "vitest";

import { seedEnvironment, seedIdentity, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

/**
 * THE PERMISSION MATRIX: every operation, against every role at every scope.
 *
 * Driven through the real HTTP surface rather than against `core`, because the
 * question this file answers is not "does `assertRole` work" -- `test/auth`
 * already answers that -- but "is every route actually behind it". A route that
 * forgot to resolve its environment, or that called a `core` function with the
 * wrong slug, or that was mounted outside the authentication middleware, passes
 * every unit test in the repository and fails here.
 *
 * ---------------------------------------------------------------------------
 * THE EXPECTATIONS ARE WRITTEN OUT, NOT COMPUTED
 * ---------------------------------------------------------------------------
 * Each cell below is a literal status code. The tempting alternative -- derive
 * the expectation from the actor's role and the operation's requirement -- would
 * be re-implementing `resolveEffectiveRole` in the test, and a test that
 * computes the same answer the code computes agrees with the code's bugs. A
 * table has to be read and argued with.
 *
 * ---------------------------------------------------------------------------
 * 404 VERSUS 403 IS THE PART TO READ CAREFULLY
 * ---------------------------------------------------------------------------
 * An actor with no grant at all gets **404** from every resource-addressed
 * operation, including the writes. Not 403. A 403 would be a statement -- "this
 * project exists, and you may not write to it" -- and an actor with no access
 * anywhere could then walk a slug dictionary and read off which project names
 * are in use in an organisation they have nothing to do with. Slugs are things
 * like `acme-payroll-migration`.
 *
 * 403 appears only where the actor has ALREADY been shown that the resource
 * exists, by holding reader somewhere that covers it. There it leaks nothing
 * they did not already know.
 *
 * Two operations are not resource-addressed and therefore answer 403 to a
 * grantless actor, because there is no existence to conceal: `POST /projects`
 * (there is no project yet) and the access-graph reads.
 */

/** The actors, one grant each. `nobody` authenticates and holds nothing. */
type ActorName =
  | "nobody"
  | "global-reader"
  | "global-writer"
  | "global-admin"
  | "project-reader"
  | "project-writer"
  | "project-admin"
  | "env-reader"
  | "env-writer"
  | "env-admin";

const ACTORS: ActorName[] = [
  "nobody",
  "global-reader",
  "global-writer",
  "global-admin",
  "project-reader",
  "project-writer",
  "project-admin",
  "env-reader",
  "env-writer",
  "env-admin",
];

type Expectations = Record<ActorName, number>;

/** Shorthand for a row, so a table entry fits on a screen. */
function row(
  values: [number, number, number, number, number, number, number, number, number, number],
): Expectations {
  const out = {} as Expectations;
  ACTORS.forEach((actor, index) => {
    out[actor] = values[index] as number;
  });
  return out;
}

interface Scenario {
  api: ApiHarness;
  projectId: string;
  environmentId: string;
  /** An identity that holds nothing, usable as a grant/patch target. */
  targetIdentityId: string;
  /** A project-scoped reader grant on `acme`, usable as a revoke target. */
  targetGrantId: string;
}

/**
 * A fresh installation per cell.
 *
 * Rebuilt for every actor rather than shared across a row, because half these
 * operations mutate: a `DELETE` that succeeded for the global admin would leave
 * the project admin's cell asserting against a project that no longer exists,
 * and the row would pass for the wrong reason.
 */
async function scenario(actor: ActorName): Promise<Scenario> {
  const api = await apiHarness();

  const projectId = await seedProject(api.db, "acme");
  const environmentId = await seedEnvironment(api.db, projectId, "prod");

  // Seeded through the API, as the owner, so the secret has a real version 1
  // and a real ciphertext -- reveal, rollback and rename all need one.
  const owner = await api.ownerToken();
  const seeded = await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
    method: "POST",
    token: owner,
    ...body({ mode: "merge", set: { API_TOKEN: "seeded-value" } }),
  });
  expect(seeded.status, "the fixture write must succeed").toBe(200);

  const targetIdentityId = await seedIdentity(api.db, {
    kind: "service",
    subject: "target.access",
  });

  const { grantId: targetGrantId } = await api.grant({
    subject: "revoke-me@example.com",
    role: "reader",
    scopeType: "project",
    projectId,
  });

  switch (actor) {
    case "nobody":
      await seedIdentity(api.db, { kind: "user", subject: subjectOf(actor) });
      break;
    case "global-reader":
      await api.grant({ subject: subjectOf(actor), role: "reader", scopeType: "global" });
      break;
    case "global-writer":
      await api.grant({ subject: subjectOf(actor), role: "writer", scopeType: "global" });
      break;
    case "global-admin":
      await api.grant({ subject: subjectOf(actor), role: "admin", scopeType: "global" });
      break;
    case "project-reader":
      await api.grant({
        subject: subjectOf(actor),
        role: "reader",
        scopeType: "project",
        projectId,
      });
      break;
    case "project-writer":
      await api.grant({
        subject: subjectOf(actor),
        role: "writer",
        scopeType: "project",
        projectId,
      });
      break;
    case "project-admin":
      await api.grant({
        subject: subjectOf(actor),
        role: "admin",
        scopeType: "project",
        projectId,
      });
      break;
    case "env-reader":
      await api.grant({
        subject: subjectOf(actor),
        role: "reader",
        scopeType: "environment",
        projectId,
        environmentId,
      });
      break;
    case "env-writer":
      await api.grant({
        subject: subjectOf(actor),
        role: "writer",
        scopeType: "environment",
        projectId,
        environmentId,
      });
      break;
    case "env-admin":
      await api.grant({
        subject: subjectOf(actor),
        role: "admin",
        scopeType: "environment",
        projectId,
        environmentId,
      });
      break;
  }

  return { api, projectId, environmentId, targetIdentityId, targetGrantId };
}

function subjectOf(actor: ActorName): string {
  return `${actor}@example.com`;
}

interface Operation {
  name: string;
  /** Built per cell, because some requests reference ids seeded for that cell. */
  request(scenario: Scenario): { path: string; init: RequestInit };
  expect: Expectations;
}

const OPERATIONS: Operation[] = [
  {
    name: "GET /projects",
    // Always 200. The response is SCOPED, so an actor with nothing sees `[]`
    // rather than a refusal -- which is correct: "you have no projects" is not a
    // statement about whether any exist.
    request: () => ({ path: "/api/v1/projects", init: {} }),
    expect: row([200, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "POST /projects",
    // 403 rather than 404 for a grantless actor: there is no project yet, so
    // there is no existence to conceal. Requires GLOBAL writer -- a project has
    // no parent for the permission to be scoped to.
    request: () => ({
      path: "/api/v1/projects",
      init: { method: "POST", ...body({ slug: "new-one", name: "New" }) },
    }),
    expect: row([403, 403, 201, 201, 403, 403, 403, 403, 403, 403]),
  },
  {
    name: "GET /projects/acme",
    // Every scoped actor sees it, INCLUDING the environment-scoped ones: you
    // cannot reach an environment except through its project, so an environment
    // grant makes the project visible without conferring any role on it.
    request: () => ({ path: "/api/v1/projects/acme", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "PATCH /projects/acme",
    request: () => ({
      path: "/api/v1/projects/acme",
      init: { method: "PATCH", ...body({ name: "Renamed" }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 403, 403]),
  },
  {
    name: "DELETE /projects/acme",
    request: () => ({ path: "/api/v1/projects/acme", init: { method: "DELETE" } }),
    expect: row([404, 403, 403, 204, 403, 403, 204, 403, 403, 403]),
  },
  {
    name: "GET /projects/acme/environments",
    request: () => ({ path: "/api/v1/projects/acme/environments", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "POST /projects/acme/environments",
    request: () => ({
      path: "/api/v1/projects/acme/environments",
      init: { method: "POST", ...body({ slug: "staging", name: "Staging" }) },
    }),
    expect: row([404, 403, 201, 201, 403, 201, 201, 403, 403, 403]),
  },
  {
    name: "GET environment",
    request: () => ({ path: "/api/v1/p/acme/e/prod", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "DELETE environment",
    // The one row where `env-admin` succeeds and `project-writer` does not:
    // admin at the environment scope is exactly what this needs, and writer
    // above it is not enough.
    request: () => ({ path: "/api/v1/p/acme/e/prod", init: { method: "DELETE" } }),
    expect: row([404, 403, 403, 204, 403, 403, 204, 403, 403, 204]),
  },
  {
    name: "GET secrets",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "POST secrets:batch",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:batch",
      init: { method: "POST", ...body({ mode: "merge", set: { NEW_KEY: "v" } }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200]),
  },
  {
    name: "POST secrets:import",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:import",
      init: {
        method: "POST",
        ...body({ format: "env", content: "IMPORTED=1\n", mode: "merge", dry_run: false }),
      },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200]),
  },
  {
    name: "GET secrets:export",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets:export", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "POST secrets:rename",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:rename",
      init: { method: "POST", ...body({ from: "API_TOKEN", to: "RENAMED_TOKEN" }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200]),
  },
  {
    name: "POST secrets:rollback",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:rollback",
      init: { method: "POST", ...body({ key: "API_TOKEN", to_version: 1 }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200]),
  },
  {
    name: "GET secrets/API_TOKEN (reveal)",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets/API_TOKEN", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "GET secrets/API_TOKEN/versions",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets/API_TOKEN/versions", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
  },
  {
    name: "GET /identities",
    // ANY admin, at any scope. Restricting the access graph to global admins
    // would make delegated administration decorative: a project admin cannot
    // grant access without seeing who there is to grant it to.
    request: () => ({ path: "/api/v1/identities", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200]),
  },
  {
    name: "PATCH /identities/{id}",
    // GLOBAL admin only. `disabled` is a kill switch that outranks every grant
    // at every scope, so a project admin flipping it would revoke access to
    // projects they have nothing to do with.
    request: (s) => ({
      path: `/api/v1/identities/${s.targetIdentityId}`,
      init: { method: "PATCH", ...body({ display_name: "staging deploy" }) },
    }),
    expect: row([403, 403, 403, 200, 403, 403, 403, 403, 403, 403]),
  },
  {
    name: "GET /grants",
    request: () => ({ path: "/api/v1/grants", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200]),
  },
  {
    name: "POST /grants (project scope)",
    // 404 for the grantless actor because the scope names a project, which is
    // resolved -- and refused -- before the role is considered. `env-admin` is
    // 403: grants inherit downwards only, so admin of one environment is not
    // admin of its project.
    request: (s) => ({
      path: "/api/v1/grants",
      init: {
        method: "POST",
        ...body({
          scope_type: "project",
          project: "acme",
          identity_id: s.targetIdentityId,
          role: "reader",
        }),
      },
    }),
    expect: row([404, 403, 403, 201, 403, 403, 201, 403, 403, 403]),
  },
  {
    name: "DELETE /grants/{id}",
    // 403 rather than 404 for the grantless actor, and that is `core`'s choice
    // rather than this layer's: `revokeGrant` looks the grant up by id and
    // checks admin at ITS scope, with no visibility step -- a grant id is an
    // opaque UUIDv7 that nobody guesses, so there is no dictionary to walk.
    request: (s) => ({ path: `/api/v1/grants/${s.targetGrantId}`, init: { method: "DELETE" } }),
    expect: row([403, 403, 403, 204, 403, 403, 204, 403, 403, 403]),
  },
  {
    name: "GET /access/unknown-identities",
    request: () => ({ path: "/api/v1/access/unknown-identities", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200]),
  },
  {
    name: "GET /audit",
    // GLOBAL admin only, and deliberately stricter than the rest of the access
    // graph: `queryAudit` performs no scope narrowing, so a project admin would
    // receive the whole installation's events. See the note in
    // `http/routes/audit.ts` -- this row moves once the narrowing lands.
    request: () => ({ path: "/api/v1/audit", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 403, 403, 403, 403]),
  },
];

for (const operation of OPERATIONS) {
  describe(operation.name, () => {
    for (const actor of ACTORS) {
      it(`${actor} -> ${String(operation.expect[actor])}`, async () => {
        const context = await scenario(actor);
        const { path, init } = operation.request(context);

        const token = await context.api.userToken(subjectOf(actor));
        const response = await context.api.fetch(path, { ...init, token });

        expect(
          response.status,
          `${operation.name} as ${actor}: ${await describeBody(response)}`,
        ).toBe(operation.expect[actor]);
      });
    }
  });
}

async function describeBody(response: Response): Promise<string> {
  const text = await response.clone().text();
  return text === "" ? "(empty body)" : text.slice(0, 300);
}

describe("a disabled identity resolves to nothing", () => {
  it("outranks a global admin grant", async () => {
    // The kill switch has to be absolute or it is worthless exactly when it is
    // being used in anger.
    const api = await apiHarness();
    await seedProject(api.db, "acme");

    await api.grant({
      subject: "fired@example.com",
      role: "admin",
      scopeType: "global",
      disabled: true,
    });

    const token = await api.userToken("fired@example.com");
    const { status, body: rows } = await api.json<unknown[]>("/api/v1/projects", { token });

    // Visible-set resolution returns the empty set for a disabled identity, so
    // the list is empty rather than refused.
    expect(status).toBe(200);
    expect(rows).toEqual([]);

    expect((await api.fetch("/api/v1/projects/acme", { token })).status).toBe(404);
    expect((await api.fetch("/api/v1/identities", { token })).status).toBe(403);
  });
});

describe("an expired grant is not a grant", () => {
  it("stops covering the project the moment it lapses", async () => {
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");

    await api.grant({
      subject: "lapsed@example.com",
      role: "admin",
      scopeType: "project",
      projectId,
      // Absolute epoch ms, compared against the request's injected clock.
      expiresAt: Date.now() - 1000,
    });

    const token = await api.userToken("lapsed@example.com");

    expect((await api.fetch("/api/v1/projects/acme", { token })).status).toBe(404);
  });
});

describe("a service token is authorized by exactly the same code path", () => {
  it("holds whatever its common_name was granted, and nothing more", async () => {
    // No branch anywhere reads `actor.kind` to decide anything. Upstream's
    // `if (keyType === 'user') return true` is the bug class this asserts is
    // absent -- from the other direction, since a machine client here is neither
    // privileged nor second-class.
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");

    await api.grant({
      subject: "e367826f93b8d71185e03fe518aff3b4.access",
      kind: "service",
      role: "writer",
      scopeType: "environment",
      projectId,
      environmentId: await seedEnvironment(api.db, projectId, "staging"),
    });

    const token = await api.serviceToken("e367826f93b8d71185e03fe518aff3b4.access");

    expect(
      (
        await api.fetch("/api/v1/p/acme/e/staging/secrets:batch", {
          method: "POST",
          token,
          ...body({ mode: "merge", set: { CI_TOKEN: "x" } }),
        })
      ).status,
    ).toBe(200);

    // The sibling environment is invisible, not forbidden.
    expect((await api.fetch("/api/v1/p/acme/e/prod/secrets", { token })).status).toBe(404);
  });
});
