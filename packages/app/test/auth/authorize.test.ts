import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { assertCan, can, resolveEffectiveRole } from "../../src/lib/server/auth/authorize.js";
import type { Role } from "@prick/shared";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import { auditLog, grants } from "../../src/lib/server/db/schema.js";
import {
  NOW,
  countingD1,
  freshDatabase,
  requestContext,
  seedEnvironment,
  seedGrant,
  seedIdentity,
  seedProject,
  serviceActor,
  testConfig,
  userActor,
} from "./fixtures.js";
import { rejectsWith } from "./rejects.js";

const SUBJECT = "operator@example.com";
const SERVICE = "e367826f93b8d71185e03fe518aff3b4.access";

let db: Database;
let projectId: string;
let otherProjectId: string;
let environmentId: string;
let otherEnvironmentId: string;

beforeEach(async () => {
  db = await freshDatabase();
  projectId = await seedProject(db, "acme");
  otherProjectId = await seedProject(db, "other");
  environmentId = await seedEnvironment(db, projectId, "prod");
  otherEnvironmentId = await seedEnvironment(db, otherProjectId, "prod");
});

const ROLES: Role[] = ["reader", "writer", "admin"];

// ---------------------------------------------------------------------------
// The permission matrix
// ---------------------------------------------------------------------------

describe("permission matrix -- global grants", () => {
  for (const held of ROLES) {
    for (const required of ROLES) {
      const allowed = ROLES.indexOf(held) >= ROLES.indexOf(required);

      it(`a global ${held} ${allowed ? "may" : "may NOT"} act as ${required} anywhere`, async () => {
        const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
        await seedGrant(db, { identityId, role: held, scopeType: "global" });

        const ctx = requestContext(db, userActor(SUBJECT));

        expect(await can(ctx, { type: "global" }, required)).toBe(allowed);
        expect(await can(ctx, { type: "project", projectId }, required)).toBe(allowed);
        expect(await can(ctx, { type: "environment", environmentId }, required)).toBe(allowed);
      });
    }
  }
});

describe("permission matrix -- project grants", () => {
  for (const held of ROLES) {
    it(`a project ${held} inherits down to environments but not up to global`, async () => {
      const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
      await seedGrant(db, { identityId, role: held, scopeType: "project", projectId });

      const ctx = requestContext(db, userActor(SUBJECT));

      expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBe(held);
      expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe(held);

      // Never upwards, and never sideways into another project.
      expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
      expect(
        await resolveEffectiveRole(ctx, { type: "project", projectId: otherProjectId }),
      ).toBeNull();
      expect(
        await resolveEffectiveRole(ctx, {
          type: "environment",
          environmentId: otherEnvironmentId,
        }),
      ).toBeNull();
    });
  }
});

describe("permission matrix -- environment grants", () => {
  for (const held of ROLES) {
    it(`an environment ${held} reaches that environment and nothing else`, async () => {
      const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
      await seedGrant(db, { identityId, role: held, scopeType: "environment", environmentId });

      const ctx = requestContext(db, userActor(SUBJECT));

      expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe(held);
      expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBeNull();
      expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    });
  }
});

describe("effective role is the MAX over matching grants", () => {
  it("takes the strongest of overlapping global, project and environment grants", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "reader", scopeType: "global" });
    await seedGrant(db, { identityId, role: "admin", scopeType: "project", projectId });
    await seedGrant(db, { identityId, role: "writer", scopeType: "environment", environmentId });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBe("reader");
    expect(await resolveEffectiveRole(ctx, { type: "project", projectId })).toBe("admin");
    // Project admin outranks the weaker environment grant.
    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe("admin");
  });

  it("never lets a weaker grant reduce a stronger one", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });
    await seedGrant(db, { identityId, role: "reader", scopeType: "environment", environmentId });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// No god mode
// ---------------------------------------------------------------------------

describe("no god mode", () => {
  it("REJECTS a user identity that holds no grants", async () => {
    await seedIdentity(db, { kind: "user", subject: SUBJECT });
    const ctx = requestContext(db, userActor(SUBJECT));

    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });

  it("REJECTS a subject with no identity row at all", async () => {
    const ctx = requestContext(db, userActor("stranger@example.com"));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    await rejectsWith(
      async () => assertCan(ctx, { type: "project", projectId }, "reader"),
      "FORBIDDEN",
    );
  });

  it("treats a user and a service token identically at the same grant", async () => {
    const human = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    const machine = await seedIdentity(db, { kind: "service", subject: SERVICE });
    await seedGrant(db, { identityId: human, role: "writer", scopeType: "global" });
    await seedGrant(db, { identityId: machine, role: "writer", scopeType: "global" });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), { type: "global" }),
    ).toBe("writer");
    expect(
      await resolveEffectiveRole(requestContext(db, serviceActor(SERVICE)), { type: "global" }),
    ).toBe("writer");
  });

  it("does not let a user identity outrank its grant", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "reader", scopeType: "global" });

    const ctx = requestContext(db, userActor(SUBJECT));
    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "writer"), "FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Expiry and the kill switch
// ---------------------------------------------------------------------------

describe("expired grants", () => {
  it("ignores a grant whose expiry has passed", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, {
      identityId,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW - 1,
    });

    const ctx = requestContext(db, userActor(SUBJECT));
    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
  });

  it("honours a grant that expires in the future", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global", expiresAt: NOW + 1 });

    const ctx = requestContext(db, userActor(SUBJECT));
    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBe("admin");
  });

  it("compares expiry against the REQUEST clock, not the wall clock", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, {
      identityId,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW + 60_000,
    });

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT)), { type: "global" }),
    ).toBe("admin");

    expect(
      await resolveEffectiveRole(requestContext(db, userActor(SUBJECT), { now: NOW + 60_001 }), {
        type: "global",
      }),
    ).toBeNull();
  });
});

describe("disabled identities", () => {
  it("REJECTS a disabled identity that holds a global admin grant", async () => {
    const identityId = await seedIdentity(db, {
      kind: "user",
      subject: SUBJECT,
      disabled: true,
    });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(SUBJECT));

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });

  it("REJECTS a disabled identity even when it is named in BOOTSTRAP_ADMINS", async () => {
    await seedIdentity(db, { kind: "user", subject: SUBJECT, disabled: true });

    const ctx = requestContext(db, userActor(SUBJECT), {
      config: testConfig({ bootstrapAdmins: [SUBJECT] }),
    });

    // The kill switch outranks the var. An operator who disables an identity
    // must get a guarantee that it stopped working.
    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Bootstrap admins go through the same code path
// ---------------------------------------------------------------------------

describe("bootstrap admins", () => {
  it("grants global admin from the var, and reports it as implicit", async () => {
    const ctx = requestContext(db, userActor(SUBJECT), {
      config: testConfig({ bootstrapAdmins: [SUBJECT] }),
    });

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBe("admin");
    expect(await resolveEffectiveRole(ctx, { type: "environment", environmentId })).toBe("admin");
  });

  it("does not treat an unlisted subject as an admin", async () => {
    const ctx = requestContext(db, userActor("someone@example.com"), {
      config: testConfig({ bootstrapAdmins: [SUBJECT] }),
    });

    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Denials are audited
// ---------------------------------------------------------------------------

describe("denials", () => {
  it("writes an audit row with outcome 'denied' BEFORE throwing", async () => {
    const ctx = requestContext(db, serviceActor(SERVICE));

    await rejectsWith(
      async () => assertCan(ctx, { type: "environment", environmentId }, "writer"),
      "FORBIDDEN",
    );

    const rows = await db.select().from(auditLog).where(eq(auditLog.outcome, "denied"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "service",
      actorSubject: SERVICE,
      outcome: "denied",
      environmentId,
      requestId: ctx.requestId,
    });
  });

  /**
   * This is what makes a service token discoverable at all. `common_name` is an
   * opaque hex string, so the only way an operator learns that "staging deploy"
   * exists is that its denial was recorded under a subject with no identity row.
   */
  it("audits a denial for a subject that has no identity row", async () => {
    const ctx = requestContext(db, serviceActor("never-seen-before.access"));

    await rejectsWith(async () => assertCan(ctx, { type: "global" }, "reader"), "FORBIDDEN");

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorSubject).toBe("never-seen-before.access");
    expect(rows[0]?.identityId).toBeNull();
  });

  it("does not audit a permitted action as denied", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    await assertCan(requestContext(db, userActor(SUBJECT)), { type: "global" }, "admin");

    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// One resolution per request
// ---------------------------------------------------------------------------

describe("resolution is cached on the request", () => {
  it("performs ONE authorization query for 200 checks", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    for (let i = 0; i < 200; i += 1) {
      expect(await can(ctx, { type: "environment", environmentId }, "writer")).toBe(true);
    }

    // One for the identity + grants join, one for the environment's project id.
    // Not two hundred, and not four hundred.
    expect(counting.statements()).toBe(2);
  });

  it("shares one in-flight query between concurrent checks", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    await Promise.all(
      Array.from({ length: 20 }, async () => can(ctx, { type: "global" }, "reader")),
    );

    expect(counting.statements()).toBe(1);
  });

  it("does NOT share a snapshot between two requests", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    const grantId = await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const first = requestContext(db, userActor(SUBJECT));
    expect(await can(first, { type: "global" }, "admin")).toBe(true);

    await db.delete(grants).where(eq(grants.id, grantId));

    // The first context keeps its snapshot -- that is the point of caching --
    // but a NEW request must see the revocation immediately.
    expect(await can(first, { type: "global" }, "admin")).toBe(true);
    expect(await can(requestContext(db, userActor(SUBJECT)), { type: "global" }, "admin")).toBe(
      false,
    );
  });

  it("accepts a caller-supplied projectId and skips the lookup", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await seedGrant(db, { identityId, role: "writer", scopeType: "project", projectId });

    const counting = countingD1();
    const ctx = requestContext(createDatabase(counting.binding), userActor(SUBJECT));

    counting.reset();

    expect(await can(ctx, { type: "environment", environmentId, projectId }, "writer")).toBe(true);
    expect(counting.statements()).toBe(1);
  });
});
