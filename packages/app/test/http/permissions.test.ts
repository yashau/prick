import { describe, expect, it } from "vitest";

import {
  seedEnvironment,
  seedGroup,
  seedGroupMember,
  seedIdentity,
  seedProject,
} from "../auth/fixtures.js";
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

/**
 * The actors, one grant each. `nobody` authenticates and holds nothing.
 *
 * ---------------------------------------------------------------------------
 * THE LAST FOUR COLUMNS ARE THE POINT OF THE GROUPS FEATURE
 * ---------------------------------------------------------------------------
 * `group-*` actors hold NO grant of their own. They are in a group, and the
 * GROUP holds the grant. Their columns are therefore expected to be identical,
 * cell for cell, to the direct-grant actor of the same role:
 *
 *   group-global-admin   == global-admin
 *   group-project-admin  == project-admin
 *   group-env-writer     == env-writer
 *   group-disabled-admin == nobody
 *
 * That last equivalence is the one worth staring at. `group-disabled-admin` is a
 * member of a group holding GLOBAL ADMIN, and is `disabled`. It must be
 * indistinguishable from an identity nobody has ever granted anything -- the
 * kill switch outranks every grant at every scope, and adding a second way to
 * acquire a role must not add a way around it.
 *
 * The equality is written out per row rather than computed from the direct
 * column, for the reason the whole table is written out: a test that derives its
 * expectation agrees with the code's bugs. Here it would agree with a bug that
 * broke both paths at once, which is exactly the interesting failure.
 */
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
  | "env-admin"
  | "group-global-admin"
  | "group-project-admin"
  | "group-env-writer"
  | "group-disabled-admin";

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
  "group-global-admin",
  "group-project-admin",
  "group-env-writer",
  "group-disabled-admin",
];

type Expectations = Record<ActorName, number>;

/** Shorthand for a row, so a table entry fits on a screen. */
function row(
  values: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
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
  /** A group holding one project-scoped reader grant on `acme`. */
  targetGroupId: string;
  /** That group's grant, usable as a revoke target. */
  targetGroupGrantId: string;
  /** An identity already IN that group, so a removal has something to remove. */
  targetMemberId: string;
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

  // A group to operate ON, distinct from any group an actor is a member of.
  // It holds a project-scoped reader grant so that revoking it is a scoped
  // operation rather than a global one, and it has one member so that a removal
  // has something to remove.
  const {
    identityId: targetMemberId,
    groupId: targetGroupId,
    grantId: targetGroupGrantId,
  } = await api.groupGrant({
    subject: "in-a-group@example.com",
    group: "targets",
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

    /*
     * The group-derived half. `groupGrant` is signature-identical to `grant`:
     * the ONLY difference between these four cases and their direct
     * counterparts above is which of the two the fixture called.
     */
    case "group-global-admin":
      await api.groupGrant({ subject: subjectOf(actor), role: "admin", scopeType: "global" });
      break;
    case "group-project-admin":
      await api.groupGrant({
        subject: subjectOf(actor),
        role: "admin",
        scopeType: "project",
        projectId,
      });
      break;
    case "group-env-writer":
      await api.groupGrant({
        subject: subjectOf(actor),
        role: "writer",
        scopeType: "environment",
        projectId,
        environmentId,
      });
      break;
    case "group-disabled-admin":
      // In a group holding GLOBAL ADMIN, and disabled. Must behave exactly like
      // `nobody` in every cell of this table.
      await api.groupGrant({
        subject: subjectOf(actor),
        role: "admin",
        scopeType: "global",
        disabled: true,
      });
      break;
  }

  return {
    api,
    projectId,
    environmentId,
    targetIdentityId,
    targetGrantId,
    targetGroupId,
    targetGroupGrantId,
    targetMemberId,
  };
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
    expect: row([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]),
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
    expect: row([403, 403, 201, 201, 403, 403, 403, 403, 403, 403, 201, 403, 403, 403]),
  },
  {
    name: "GET /projects/acme",
    // Every scoped actor sees it, INCLUDING the environment-scoped ones: you
    // cannot reach an environment except through its project, so an environment
    // grant makes the project visible without conferring any role on it.
    request: () => ({ path: "/api/v1/projects/acme", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "PATCH /projects/acme",
    request: () => ({
      path: "/api/v1/projects/acme",
      init: { method: "PATCH", ...body({ name: "Renamed" }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 403, 403, 200, 200, 403, 404]),
  },
  {
    name: "DELETE /projects/acme",
    request: () => ({ path: "/api/v1/projects/acme", init: { method: "DELETE" } }),
    expect: row([404, 403, 403, 204, 403, 403, 204, 403, 403, 403, 204, 204, 403, 404]),
  },
  {
    name: "GET /projects/acme/environments",
    request: () => ({ path: "/api/v1/projects/acme/environments", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "POST /projects/acme/environments",
    request: () => ({
      path: "/api/v1/projects/acme/environments",
      init: { method: "POST", ...body({ slug: "staging", name: "Staging" }) },
    }),
    expect: row([404, 403, 201, 201, 403, 201, 201, 403, 403, 403, 201, 201, 403, 404]),
  },
  {
    name: "GET environment",
    request: () => ({ path: "/api/v1/p/acme/e/prod", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "DELETE environment",
    // The one row where `env-admin` succeeds and `project-writer` does not:
    // admin at the environment scope is exactly what this needs, and writer
    // above it is not enough.
    request: () => ({ path: "/api/v1/p/acme/e/prod", init: { method: "DELETE" } }),
    expect: row([404, 403, 403, 204, 403, 403, 204, 403, 403, 204, 204, 204, 403, 404]),
  },
  {
    name: "GET secrets",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "POST secrets:batch",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:batch",
      init: { method: "POST", ...body({ mode: "merge", set: { NEW_KEY: "v" } }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200, 200, 200, 200, 404]),
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
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "GET secrets:export",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets:export", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "POST secrets:rename",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:rename",
      init: { method: "POST", ...body({ from: "API_TOKEN", to: "RENAMED_TOKEN" }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "POST secrets:rollback",
    request: () => ({
      path: "/api/v1/p/acme/e/prod/secrets:rollback",
      init: { method: "POST", ...body({ key: "API_TOKEN", to_version: 1 }) },
    }),
    expect: row([404, 403, 200, 200, 403, 200, 200, 403, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "GET secrets/API_TOKEN (reveal)",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets/API_TOKEN", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "GET secrets/API_TOKEN/versions",
    request: () => ({ path: "/api/v1/p/acme/e/prod/secrets/API_TOKEN/versions", init: {} }),
    expect: row([404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404]),
  },
  {
    name: "GET /identities",
    // ANY admin, at any scope. Restricting the access graph to global admins
    // would make delegated administration decorative: a project admin cannot
    // grant access without seeing who there is to grant it to.
    request: () => ({ path: "/api/v1/identities", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
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
    expect: row([403, 403, 403, 200, 403, 403, 403, 403, 403, 403, 200, 403, 403, 403]),
  },
  {
    name: "GET /grants",
    request: () => ({ path: "/api/v1/grants", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
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
    expect: row([404, 403, 403, 201, 403, 403, 201, 403, 403, 403, 201, 201, 403, 404]),
  },
  {
    name: "DELETE /grants/{id}",
    // 403 rather than 404 for the grantless actor, and that is `core`'s choice
    // rather than this layer's: `revokeGrant` looks the grant up by id and
    // checks admin at ITS scope, with no visibility step -- a grant id is an
    // opaque UUIDv7 that nobody guesses, so there is no dictionary to walk.
    request: (s) => ({ path: `/api/v1/grants/${s.targetGrantId}`, init: { method: "DELETE" } }),
    expect: row([403, 403, 403, 204, 403, 403, 204, 403, 403, 403, 204, 204, 403, 403]),
  },
  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------
  {
    name: "GET /groups",
    // ANY admin, the same rule as GET /identities and for the same reason: a
    // project admin cannot grant a role to a group they are not allowed to see.
    request: () => ({ path: "/api/v1/groups", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "POST /groups",
    // GLOBAL admin. 403 rather than 404 for a grantless actor: a group is not
    // addressed by this request, so there is no existence to conceal.
    //
    // The project admin's 403 is the whole security argument: they may grant to
    // a group (below) and may not curate one, because a roster they curate plus
    // a grant they issue is a way to grant themselves access somewhere else.
    request: () => ({
      path: "/api/v1/groups",
      init: { method: "POST", ...body({ slug: "new-group", name: "New" }) },
    }),
    expect: row([403, 403, 403, 201, 403, 403, 403, 403, 403, 403, 201, 403, 403, 403]),
  },
  {
    name: "GET /groups/{id}",
    request: (s) => ({ path: `/api/v1/groups/${s.targetGroupId}`, init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "PATCH /groups/{id}",
    // 403 and not 404 for everyone below global admin, because the role check
    // runs BEFORE the group is looked up -- there is nothing to conceal about a
    // group whose id the caller had to already know to name.
    request: (s) => ({
      path: `/api/v1/groups/${s.targetGroupId}`,
      init: { method: "PATCH", ...body({ name: "Renamed" }) },
    }),
    expect: row([403, 403, 403, 200, 403, 403, 403, 403, 403, 403, 200, 403, 403, 403]),
  },
  {
    name: "DELETE /groups/{id}",
    request: (s) => ({ path: `/api/v1/groups/${s.targetGroupId}`, init: { method: "DELETE" } }),
    expect: row([403, 403, 403, 204, 403, 403, 403, 403, 403, 403, 204, 403, 403, 403]),
  },
  {
    name: "GET /groups/{id}/members",
    request: (s) => ({ path: `/api/v1/groups/${s.targetGroupId}/members`, init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "POST /groups/{id}/members",
    // THE ESCALATION SURFACE, and therefore global admin only. A project admin
    // who could add a member to a group that also holds admin elsewhere could
    // add themselves and acquire access to a project they cannot even see.
    request: (s) => ({
      path: `/api/v1/groups/${s.targetGroupId}/members`,
      init: { method: "POST", ...body({ identity_id: s.targetIdentityId }) },
    }),
    expect: row([403, 403, 403, 201, 403, 403, 403, 403, 403, 403, 201, 403, 403, 403]),
  },
  {
    name: "DELETE /groups/{id}/members/{identityId}",
    request: (s) => ({
      path: `/api/v1/groups/${s.targetGroupId}/members/${s.targetMemberId}`,
      init: { method: "DELETE" },
    }),
    expect: row([403, 403, 403, 204, 403, 403, 403, 403, 403, 403, 204, 403, 403, 403]),
  },
  {
    name: "GET /groups/{id}/grants",
    request: (s) => ({ path: `/api/v1/groups/${s.targetGroupId}/grants`, init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "POST /groups/{id}/grants (environment scope)",
    // Admin AT THE SCOPE BEING GRANTED -- identical to POST /grants, including
    // the 404 for a grantless actor, because the project is resolved (and
    // refused) before the role is considered.
    //
    // ENVIRONMENT scope rather than project, for two reasons: `env-admin`
    // succeeds here and is 403 on the project-scoped row above, which is the
    // downward-inheritance rule visible in two cells; and the target group
    // already holds a PROJECT-scoped grant on `acme`, so a project-scoped
    // request would be a 409 from the partial unique index rather than a
    // permission answer.
    request: (s) => ({
      path: `/api/v1/groups/${s.targetGroupId}/grants`,
      init: {
        method: "POST",
        ...body({
          scope_type: "environment",
          project: "acme",
          environment: "prod",
          role: "reader",
        }),
      },
    }),
    expect: row([404, 403, 403, 201, 403, 403, 201, 403, 403, 201, 201, 201, 403, 404]),
  },
  {
    name: "DELETE /groups/{id}/grants/{grantId}",
    // 403 rather than 404 for the grantless actor, matching DELETE /grants/{id}:
    // the grant is looked up by id and admin is checked at ITS scope, with no
    // visibility step, because a UUIDv7 pair is not a dictionary anyone walks.
    request: (s) => ({
      path: `/api/v1/groups/${s.targetGroupId}/grants/${s.targetGroupGrantId}`,
      init: { method: "DELETE" },
    }),
    expect: row([403, 403, 403, 204, 403, 403, 204, 403, 403, 403, 204, 204, 403, 403]),
  },
  {
    name: "GET /identities/{id}/effective-permissions",
    request: (s) => ({
      path: `/api/v1/identities/${s.targetIdentityId}/effective-permissions`,
      init: {},
    }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "GET /access/unknown-identities",
    request: () => ({ path: "/api/v1/access/unknown-identities", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
  },
  {
    name: "GET /audit",
    // Admin at ANY scope, because `queryAudit` narrows the query to what the
    // caller administers rather than gating yes/no at the door. A global admin
    // sees the whole log; a project admin sees their project's rows and its
    // environments'; an environment admin sees that environment's.
    //
    // Everyone below admin is refused, and it is worth being explicit about why
    // a global READER is 403 here while being 200 on most reads: audit rows
    // carry actor email addresses and secret KEY NAMES across every project at
    // once, which is a strictly broader disclosure than any single resource
    // this role can already see.
    //
    // That the 200s stop at admin is the gate; that each admin sees only their
    // own rows is asserted separately in test/core/audit.test.ts, which can
    // inspect the entries rather than only the status.
    request: () => ({ path: "/api/v1/audit", init: {} }),
    expect: row([403, 403, 403, 200, 403, 403, 200, 403, 403, 200, 200, 200, 403, 403]),
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

describe("a role held only through a group", () => {
  it("is a real role, and disappears the moment the membership does", async () => {
    /*
     * THE REVOCATION TEST, and the reason the authorization snapshot is cached
     * per REQUEST rather than anywhere longer-lived.
     *
     * There is no cache to invalidate here and no TTL to wait out: the request
     * after the removal re-runs the join, finds no membership, and the role is
     * gone. A snapshot cached across requests would make this test the one that
     * fails, which is exactly what it is for.
     */
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");

    const { identityId, groupId } = await api.groupGrant({
      subject: "via-group@example.com",
      group: "platform",
      role: "writer",
      scopeType: "project",
      projectId,
    });

    const token = await api.userToken("via-group@example.com");

    // The group's grant is the ONLY thing this identity has.
    expect(
      (
        await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
          method: "POST",
          token,
          ...body({ mode: "merge", set: { FROM_GROUP: "1" } }),
        })
      ).status,
    ).toBe(200);

    const removed = await api.fetch(`/api/v1/groups/${groupId}/members/${identityId}`, {
      method: "DELETE",
      token: await api.ownerToken(),
    });
    expect(removed.status).toBe(204);

    // Not 403: with the membership gone there is no grant anywhere, so the
    // project is invisible again and invisible is reported as absent.
    expect((await api.fetch("/api/v1/projects/acme", { token })).status).toBe(404);
    expect(
      (
        await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
          method: "POST",
          token,
          ...body({ mode: "merge", set: { FROM_GROUP: "2" } }),
        })
      ).status,
    ).toBe(404);
  });

  it("confers NOTHING when the group holds no grants", async () => {
    // The no-implicit-role property, restated for groups. Membership is a list.
    const api = await apiHarness();
    await seedProject(api.db, "acme");

    const identityId = await seedIdentity(api.db, {
      kind: "user",
      subject: "listed@example.com",
    });
    const groupId = await seedGroup(api.db, "everyone");
    await seedGroupMember(api.db, groupId, identityId);

    const token = await api.userToken("listed@example.com");

    expect((await api.fetch("/api/v1/projects/acme", { token })).status).toBe(404);
    expect((await api.fetch("/api/v1/identities", { token })).status).toBe(403);

    const { body: projects } = await api.json<unknown[]>("/api/v1/projects", { token });
    expect(projects).toEqual([]);
  });
});

describe("an expired group grant is not a grant", () => {
  it("stops covering the project the moment it lapses, exactly like a direct one", async () => {
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");

    await api.groupGrant({
      subject: "lapsed-group@example.com",
      group: "seasonal",
      role: "admin",
      scopeType: "project",
      projectId,
      // Absolute epoch ms, against the request's clock -- the same comparison
      // the direct path uses, because it is literally the same column read by
      // the same branch of the same loop.
      expiresAt: Date.now() - 1000,
    });

    const token = await api.userToken("lapsed-group@example.com");

    expect((await api.fetch("/api/v1/projects/acme", { token })).status).toBe(404);
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
