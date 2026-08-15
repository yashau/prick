import { beforeEach, describe, expect, it } from "vitest";

import { seedEnvironment, seedIdentity, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, OWNER, type ApiHarness } from "./harness.js";

/**
 * The groups surface over real HTTP.
 *
 * `test/http/permissions.test.ts` owns the status-code matrix for these routes.
 * What is here is the part a status code cannot express: that the round trip
 * actually provisions access, and that the effective-permissions response says
 * enough for somebody to act on it.
 */

let api: ApiHarness;
let owner: string;
let projectId: string;

beforeEach(async () => {
  api = await apiHarness();
  projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
  owner = await api.ownerToken();
});

interface GroupBody {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  grantCount: number;
}

async function createGroup(slug: string): Promise<GroupBody> {
  const created = await api.json<GroupBody>("/api/v1/groups", {
    method: "POST",
    token: owner,
    ...body({ slug, name: slug }),
  });

  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

describe("provisioning access through a group", () => {
  it("takes a grantless identity from 404 to 200 by adding it to a granted group", async () => {
    /*
     * The whole feature, end to end, in one test. Nothing about the IDENTITY
     * changes between the two assertions -- no grant is created for it, no row
     * of its own is written. Only its membership changes.
     */
    const stranger = await api.serviceToken("ci.access");
    await api.fetch("/api/v1/whoami", { token: stranger });

    expect((await api.fetch("/api/v1/p/acme/e/prod/secrets", { token: stranger })).status).toBe(
      404,
    );

    const group = await createGroup("deployers");

    const identities = await api.json<{ id: string; subject: string }[]>("/api/v1/identities", {
      token: owner,
    });
    const identityId = identities.body.find((row) => row.subject === "ci.access")?.id ?? "";

    expect(
      (
        await api.fetch(`/api/v1/groups/${group.id}/members`, {
          method: "POST",
          token: owner,
          ...body({ identity_id: identityId }),
        })
      ).status,
    ).toBe(201);

    // Still nothing: a group with no grants is a list.
    expect((await api.fetch("/api/v1/p/acme/e/prod/secrets", { token: stranger })).status).toBe(
      404,
    );

    const granted = await api.json(`/api/v1/groups/${group.id}/grants`, {
      method: "POST",
      token: owner,
      ...body({ scope_type: "environment", project: "acme", environment: "prod", role: "writer" }),
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);

    expect((await api.fetch("/api/v1/p/acme/e/prod/secrets", { token: stranger })).status).toBe(
      200,
    );

    // And the write role came with it, because a group grant is a grant.
    expect(
      (
        await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
          method: "POST",
          token: stranger,
          ...body({ mode: "merge", set: { CI_TOKEN: "x" } }),
        })
      ).status,
    ).toBe(200);
  });

  it("counts members and live grants on the list", async () => {
    const group = await createGroup("platform");

    const listed = await api.json<GroupBody[]>("/api/v1/groups", { token: owner });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ slug: "platform", memberCount: 0, grantCount: 0 }),
    ]);
    expect(group.slug).toBe("platform");
  });

  it("refuses a duplicate slug with 409", async () => {
    await createGroup("platform");

    const again = await api.fetch("/api/v1/groups", {
      method: "POST",
      token: owner,
      ...body({ slug: "platform", name: "Platform" }),
    });

    expect(again.status).toBe(409);
  });

  it("rejects an unknown field on the body with 422", async () => {
    // Every shared schema is `.strict()`, and it matters here for the same
    // reason it matters everywhere: a client sending `identityId` instead of
    // `identity_id` must be told, not silently given an empty group.
    const group = await createGroup("platform");

    const response = await api.fetch(`/api/v1/groups/${group.id}/members`, {
      method: "POST",
      token: owner,
      ...body({ identityId: "01a30000-0000-7000-8000-000000000000" }),
    });

    expect(response.status).toBe(422);
  });
});

interface EffectivePermissions {
  identity: { subject: string; disabled: boolean };
  groups: { slug: string }[];
  bootstrap: boolean;
  scopes: {
    scopeType: string;
    projectSlug: string | null;
    environmentSlug: string | null;
    role: string | null;
    sources: {
      via: string;
      grantId: string | null;
      role: string;
      scopeType: string;
      group: { slug: string } | null;
      decisive: boolean;
    }[];
  }[];
}

describe("why does Bob have production", () => {
  it("answers with the group and the grant id, not just the role", async () => {
    const bobId = await seedIdentity(api.db, { kind: "user", subject: "bob@example.com" });
    const group = await createGroup("platform");

    await api.fetch(`/api/v1/groups/${group.id}/members`, {
      method: "POST",
      token: owner,
      ...body({ identity_id: bobId }),
    });

    const granted = await api.json<{ id: string }>(`/api/v1/groups/${group.id}/grants`, {
      method: "POST",
      token: owner,
      ...body({ scope_type: "project", project: "acme", role: "admin" }),
    });
    expect(granted.status).toBe(201);

    const view = await api.json<EffectivePermissions>(
      `/api/v1/identities/${bobId}/effective-permissions`,
      { token: owner },
    );

    expect(view.status).toBe(200);
    expect(view.body.identity.subject).toBe("bob@example.com");
    expect(view.body.groups.map((g) => g.slug)).toEqual(["platform"]);

    const entry = view.body.scopes.find((scope) => scope.scopeType === "project");
    expect(entry?.projectSlug).toBe("acme");
    expect(entry?.role).toBe("admin");

    // The answer an admin can act on: which group, and which row to delete.
    const decisive = entry?.sources.find((source) => source.decisive);
    expect(decisive?.via).toBe("group");
    expect(decisive?.group?.slug).toBe("platform");
    expect(decisive?.grantId).toBe(granted.body.id);
  });

  it("says nothing at all for an identity nobody granted anything", async () => {
    const nobodyId = await seedIdentity(api.db, { kind: "user", subject: "nobody@example.com" });

    const view = await api.json<EffectivePermissions>(
      `/api/v1/identities/${nobodyId}/effective-permissions`,
      { token: owner },
    );

    expect(view.body.scopes).toEqual([]);
    expect(view.body.groups).toEqual([]);
  });

  it("reports the owner's own global grant as a direct source", async () => {
    const identities = await api.json<{ id: string; subject: string }[]>("/api/v1/identities", {
      token: owner,
    });
    const ownerId = identities.body.find((row) => row.subject === OWNER)?.id ?? "";

    const view = await api.json<EffectivePermissions>(
      `/api/v1/identities/${ownerId}/effective-permissions`,
      { token: owner },
    );

    expect(view.body.scopes).toEqual([
      expect.objectContaining({
        scopeType: "global",
        role: "admin",
        sources: [expect.objectContaining({ via: "direct", role: "admin", decisive: true })],
      }),
    ]);
  });
});

describe("the last administrator, over HTTP", () => {
  it("refuses to delete the group that is the only path to global admin", async () => {
    /*
     * The lockout this closes is reachable through an endpoint whose name does
     * not contain the word "grant": delete the group, and the installation has
     * no administrator and no recovery credential.
     */
    const group = await createGroup("owners");

    const identities = await api.json<{ id: string; subject: string }[]>("/api/v1/identities", {
      token: owner,
    });
    const ownerId = identities.body.find((row) => row.subject === OWNER)?.id ?? "";

    await api.fetch(`/api/v1/groups/${group.id}/members`, {
      method: "POST",
      token: owner,
      ...body({ identity_id: ownerId }),
    });
    await api.fetch(`/api/v1/groups/${group.id}/grants`, {
      method: "POST",
      token: owner,
      ...body({ scope_type: "global", role: "admin" }),
    });

    // While the direct grant is still there, the group is redundant and may go.
    const grants = await api.json<{ id: string; scopeType: string }[]>("/api/v1/grants", {
      token: owner,
    });
    const directGlobal = grants.body.find((row) => row.scopeType === "global")?.id ?? "";

    expect(
      (await api.fetch(`/api/v1/grants/${directGlobal}`, { method: "DELETE", token: owner }))
        .status,
      "the direct grant is revocable because the group still holds one",
    ).toBe(204);

    // Now the group is the only path, and every way of removing it is refused.
    const deleted = await api.json<{ code: string }>(`/api/v1/groups/${group.id}`, {
      method: "DELETE",
      token: owner,
    });

    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("LAST_ADMIN");

    expect(
      (
        await api.fetch(`/api/v1/groups/${group.id}/members/${ownerId}`, {
          method: "DELETE",
          token: owner,
        })
      ).status,
    ).toBe(409);
  });
});
