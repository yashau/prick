/**
 * A role that arrives through a GROUP rather than through a direct grant.
 *
 * Groups are additive: an identity's effective role at a scope is the maximum
 * over its own grants and the grants of every group it belongs to. So the
 * interesting cases are not "does a group work" but the two that a naive
 * implementation gets wrong:
 *
 *   A GROUP GRANT MUST GO THROUGH THE SAME RESOLUTION as a direct one. If it
 *   were resolved on a separate path, the scope inheritance rules -- global
 *   covers every project, project covers every environment, nothing is ever
 *   inherited upwards -- would have to be correct twice.
 *
 *   REMOVING A MEMBER MUST TAKE THE ROLE AWAY IMMEDIATELY. Membership is the
 *   revocation surface an operator will actually reach for ("take them out of
 *   `deploy`"), and a role that outlives it by even one cached request is a
 *   revocation that did not happen.
 *
 * `GET /identities/{id}/effective-permissions` is asserted alongside, because
 * it is the screen an administrator uses to answer "why can this person do
 * that" -- and an explanation that disagrees with the enforcement is worse than
 * no explanation.
 */

import { environmentPath, expect, test } from "../fixtures";
import { SUBJECTS } from "../harness/constants";

interface GroupRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  grantCount: number;
  updatedAt: number;
}

interface EffectiveSource {
  /** Where the role came from. The field the "why" screen is built on. */
  via: "direct" | "group" | "bootstrap";
  role: "reader" | "writer" | "admin";
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  /** Populated when `via === "group"`, and `null` otherwise. */
  group: { id: string; slug: string; name: string } | null;
  grantId: string | null;
  expiresAt: number | null;
  /** True for the source that actually decided the effective role. */
  decisive: boolean;
}

interface EffectiveScope {
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  role: "reader" | "writer" | "admin" | null;
  sources: EffectiveSource[];
}

interface EffectivePermissions {
  identity: { id: string; subject: string };
  groups: { id: string; slug: string; name: string }[];
  scopes: EffectiveScope[];
  bootstrap: boolean;
}

test.describe("group-derived roles", () => {
  test("a group grant confers a role, and losing the membership takes it back", async ({
    adminApi,
    apiAs,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("grp");
    const group = uniqueSlug("deploy");

    await adminApi.request("/projects", {
      method: "POST",
      body: { slug: project, name: "Group scope" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });

    const env = environmentPath(project, "production");
    await adminApi.request(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { GROUPED: "reachable-only-through-a-group" } },
    });

    /*
     * The READER fixture is the subject, and that is the point of choosing it:
     * its only direct grant is environment-scoped on `atlas/production`, so it
     * has no reach into this project at all. Anything it can do here arrived
     * through the group and nowhere else.
     */
    const reader = apiAs("reader");
    expect((await reader.raw(`${env}/secrets`)).status).toBe(404);

    const identities = await adminApi.request<{ id: string; subject: string }[]>("/identities");
    const identity = identities.find((entry) => entry.subject === SUBJECTS.reader);
    expect(identity, "the reader identity exists after its first request").toBeDefined();

    // --- the group ----------------------------------------------------------
    const created = await adminApi.request<GroupRecord>("/groups", {
      method: "POST",
      body: { slug: group, name: "Deploy", description: "Created by the e2e suite." },
    });

    await adminApi.request(`/groups/${created.id}/grants`, {
      method: "POST",
      body: { scope_type: "project", project, role: "writer" },
    });

    // Still nothing: a grant on a group nobody is in reaches nobody.
    expect((await reader.raw(`${env}/secrets`)).status).toBe(404);

    await adminApi.request(`/groups/${created.id}/members`, {
      method: "POST",
      body: { identity_id: identity?.id },
    });

    // --- and now the role is there, WRITER, at project scope ---------------
    const listing = await reader.raw(`${env}/secrets`);
    expect(listing.status).toBe(200);

    const write = await reader.raw(`${env}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { WRITTEN_VIA_GROUP: "1" } },
    });
    expect(write.status).toBe(200);

    /*
     * Downward inheritance, through the group, on the same code path as a
     * direct grant: the grant is PROJECT-scoped and the write is to an
     * ENVIRONMENT in it.
     */
    const revealed = await reader.raw(`${env}/secrets/GROUPED?reason=reveal`);
    expect(revealed.status).toBe(200);

    // --- the explanation agrees with the enforcement ------------------------
    const permissions = await adminApi.request<EffectivePermissions>(
      `/identities/${identity?.id ?? ""}/effective-permissions`,
    );

    expect(permissions.groups.map((entry) => entry.slug)).toContain(group);

    const scope = permissions.scopes.find(
      (entry) => entry.scopeType === "project" && entry.projectSlug === project,
    );
    expect(scope?.role).toBe("writer");

    /*
     * And it NAMES THE GROUP as where the role came from, and marks that source
     * decisive. This is the whole reason the endpoint exists: "why can they do
     * that" has to be answerable without reading the grants table by hand, and
     * an explanation that said only "writer" would leave an administrator
     * hunting for a direct grant that does not exist.
     */
    const source = scope?.sources.find((entry) => entry.group?.slug === group);
    expect(source, "the group should be named as a source of the role").toBeDefined();
    expect(source?.via).toBe("group");
    expect(source?.role).toBe("writer");
    expect(source?.decisive).toBe(true);

    // --- remove the membership ---------------------------------------------
    await adminApi.raw(`/groups/${created.id}/members/${identity?.id ?? ""}`, {
      method: "DELETE",
    });

    /*
     * IMMEDIATELY, and back to 404 rather than 403: with the group role gone
     * the project is not merely un-writable, it is invisible, and
     * `assertVisible` runs first.
     */
    expect((await reader.raw(`${env}/secrets`)).status).toBe(404);
    const afterReveal = await reader.raw(`${env}/secrets/GROUPED?reason=reveal`);
    expect(afterReveal.status).toBe(404);
    expect(afterReveal.text).not.toContain("reachable-only-through-a-group");
  });

  test("a group grant does not reach upwards out of its scope", async ({
    adminApi,
    apiAs,
    uniqueSlug,
  }) => {
    const project = uniqueSlug("grp-scope");
    const group = uniqueSlug("scoped");

    await adminApi.request("/projects", {
      method: "POST",
      body: { slug: project, name: "Scoped" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "production", name: "Production" },
    });
    await adminApi.request(`/projects/${project}/environments`, {
      method: "POST",
      body: { slug: "staging", name: "Staging" },
    });

    const identities = await adminApi.request<{ id: string; subject: string }[]>("/identities");
    const identity = identities.find((entry) => entry.subject === SUBJECTS.service);

    const created = await adminApi.request<GroupRecord>("/groups", {
      method: "POST",
      body: { slug: group, name: "Scoped" },
    });

    // ENVIRONMENT-scoped, on production only.
    await adminApi.request(`/groups/${created.id}/grants`, {
      method: "POST",
      body: { scope_type: "environment", project, environment: "production", role: "reader" },
    });
    await adminApi.request(`/groups/${created.id}/members`, {
      method: "POST",
      body: { identity_id: identity?.id },
    });

    const service = apiAs("service");

    expect((await service.raw(`${environmentPath(project, "production")}/secrets`)).status).toBe(
      200,
    );

    // The sibling environment is not reachable, and neither is the project as
    // a whole. A group is a way to hold a grant, not a way to widen one.
    expect((await service.raw(`${environmentPath(project, "staging")}/secrets`)).status).toBe(404);

    const write = await service.raw(`${environmentPath(project, "production")}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: { NOPE: "1" } },
    });
    expect(write.status).toBe(403);

    // Tidy up: this group holds a grant on a shared identity, and leaving it in
    // place would silently widen what the `service` role can do in every spec
    // that runs after this one.
    await adminApi.raw(`/groups/${created.id}`, { method: "DELETE" });
  });
});
