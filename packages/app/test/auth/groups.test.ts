import { beforeEach, describe, expect, it } from "vitest";
import type { Role } from "@prick/shared";

import { assertCan, can, resolveEffectiveRole } from "../../src/lib/server/auth/authorize.js";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import {
  NOW,
  countingD1,
  freshDatabase,
  requestContext,
  seedEnvironment,
  seedGrant,
  seedGroup,
  seedGroupGrant,
  seedGroupMember,
  seedIdentity,
  seedProject,
  testConfig,
  userActor,
} from "./fixtures.js";
import { rejectsWith } from "./rejects.js";

/**
 * GROUPS, AT THE LAYER THAT DECIDES.
 *
 * `test/http/permissions.test.ts` proves the group-derived actors behave the
 * same as direct ones through the whole stack. This file is the narrower claim
 * underneath that: the resolver merges two sources into one role, it merges them
 * WITHOUT a second query, and none of it invents a role nobody granted.
 */

const SUBJECT = "operator@example.com";
const OTHER = "bystander@example.com";

let db: Database;
let projectId: string;
let otherProjectId: string;
let environmentId: string;

beforeEach(async () => {
  db = await freshDatabase();
  projectId = await seedProject(db, "acme");
  otherProjectId = await seedProject(db, "other");
  environmentId = await seedEnvironment(db, projectId, "prod");
});

/** An identity in one group. Returns both ids. */
async function member(
  subject: string,
  groupSlug: string,
  options: { disabled?: boolean } = {},
): Promise<{ identityId: string; groupId: string }> {
  const identityId = await seedIdentity(db, {
    kind: "user",
    subject,
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  });
  const groupId = await seedGroup(db, groupSlug);
  await seedGroupMember(db, groupId, identityId);
  return { identityId, groupId };
}

const ROLES: Role[] = ["reader", "writer", "admin"];

// ---------------------------------------------------------------------------
// A group grant is a grant
// ---------------------------------------------------------------------------

describe("a grant held by a group", () => {
  for (const held of ROLES) {
    it(`confers ${held} on its members, and inherits downwards exactly like a direct grant`, async () => {
      const { groupId } = await member(SUBJECT, "platform");
      await seedGroupGrant(db, { groupId, role: held, scopeType: "project", projectId });

      const ctx = requestContext(db, userActor(SUBJECT));

      expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBe(held);
      expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe(held);

      // Never upwards, never sideways. The group changes WHO holds the grant,
      // not what a grant at that scope reaches.
      expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
      expect(
        await resolveEffectiveRole(ctx, { type: "project", projectId: otherProjectId }),
      ).toBeNull();
    });
  }

  it("reaches only the identities that are actually in the group", async () => {
    const { groupId } = await member(SUBJECT, "platform");
    await seedIdentity(db, { kind: "user", subject: OTHER });
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), { type: "global" }),
    ).toBe("admin");
    expect(
      await resolveEffectiveRole(requestContext(db, userActor(OTHER)), { type: "global" }),
    ).toBeNull();
  });

  it("stacks with the identity's own grants, taking the MAX", async () => {
    const { identityId, groupId } = await member(SUBJECT, "platform");

    // Direct reader on the project; the group holds admin on one environment.
    await seedGrant(db, { identityId, role: "reader", scopeType: "project", projectId });
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "environment", environmentId });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBe("reader");
    // Max over both sources at the environment: the group's admin wins.
    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe("admin");
  });

  it("never lets a weaker group grant reduce a stronger direct one", async () => {
    // PURELY ADDITIVE. This is the property that makes the model readable: a
    // group can raise a role and can never lower one, so there is no rule
    // ordering to reason about and no silent override to discover during an
    // incident.
    const { identityId, groupId } = await member(SUBJECT, "platform");

    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });
    await seedGroupGrant(db, { groupId, role: "reader", scopeType: "environment", environmentId });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe("admin");
  });

  it("takes the MAX across SEVERAL groups", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });

    const readers = await seedGroup(db, "readers");
    const deployers = await seedGroup(db, "deployers");
    await seedGroupMember(db, readers, identityId);
    await seedGroupMember(db, deployers, identityId);

    await seedGroupGrant(db, { groupId: readers, role: "reader", scopeType: "project", projectId });
    await seedGroupGrant(db, {
      groupId: deployers,
      role: "writer",
      scopeType: "project",
      projectId,
    });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), {
        type: "project",
        projectId,
      }),
    ).toBe("writer");
  });

  it("is ignored once it has expired", async () => {
    const { groupId } = await member(SUBJECT, "seasonal");
    await seedGroupGrant(db, {
      groupId,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW - 1,
    });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), { type: "global" }),
    ).toBeNull();

    // And is honoured right up until it lapses -- the same absolute comparison
    // against the request's injected clock that a direct grant gets.
    const { groupId: live } = await member(OTHER, "current");
    await seedGroupGrant(db, {
      groupId: live,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW + 1,
    });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(OTHER)), { type: "global" }),
    ).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// Still no implicit role
// ---------------------------------------------------------------------------

describe("groups do not create an implicit role", () => {
  /**
   * THE POINT OF THIS WHOLE DESCRIBE BLOCK.
   *
   * The system's central property is that a role exists only because somebody
   * granted it. Adding a second way to acquire one is exactly the change that
   * could quietly introduce a third way -- "belongs to a group" becoming a role
   * on its own, or an empty group resolving to something other than nothing.
   */
  it("REJECTS a member of a group that holds no grants", async () => {
    await member(SUBJECT, "everyone");

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBeNull();
    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBeNull();

    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });

  it("REJECTS a member of a group whose only grant has expired", async () => {
    const { groupId } = await member(SUBJECT, "lapsed");
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global", expiresAt: NOW - 1 });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });

  it("REJECTS an identity in NO groups when other groups hold grants", async () => {
    // A group's grant is not a grant to the world. Obvious, and exactly the sort
    // of obvious thing a join condition can get wrong once.
    const privileged = await seedGroup(db, "platform");
    await seedGroupGrant(db, { groupId: privileged, role: "admin", scopeType: "global" });
    await seedIdentity(db, { kind: "user", subject: SUBJECT });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), { type: "global" }),
    ).toBeNull();
  });

  it("REJECTS a group grant that names a project the member has no other path to", async () => {
    const { groupId } = await member(SUBJECT, "platform");
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), {
        type: "project",
        projectId: otherProjectId,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The kill switch still outranks everything
// ---------------------------------------------------------------------------

describe("a disabled identity in a privileged group", () => {
  it("resolves to NOTHING, even with global admin held by the group", async () => {
    const { groupId } = await member(SUBJECT, "platform", { disabled: true });
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBeNull();
    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });

  it("resolves to NOTHING even when the var names it as well", async () => {
    const { groupId } = await member(SUBJECT, "platform", { disabled: true });
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(SUBJECT), {
      config: testConfig({ bootstrapAdmins: [SUBJECT] }),
    });

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The query count did not grow
// ---------------------------------------------------------------------------

describe("resolution stays ONE query", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS TO PREVENT.
   *
   * The obvious way to add groups is a second SELECT: fetch the memberships,
   * then fetch their grants. That is two more round-trips on EVERY authenticated
   * request in the system -- a permanent tax on every read and every write, to
   * serve a feature most requests do not use. It also passes every functional
   * test in this repository, because the answers are all correct.
   *
   * So the count is asserted, through a binding proxy, the way the atomicity
   * suite asserts that a bulk write is one `batch()`.
   */
  it("performs ONE statement for a group-derived role, the same as for a direct one", async () => {
    const { groupId } = await member(SUBJECT, "platform");
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    expect(await can(ctx, { type: "global" }, "admin")).toBe(true);

    // ONE. The direct half and the group half are two branches of one UNION ALL,
    // not two queries.
    expect(counting.statements()).toBe(1);
  });

  it("performs the SAME number of statements with groups as without", async () => {
    // Measured rather than asserted as a constant, so this stays honest if the
    // baseline itself changes for an unrelated reason.
    const directIdentity = await seedIdentity(db, { kind: "user", subject: "direct@example.com" });
    await seedGrant(db, {
      identityId: directIdentity,
      role: "admin",
      scopeType: "project",
      projectId,
    });

    const directCounter = countingD1();
    const directCtx = requestContext(
      createDatabase(directCounter.binding),
      userActor("direct@example.com"),
    );
    directCounter.reset();
    expect(await can(directCtx, { type: "environment", environmentId }, "writer")).toBe(true);
    const baseline = directCounter.statements();

    const { groupId } = await member(SUBJECT, "platform");
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "project", projectId });

    const groupCounter = countingD1();
    const groupCtx = requestContext(createDatabase(groupCounter.binding), userActor(SUBJECT));
    groupCounter.reset();
    expect(await can(groupCtx, { type: "environment", environmentId }, "writer")).toBe(true);

    expect(groupCounter.statements()).toBe(baseline);
  });

  it("performs ONE authorization query for 200 checks, through several groups", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });

    for (const slug of ["one", "two", "three", "four"]) {
      const groupId = await seedGroup(db, slug);
      await seedGroupMember(db, groupId, identityId);
      await seedGroupGrant(db, { groupId, role: "reader", scopeType: "project", projectId });
      await seedGroupGrant(db, {
        groupId,
        role: "writer",
        scopeType: "environment",
        environmentId,
      });
    }

    await seedGrant(db, { identityId, role: "reader", scopeType: "global" });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    for (let i = 0; i < 200; i += 1) {
      expect(await can(ctx, { type: "environment", environmentId }, "writer")).toBe(true);
    }

    // One for the identity + grants + group grants union, one for the
    // environment's project id. Not two hundred, and not four hundred.
    expect(counting.statements()).toBe(2);
  });

  it("shares one in-flight query between concurrent checks", async () => {
    const { groupId } = await member(SUBJECT, "platform");
    await seedGroupGrant(db, { groupId, role: "admin", scopeType: "global" });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    await Promise.all(
      Array.from({ length: 20 }, async () => can(ctx, { type: "global" }, "reader")),
    );

    expect(counting.statements()).toBe(1);
  });
});
