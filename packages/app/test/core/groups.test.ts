import { beforeEach, describe, expect, it } from "vitest";

import {
  addGroupMember,
  createGroup,
  createGroupGrant,
  deleteGroup,
  getGroup,
  listGroupGrants,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  revokeGroupGrant,
  updateGroup,
} from "../../src/lib/server/core/groups.js";
import { revokeGrant } from "../../src/lib/server/core/identities.js";
import { explainIdentityPermissions } from "../../src/lib/server/core/permissions.js";
import { writeSecrets } from "../../src/lib/server/core/secrets.js";
import { can } from "../../src/lib/server/auth/authorize.js";
import { assertAdminsConfigured } from "../../src/lib/server/auth/bootstrap.js";
import type { Keyring } from "../../src/lib/server/crypto/index.js";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import { auditLog, grants, groupGrants, groupMembers } from "../../src/lib/server/db/schema.js";
import { rejectsWith } from "../auth/rejects.js";
import {
  NOW,
  countingBinding,
  freshDatabase,
  requestContext,
  secretsContext,
  seedEnvironment,
  seedGrant,
  seedGroup,
  seedGroupGrant,
  seedGroupMember,
  seedGlobalAdmin,
  seedIdentity,
  seedProject,
  testConfig,
  testKeyring,
  userActor,
} from "./fixtures.js";

/**
 * Groups at the DOMAIN layer: who may curate them, who may grant to them, and
 * what the effective-permissions view says when somebody asks why.
 */

const ADMIN = "admin@example.com";
const PROJECT_ADMIN = "project-admin@example.com";
const BOB = "bob@example.com";

let db: Database;
let keyring: Keyring;
let projectId: string;
let environmentId: string;
let bobId: string;
let adminId: string;

beforeEach(async () => {
  db = await freshDatabase();
  keyring = await testKeyring();
  adminId = await seedGlobalAdmin(db, ADMIN);
  projectId = await seedProject(db, "acme");
  environmentId = await seedEnvironment(db, projectId, "prod");
  bobId = await seedIdentity(db, { kind: "user", subject: BOB });
});

function asAdmin() {
  return requestContext(db, userActor(ADMIN));
}

async function asProjectAdmin() {
  const identityId = await seedIdentity(db, { kind: "user", subject: PROJECT_ADMIN });
  await seedGrant(db, { identityId, role: "admin", scopeType: "project", projectId });
  return requestContext(db, userActor(PROJECT_ADMIN));
}

// ---------------------------------------------------------------------------
// Curating groups
// ---------------------------------------------------------------------------

describe("group lifecycle", () => {
  it("creates, renames and deletes a group, auditing each in the same batch", async () => {
    const created = await createGroup(asAdmin(), { slug: "platform", name: "Platform" });

    expect(created).toMatchObject({ slug: "platform", memberCount: 0, grantCount: 0 });

    await updateGroup(asAdmin(), created.id, { name: "Platform Team" });
    expect((await getGroup(asAdmin(), created.id)).name).toBe("Platform Team");

    await deleteGroup(asAdmin(), created.id);
    await rejectsWith(async () => getGroup(asAdmin(), created.id), "NOT_FOUND");

    const actions = (await db.select().from(auditLog)).map((row) => row.action);
    expect(actions).toEqual(["group.create", "group.update", "group.delete"]);
  });

  it("refuses a duplicate slug with a CONFLICT that names it", async () => {
    await createGroup(asAdmin(), { slug: "platform", name: "Platform" });

    const error = await rejectsWith(
      async () => createGroup(asAdmin(), { slug: "platform", name: "Another" }),
      "CONFLICT",
    );

    expect(error.message).toContain("platform");
  });

  it("cascades memberships and grants away on delete, in one statement", async () => {
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });

    await deleteGroup(asAdmin(), groupId);

    expect(await db.select().from(groupMembers)).toEqual([]);
    expect(await db.select().from(groupGrants)).toEqual([]);

    // And the count of what went with it is in the audit row, because
    // "deleted a group" on its own is not an account anybody can act on.
    const row = (await db.select().from(auditLog)).find((r) => r.action === "group.delete");
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({
      cascade: { members: 1, grants: 1 },
    });
  });

  it("refuses group curation to a PROJECT admin", async () => {
    /*
     * THE ESCALATION THIS PREVENTS, spelled out because the rule looks
     * needlessly strict until you write it down:
     *
     * `platform` holds admin on `payments` AND on `billing`. The admin of
     * `billing` may grant to `platform` -- their scope, their decision. If they
     * could also edit its membership they would add themselves, and walk out
     * with admin on `payments`: a project they cannot see, granted to them by
     * nobody.
     */
    const ctx = await asProjectAdmin();
    const groupId = await seedGroup(db, "platform");

    await rejectsWith(async () => createGroup(ctx, { slug: "mine", name: "Mine" }), "FORBIDDEN");
    await rejectsWith(async () => updateGroup(ctx, groupId, { name: "Theirs" }), "FORBIDDEN");
    await rejectsWith(async () => deleteGroup(ctx, groupId), "FORBIDDEN");
    await rejectsWith(
      async () => addGroupMember(ctx, groupId, { identity_id: bobId }),
      "FORBIDDEN",
    );
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("membership", () => {
  it("adds and removes, and the role appears and disappears with it", async () => {
    const groupId = await seedGroup(db, "platform");
    await seedGroupGrant(db, { groupId, role: "writer", scopeType: "project", projectId });

    // Before: nothing. Membership is the only thing that changes below.
    expect(
      await can(requestContext(db, userActor(BOB)), { type: "project", projectId }, "reader"),
    ).toBe(false);

    await addGroupMember(asAdmin(), groupId, { identity_id: bobId });

    expect(
      await can(requestContext(db, userActor(BOB)), { type: "project", projectId }, "writer"),
    ).toBe(true);

    await removeGroupMember(asAdmin(), groupId, bobId);

    expect(
      await can(requestContext(db, userActor(BOB)), { type: "project", projectId }, "reader"),
    ).toBe(false);
  });

  it("refuses a duplicate membership rather than silently doing nothing", async () => {
    const groupId = await seedGroup(db, "platform");
    await addGroupMember(asAdmin(), groupId, { identity_id: bobId });

    await rejectsWith(
      async () => addGroupMember(asAdmin(), groupId, { identity_id: bobId }),
      "CONFLICT",
    );
  });

  it("404s on removing somebody who is not in the group", async () => {
    const groupId = await seedGroup(db, "platform");
    await rejectsWith(async () => removeGroupMember(asAdmin(), groupId, bobId), "NOT_FOUND");
  });

  it("shows a disabled member as disabled, because they hold nothing", async () => {
    const disabledId = await seedIdentity(db, {
      kind: "user",
      subject: "fired@example.com",
      disabled: true,
    });
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, disabledId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const members = await listGroupMembers(asAdmin(), groupId);

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ subject: "fired@example.com", disabled: true });

    // And the flag is not decorative: the kill switch outranks the group's grant.
    expect(
      await can(requestContext(db, userActor("fired@example.com")), { type: "global" }, "reader"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grants held by a group
// ---------------------------------------------------------------------------

describe("grants on a group", () => {
  it("lets a PROJECT admin grant within their project, and not outside it", async () => {
    await asProjectAdmin();
    const groupId = await seedGroup(db, "platform");

    // A FRESH context per call, because the authorization snapshot is cached
    // against the context object -- reusing one would be one request, not two.
    const granted = await createGroupGrant(requestContext(db, userActor(PROJECT_ADMIN)), groupId, {
      scope_type: "project",
      project: "acme",
      role: "writer",
      expires_at: null,
    });

    expect(granted).toMatchObject({ role: "writer", scopeType: "project", projectSlug: "acme" });

    // Global is above them. Downward inheritance does not run backwards just
    // because the holder is a group.
    await rejectsWith(
      async () =>
        createGroupGrant(requestContext(db, userActor(PROJECT_ADMIN)), groupId, {
          scope_type: "global",
          role: "reader",
          expires_at: null,
        }),
      "FORBIDDEN",
    );
  });

  it("refuses a duplicate at the same scope, so a resubmitted form cannot widen access", async () => {
    const groupId = await seedGroup(db, "platform");

    await createGroupGrant(asAdmin(), groupId, {
      scope_type: "project",
      project: "acme",
      role: "reader",
      expires_at: null,
    });

    await rejectsWith(
      async () =>
        createGroupGrant(asAdmin(), groupId, {
          scope_type: "project",
          project: "acme",
          role: "admin",
          expires_at: null,
        }),
      "CONFLICT",
    );
  });

  it("allows the same group one grant per scope type, which the partial indexes are for", async () => {
    const groupId = await seedGroup(db, "platform");

    for (const input of [
      { scope_type: "global" as const, role: "reader" as const, expires_at: null },
      {
        scope_type: "project" as const,
        project: "acme",
        role: "writer" as const,
        expires_at: null,
      },
      {
        scope_type: "environment" as const,
        project: "acme",
        environment: "prod",
        role: "admin" as const,
        expires_at: null,
      },
    ]) {
      await createGroupGrant(asAdmin(), groupId, input);
    }

    expect(await listGroupGrants(asAdmin(), groupId)).toHaveLength(3);
  });

  it("refuses TWO global grants for one group -- the NULL-distinctness trap", async () => {
    /*
     * The reason `group_grants_global_uniq` is a PARTIAL index on `group_id`
     * rather than a composite over (group_id, scope_type, project_id,
     * environment_id): in the composite form both rows are
     * (id, 'global', NULL, NULL), SQLite treats NULLs as DISTINCT, and the
     * constraint silently permits unlimited duplicates -- so revoking "the"
     * global grant would leave the others in place.
     */
    const groupId = await seedGroup(db, "platform");

    await seedGroupGrant(db, { groupId, role: "reader", scopeType: "global" });

    const thrown = await seedGroupGrant(db, {
      groupId,
      role: "admin",
      scopeType: "global",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // The constraint fires in the DRIVER, so the message is on the cause rather
    // than on the wrapper drizzle rethrows. Asserting against the cause is what
    // makes this a test of the index rather than of an error string.
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).cause ?? thrown)).toMatch(/UNIQUE constraint failed/i);
  });

  it("revokes only through the owning group", async () => {
    const mine = await seedGroup(db, "mine");
    const yours = await seedGroup(db, "yours");
    const grantId = await seedGroupGrant(db, {
      groupId: yours,
      role: "admin",
      scopeType: "project",
      projectId,
    });

    // Right grant, wrong group: 404 rather than a revocation of somebody else's
    // access because a client paired the wrong two ids.
    await rejectsWith(async () => revokeGroupGrant(asAdmin(), mine, grantId), "NOT_FOUND");

    await revokeGroupGrant(asAdmin(), yours, grantId);
    expect(await listGroupGrants(asAdmin(), yours)).toEqual([]);
  });

  it("hides grants a scoped admin does not administer", async () => {
    const other = await seedProject(db, "other");
    const groupId = await seedGroup(db, "platform");

    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });
    await seedGroupGrant(db, {
      groupId,
      role: "admin",
      scopeType: "project",
      projectId: other,
    });

    const ctx = await asProjectAdmin();
    const visible = await listGroupGrants(ctx, groupId);

    expect(visible.map((row) => row.projectSlug)).toEqual(["acme"]);
    // The global admin sees both.
    expect(await listGroupGrants(asAdmin(), groupId)).toHaveLength(2);
  });

  it("excludes expired grants from the list and from the count", async () => {
    const groupId = await seedGroup(db, "platform");
    await seedGroupGrant(db, {
      groupId,
      role: "admin",
      scopeType: "project",
      projectId,
      expiresAt: NOW - 1,
    });

    expect(await listGroupGrants(asAdmin(), groupId)).toEqual([]);
    expect((await getGroup(asAdmin(), groupId)).grantCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The lockout guard
// ---------------------------------------------------------------------------

describe("the last administrator", () => {
  /**
   * FOUR WAYS TO STOP BEING A GLOBAL ADMIN, and the guard has to know all of
   * them. Three are new with groups, and every one removes access through a
   * route whose name does not contain the word "grant" -- which is exactly why
   * the count is taken as of AFTER the pending deletion rather than by
   * enumerating "the dangerous operations" somewhere.
   *
   * There is no recovery credential in this design. The only way back from
   * "removed the last administrator" is editing `BOOTSTRAP_ADMINS` and
   * redeploying, so an irreversible lockout is refused rather than confirmed.
   */
  let groupId: string;
  let grantId: string;

  beforeEach(async () => {
    // The group becomes the installation's ONLY path to global admin: the
    // direct grant the fixture seeds is removed, and the administrator reaches
    // their own role through the group from here on.
    await db.delete(grants);

    groupId = await seedGroup(db, "owners");
    await seedGroupMember(db, groupId, adminId);
    grantId = await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });
  });

  it("counts a group-derived global admin, so the install is not reported adminless", async () => {
    // Without this, an installation whose only administrator holds the role
    // through a group answers 503 NO_ADMINS_CONFIGURED to every request --
    // including the ones that would let somebody fix it.
    await expect(assertAdminsConfigured(asAdmin())).resolves.toBeUndefined();
    expect(await can(asAdmin(), { type: "global" }, "admin")).toBe(true);
  });

  it("refuses to delete the group that holds it", async () => {
    await rejectsWith(async () => deleteGroup(asAdmin(), groupId), "LAST_ADMIN");
  });

  it("refuses to remove its last member", async () => {
    await rejectsWith(async () => removeGroupMember(asAdmin(), groupId, adminId), "LAST_ADMIN");
  });

  it("refuses to revoke the group's grant", async () => {
    await rejectsWith(async () => revokeGroupGrant(asAdmin(), groupId, grantId), "LAST_ADMIN");
  });

  it("allows all three once ANOTHER identity holds global admin directly", async () => {
    const spare = await seedIdentity(db, { kind: "user", subject: "spare@example.com" });
    await seedGrant(db, { identityId: spare, role: "admin", scopeType: "global" });

    await revokeGroupGrant(asAdmin(), groupId, grantId);
  });

  it("allows them when BOOTSTRAP_ADMINS provides a way back in", async () => {
    // The recovery path exists, so the operation is permitted rather than
    // refused: the guard is about irreversibility, not about admin arithmetic.
    const ctx = requestContext(db, userActor(ADMIN), {
      config: testConfig({ bootstrapAdmins: ["rescue@example.com"] }),
    });

    await deleteGroup(ctx, groupId);
  });

  it("still allows revoking a DIRECT grant while the group provides one", async () => {
    const spare = await seedIdentity(db, { kind: "user", subject: "spare@example.com" });
    const spareGrant = await seedGrant(db, {
      identityId: spare,
      role: "admin",
      scopeType: "global",
    });

    await revokeGrant(asAdmin(), spareGrant);

    // And now the group is the last one again.
    await rejectsWith(async () => deleteGroup(asAdmin(), groupId), "LAST_ADMIN");
  });
});

// ---------------------------------------------------------------------------
// A bulk write does not become N queries
// ---------------------------------------------------------------------------

describe("a bulk write by a group-derived writer", () => {
  it("is still ONE batch and does not re-resolve authorization per key", async () => {
    /*
     * The property the whole feature had to preserve. A 250-key write by
     * somebody whose role comes from a group must cost exactly what the same
     * write costs somebody with a direct grant -- one authorization query, one
     * `batch()`. Counted through the binding, because the data would be
     * identical either way.
     */
    const groupId = await seedGroup(db, "deployers");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, { groupId, role: "writer", scopeType: "environment", environmentId });

    const set: Record<string, string> = {};
    for (let i = 0; i < 250; i += 1) set[`K${String(i)}`] = `v${String(i)}`;

    const counter = countingBinding();
    const ctx = secretsContext(createDatabase(counter.binding), userActor(BOB), keyring);

    counter.reset();

    await writeSecrets(ctx, "acme", "prod", { mode: "replace", set });

    expect(counter.batches()).toBe(1);

    // The same shape a direct-grant writer produces, measured rather than
    // hard-coded so an unrelated change to the write path does not read as a
    // groups regression.
    const directId = await seedIdentity(db, { kind: "user", subject: "direct@example.com" });
    await seedGrant(db, {
      identityId: directId,
      role: "writer",
      scopeType: "environment",
      environmentId,
    });

    const directCounter = countingBinding();
    const directCtx = secretsContext(
      createDatabase(directCounter.binding),
      userActor("direct@example.com"),
      keyring,
    );

    directCounter.reset();
    await writeSecrets(directCtx, "acme", "prod", { mode: "replace", set });

    expect(counter.statements()).toBe(directCounter.statements());
    expect(counter.batches()).toBe(directCounter.batches());
  });
});

// ---------------------------------------------------------------------------
// "Why does Bob have production?"
// ---------------------------------------------------------------------------

describe("the effective-permissions view", () => {
  it("names the GROUP that conferred the role, not just the role", async () => {
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });

    const view = await explainIdentityPermissions(asAdmin(), bobId);

    expect(view.identity.subject).toBe(BOB);
    expect(view.groups).toEqual([{ id: groupId, slug: "platform", name: "platform" }]);

    const entry = view.scopes.find((s) => s.scopeType === "project");
    expect(entry).toMatchObject({ projectSlug: "acme", role: "admin" });

    const decisive = entry?.sources.find((source) => source.decisive);
    expect(decisive).toMatchObject({
      via: "group",
      role: "admin",
      scopeType: "project",
      group: { slug: "platform" },
    });
    // The id of the row to delete, which is what "what do I remove" means.
    expect(decisive?.grantId).toBeTruthy();
  });

  it("explains an ENVIRONMENT through the project grant that covers it", async () => {
    // The answer to "why does Bob have production" is "the platform group has
    // admin on the project". An entry with a role and no covering source would
    // be the useless answer this view exists to avoid.
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });
    await seedGrant(db, {
      identityId: bobId,
      role: "reader",
      scopeType: "environment",
      environmentId,
    });

    const view = await explainIdentityPermissions(asAdmin(), bobId);
    const entry = view.scopes.find((s) => s.scopeType === "environment");

    expect(entry).toMatchObject({
      projectSlug: "acme",
      environmentSlug: "prod",
      role: "admin",
    });

    // Both sources, strongest first, and only the winner marked decisive.
    expect(entry?.sources.map((source) => [source.via, source.role, source.decisive])).toEqual([
      ["group", "admin", true],
      ["direct", "reader", false],
    ]);
  });

  it("returns NO scopes for an identity nobody granted anything", async () => {
    // There is no implicit role, and the explain view must not invent one by
    // listing an entry with a null role for every project in the installation.
    const view = await explainIdentityPermissions(asAdmin(), bobId);

    expect(view.scopes).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(view.bootstrap).toBe(false);
  });

  it("lists a group that holds no grants, because that is also an answer", async () => {
    const groupId = await seedGroup(db, "contractors");
    await seedGroupMember(db, groupId, bobId);

    const view = await explainIdentityPermissions(asAdmin(), bobId);

    expect(view.groups).toEqual([{ id: groupId, slug: "contractors", name: "contractors" }]);
    expect(view.scopes).toEqual([]);
  });

  it("reports role NULL for a disabled identity, while still showing what it would get back", async () => {
    const disabledId = await seedIdentity(db, {
      kind: "user",
      subject: "fired@example.com",
      disabled: true,
    });
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, disabledId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const view = await explainIdentityPermissions(asAdmin(), disabledId);

    expect(view.identity.disabled).toBe(true);
    expect(view.scopes).toHaveLength(1);
    expect(view.scopes[0]?.role).toBeNull();
    // The sources are still listed -- an operator deciding whether it is safe to
    // re-enable needs to see what re-enabling restores -- and none is decisive.
    expect(view.scopes[0]?.sources).toHaveLength(1);
    expect(view.scopes[0]?.sources[0]).toMatchObject({ via: "group", decisive: false });
  });

  it("names BOOTSTRAP_ADMINS as a source, which is the one with no row to find", async () => {
    const ctx = requestContext(db, userActor(ADMIN), {
      config: testConfig({ bootstrapAdmins: [BOB] }),
    });

    const view = await explainIdentityPermissions(ctx, bobId);

    expect(view.bootstrap).toBe(true);
    expect(view.scopes[0]).toMatchObject({ scopeType: "global", role: "admin" });
    expect(view.scopes[0]?.sources[0]).toMatchObject({
      via: "bootstrap",
      grantId: null,
      role: "admin",
    });
  });

  it("omits an expired grant entirely", async () => {
    const groupId = await seedGroup(db, "seasonal");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, {
      groupId,
      role: "admin",
      scopeType: "project",
      projectId,
      expiresAt: NOW - 1,
    });

    expect((await explainIdentityPermissions(asAdmin(), bobId)).scopes).toEqual([]);
  });

  it("narrows to what the CALLER administers", async () => {
    const other = await seedProject(db, "other");
    const groupId = await seedGroup(db, "platform");
    await seedGroupMember(db, groupId, bobId);
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId: other });
    await seedGrant(db, { identityId: bobId, role: "reader", scopeType: "global" });

    const view = await explainIdentityPermissions(await asProjectAdmin(), bobId);

    // Their own project only. Not `other`, and not the global entry -- "Bob is a
    // global reader" is a fact about every project at once.
    expect(view.scopes.map((s) => [s.scopeType, s.projectSlug])).toEqual([["project", "acme"]]);

    // But the sources INSIDE that entry are not narrowed: the global grant is
    // the honest explanation of part of Bob's access here, and hiding it would
    // leave a role with no explanation.
    expect(view.scopes[0]?.sources.map((source) => source.scopeType).sort()).toEqual([
      "global",
      "project",
    ]);
  });

  it("is refused to a non-admin", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: "reader@example.com" });
    await seedGrant(db, { identityId, role: "reader", scopeType: "global" });

    await rejectsWith(
      async () =>
        explainIdentityPermissions(requestContext(db, userActor("reader@example.com")), bobId),
      "FORBIDDEN",
    );
  });

  it("404s for an identity that does not exist", async () => {
    await rejectsWith(
      async () => explainIdentityPermissions(asAdmin(), "00000000-0000-7000-8000-000000000000"),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listGroups", () => {
  it("counts members and live grants separately, because both zeros mean different things", async () => {
    const roster = await seedGroup(db, "roster");
    await seedGroupMember(db, roster, bobId);

    const holder = await seedGroup(db, "holder");
    await seedGroupGrant(db, { groupId: holder, role: "admin", scopeType: "project", projectId });

    const listed = await listGroups(asAdmin());

    expect(listed.map((g) => [g.slug, g.memberCount, g.grantCount])).toEqual([
      // A group with grants and no members grants nobody anything; a group with
      // members and no grants confers nothing on them. Both are normal.
      ["holder", 0, 1],
      ["roster", 1, 0],
    ]);
  });

  it("is visible to a project admin, who has to pick a group to grant to", async () => {
    await seedGroup(db, "platform");
    expect(await listGroups(await asProjectAdmin())).toHaveLength(1);
  });

  it("is refused to a non-admin", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: "reader@example.com" });
    await seedGrant(db, { identityId, role: "reader", scopeType: "global" });

    await rejectsWith(
      async () => listGroups(requestContext(db, userActor("reader@example.com"))),
      "FORBIDDEN",
    );
  });
});
