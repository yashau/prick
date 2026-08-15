import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveAuthorization, resolveEffectiveRole } from "../../src/lib/server/auth/authorize.js";
import {
  assertAdminsConfigured,
  assertNotLastAdmin,
  hasNoAdmins,
  isBootstrapAdmin,
  parseBootstrapAdmins,
  selfHealBootstrapGrant,
  upsertIdentity,
} from "../../src/lib/server/auth/bootstrap.js";
import type { Database } from "../../src/lib/server/db/client.js";
import { auditLog, grants, identities } from "../../src/lib/server/db/schema.js";
import {
  NOW,
  freshDatabase,
  requestContext,
  seedGrant,
  seedIdentity,
  testConfig,
  userActor,
} from "./fixtures.js";
import { rejectsWith } from "./rejects.js";

const ADMIN = "admin@example.com";
const OTHER = "other@example.com";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

describe("parseBootstrapAdmins", () => {
  it("splits, trims, lower-cases and de-duplicates", () => {
    expect(parseBootstrapAdmins(" Ops@Example.com , ops@example.com ,,QA@Example.com ")).toEqual([
      "ops@example.com",
      "qa@example.com",
    ]);
  });

  it("treats an empty or absent var as no admins", () => {
    expect(parseBootstrapAdmins("")).toEqual([]);
    expect(parseBootstrapAdmins("   ")).toEqual([]);
    expect(parseBootstrapAdmins(",,,")).toEqual([]);
    expect(parseBootstrapAdmins(undefined)).toEqual([]);
    expect(parseBootstrapAdmins(null)).toEqual([]);
  });
});

describe("isBootstrapAdmin", () => {
  const config = testConfig({ bootstrapAdmins: parseBootstrapAdmins("Ops@Example.com") });

  it("matches case-insensitively, because the email claim is not normalised", () => {
    expect(isBootstrapAdmin(config, "ops@example.com")).toBe(true);
    expect(isBootstrapAdmin(config, "  OPS@EXAMPLE.COM ")).toBe(true);
  });

  it("does not match anyone else", () => {
    expect(isBootstrapAdmin(config, "someone@example.com")).toBe(false);
    expect(isBootstrapAdmin(config, "")).toBe(false);
    expect(isBootstrapAdmin(testConfig(), "ops@example.com")).toBe(false);
  });

  /** The var is read LIVE. Removing an email takes effect on the next request. */
  it("is evaluated against the config on every call", () => {
    expect(isBootstrapAdmin(testConfig({ bootstrapAdmins: [] }), "ops@example.com")).toBe(false);
  });
});

describe("self-heal", () => {
  it("creates the identity, a real global admin grant, and an audit row", async () => {
    const ctx = requestContext(db, userActor(ADMIN), {
      config: testConfig({ bootstrapAdmins: [ADMIN] }),
    });

    const result = await selfHealBootstrapGrant(ctx);
    expect(result.granted).toBe(true);

    const identityRows = await db.select().from(identities);
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]).toMatchObject({ kind: "user", subject: ADMIN, disabled: false });

    const grantRows = await db.select().from(grants);
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]).toMatchObject({
      role: "admin",
      scopeType: "global",
      projectId: null,
      environmentId: null,
      expiresAt: null,
      createdBy: "bootstrap",
    });

    const auditRows = await db.select().from(auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorKind: "system",
      action: "bootstrap.grant.create",
      outcome: "success",
    });
  });

  it("is idempotent: a second request creates nothing", async () => {
    const config = testConfig({ bootstrapAdmins: [ADMIN] });

    expect((await selfHealBootstrapGrant(requestContext(db, userActor(ADMIN), { config }))).granted)
      .toBe(true);
    expect((await selfHealBootstrapGrant(requestContext(db, userActor(ADMIN), { config }))).granted)
      .toBe(false);

    expect(await db.select().from(grants)).toHaveLength(1);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("survives two concurrent first requests without duplicating the grant", async () => {
    const config = testConfig({ bootstrapAdmins: [ADMIN] });

    await Promise.all([
      selfHealBootstrapGrant(requestContext(db, userActor(ADMIN), { config })),
      selfHealBootstrapGrant(requestContext(db, userActor(ADMIN), { config })),
    ]);

    // The partial unique index on (identity_id) WHERE scope_type = 'global' is
    // what makes this true -- not a check-then-insert.
    expect(await db.select().from(grants)).toHaveLength(1);
  });

  it("REJECTS a subject that is not listed in the var", async () => {
    const ctx = requestContext(db, userActor(OTHER), {
      config: testConfig({ bootstrapAdmins: [ADMIN] }),
    });

    await rejectsWith(async () => selfHealBootstrapGrant(ctx), "FORBIDDEN");
    expect(await db.select().from(grants)).toHaveLength(0);
  });

  /** The banner exists for exactly as long as admin is implicit. */
  it("reports bootstrap: true before the heal and false after it", async () => {
    const config = testConfig({ bootstrapAdmins: [ADMIN] });

    const before = await resolveAuthorization(requestContext(db, userActor(ADMIN), { config }));
    expect(before.bootstrap).toBe(true);
    expect(before.globalRole).toBeNull();

    await selfHealBootstrapGrant(requestContext(db, userActor(ADMIN), { config }));

    const after = await resolveAuthorization(requestContext(db, userActor(ADMIN), { config }));
    expect(after.bootstrap).toBe(false);
    expect(after.globalRole).toBe("admin");
  });

  it("leaves the grant working after the var is removed", async () => {
    await selfHealBootstrapGrant(
      requestContext(db, userActor(ADMIN), {
        config: testConfig({ bootstrapAdmins: [ADMIN] }),
      }),
    );

    // The var is what created the grant; the grant is what keeps working.
    const ctx = requestContext(db, userActor(ADMIN), { config: testConfig() });
    expect(await resolveEffectiveRole(ctx, { type: "global" })).toBe("admin");
  });
});

describe("upsertIdentity", () => {
  it("creates a row and then touches last_seen_at without duplicating it", async () => {
    const first = await upsertIdentity(requestContext(db, userActor(ADMIN)));
    const second = await upsertIdentity(
      requestContext(db, userActor(ADMIN), { now: NOW + 5_000 }),
    );

    expect(second).toBe(first);

    const rows = await db.select().from(identities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSeenAt).toBe(NOW + 5_000);
  });

  it("keeps a user and a service token with the same subject apart", async () => {
    await upsertIdentity(requestContext(db, userActor("shared-name")));
    await upsertIdentity(
      requestContext(db, { kind: "service", subject: "shared-name", identityId: null, bootstrap: false }),
    );

    expect(await db.select().from(identities)).toHaveLength(2);
  });
});

describe("NO_ADMINS_CONFIGURED", () => {
  it("REJECTS with 503 when the var is empty AND no global admin grant exists", async () => {
    const ctx = requestContext(db, userActor(ADMIN), { config: testConfig() });

    expect(await hasNoAdmins(ctx)).toBe(true);

    const error = await rejectsWith(
      async () => assertAdminsConfigured(ctx),
      "NO_ADMINS_CONFIGURED",
    );
    expect(error.status).toBe(503);
    expect(error.hint).toContain("BOOTSTRAP_ADMINS");
  });

  it("is satisfied by the var alone", async () => {
    const ctx = requestContext(db, userActor(ADMIN), {
      config: testConfig({ bootstrapAdmins: [ADMIN] }),
    });

    expect(await hasNoAdmins(ctx)).toBe(false);
    await expect(assertAdminsConfigured(ctx)).resolves.toBeUndefined();
  });

  it("is satisfied by a real global admin grant alone", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(ADMIN), { config: testConfig() });
    expect(await hasNoAdmins(ctx)).toBe(false);
  });

  it("does NOT count a global admin grant on a disabled identity", async () => {
    const identityId = await seedIdentity(db, {
      kind: "user",
      subject: ADMIN,
      disabled: true,
    });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    // Nobody can log in and administer this install, so reporting it as
    // administrable would be a lie the UI then repeats.
    expect(await hasNoAdmins(requestContext(db, userActor(ADMIN)))).toBe(true);
  });

  it("does NOT count an expired global admin grant", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    await seedGrant(db, {
      identityId,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW - 1,
    });

    expect(await hasNoAdmins(requestContext(db, userActor(ADMIN)))).toBe(true);
  });

  it("does NOT count a global grant that is not admin", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    await seedGrant(db, { identityId, role: "writer", scopeType: "global" });

    expect(await hasNoAdmins(requestContext(db, userActor(ADMIN)))).toBe(true);
  });
});

describe("LAST_ADMIN", () => {
  it("REJECTS revoking the only global admin grant when the var is empty", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const grantId = await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(ADMIN), { config: testConfig() });

    const error = await rejectsWith(async () => assertNotLastAdmin(ctx, grantId), "LAST_ADMIN");
    expect(error.status).toBe(409);
  });

  it("allows it when a second global admin remains", async () => {
    const first = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const second = await seedIdentity(db, { kind: "user", subject: OTHER });
    const grantId = await seedGrant(db, { identityId: first, role: "admin", scopeType: "global" });
    await seedGrant(db, { identityId: second, role: "admin", scopeType: "global" });

    await expect(
      assertNotLastAdmin(requestContext(db, userActor(ADMIN)), grantId),
    ).resolves.toBeUndefined();
  });

  it("allows it when BOOTSTRAP_ADMINS provides a way back in", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const grantId = await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    const ctx = requestContext(db, userActor(ADMIN), {
      config: testConfig({ bootstrapAdmins: [OTHER] }),
    });

    await expect(assertNotLastAdmin(ctx, grantId)).resolves.toBeUndefined();
  });

  it("REJECTS when the only other global admin is disabled", async () => {
    const first = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const second = await seedIdentity(db, { kind: "user", subject: OTHER, disabled: true });
    const grantId = await seedGrant(db, { identityId: first, role: "admin", scopeType: "global" });
    await seedGrant(db, { identityId: second, role: "admin", scopeType: "global" });

    await rejectsWith(
      async () => assertNotLastAdmin(requestContext(db, userActor(ADMIN)), grantId),
      "LAST_ADMIN",
    );
  });

  it("REJECTS when the only other global admin grant has expired", async () => {
    const first = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const second = await seedIdentity(db, { kind: "user", subject: OTHER });
    const grantId = await seedGrant(db, { identityId: first, role: "admin", scopeType: "global" });
    await seedGrant(db, {
      identityId: second,
      role: "admin",
      scopeType: "global",
      expiresAt: NOW - 1,
    });

    await rejectsWith(
      async () => assertNotLastAdmin(requestContext(db, userActor(ADMIN)), grantId),
      "LAST_ADMIN",
    );
  });

  it("does not interfere with revoking a non-global grant", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    await seedGrant(db, { identityId, role: "admin", scopeType: "global" });
    const projectGrant = await seedGrant(db, {
      identityId,
      role: "reader",
      scopeType: "environment",
      environmentId: null,
    });

    await expect(
      assertNotLastAdmin(requestContext(db, userActor(ADMIN)), projectGrant),
    ).resolves.toBeUndefined();
  });

  it("does not interfere with revoking a grant that no longer exists", async () => {
    await expect(
      assertNotLastAdmin(requestContext(db, userActor(ADMIN)), "no-such-grant"),
    ).resolves.toBeUndefined();
  });

  it("leaves the grant in place when the guard fires", async () => {
    const identityId = await seedIdentity(db, { kind: "user", subject: ADMIN });
    const grantId = await seedGrant(db, { identityId, role: "admin", scopeType: "global" });

    await rejectsWith(
      async () => assertNotLastAdmin(requestContext(db, userActor(ADMIN)), grantId),
      "LAST_ADMIN",
    );

    expect(await db.select().from(grants).where(eq(grants.id, grantId))).toHaveLength(1);
  });
});
