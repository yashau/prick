import { beforeEach, describe, expect, it } from "vitest";

import { buildKeyring, encryptSecretValue } from "../../src/lib/server/crypto/index.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { TEST_MASTER_KEY_OLD, insertVersionRow } from "../core/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let owner: string;

beforeEach(async () => {
  api = await apiHarness();
  owner = await api.ownerToken();
});

/**
 * The key ring routes, over the real Hono app.
 *
 * WHAT THIS FILE IS FOR, now that `core/keyring.ts` is implemented: the
 * transport. Status codes, the response shape the OpenAPI document promises,
 * body validation, and -- the reason it was rewritten -- the authorization that
 * used to be a documented hole here. The domain behaviour (what is counted, in
 * what order rows move, what happens to a row that will not decrypt) is
 * asserted against the database in `test/core/keyring.test.ts`, because those
 * are properties of the rows rather than of the HTTP surface.
 *
 * The harness binds `MASTER_KEY` and no `MASTER_KEY_OLD`, so the ring here has
 * exactly one key. That is the ordinary case -- an installation not mid-
 * rotation -- and it is why the rotation states below are produced by seeding a
 * row that names a key id the ring does not hold, which is also the emergency
 * the indicator exists to report.
 */
describe("GET /admin/keyring", () => {
  it("answers the ring, and reports it safe on an installation with nothing stored", async () => {
    const { status, body: ring } = await api.json<{
      activeKid: string;
      entries: { kid: string; status: string; rowsRemaining: number; lastRekeyAt: number | null }[];
      safeToRemoveOldKey: boolean;
    }>("/api/v1/admin/keyring", { token: owner });

    expect(status).toBe(200);

    // A 16-character hex key id: the first eight bytes of the HKDF output. It
    // is not a secret -- it is in every envelope in the clear -- which is why
    // this endpoint may return it at all.
    expect(ring.activeKid).toMatch(/^[0-9a-f]{16}$/);

    expect(ring.entries).toEqual([
      { kid: ring.activeKid, status: "active", rowsRemaining: 0, lastRekeyAt: null },
    ]);

    // Nothing is stored, so there is nothing a retired key could be holding.
    expect(ring.safeToRemoveOldKey).toBe(true);
  });

  it("goes red the moment one row names a key id the ring does not hold", async () => {
    const projectId = await seedProject(api.db, "acme");
    const environmentId = await seedEnvironment(api.db, projectId, "prod");

    const stranded = await buildKeyring({ active: TEST_MASTER_KEY_OLD, retired: [] });

    await insertVersionRow(api.db, {
      environmentId,
      key: "TOKEN",
      version: 1,
      ciphertext: await encryptSecretValue({
        ringKey: stranded.active,
        environmentId,
        key: "TOKEN",
        version: 1,
        plaintext: "sealed-under-a-key-this-worker-does-not-have",
      }),
      kid: stranded.active.kid,
    });

    const { status, body: ring } = await api.json<{
      entries: { kid: string; status: string; rowsRemaining: number }[];
      safeToRemoveOldKey: boolean;
    }>("/api/v1/admin/keyring", { token: owner });

    expect(status).toBe(200);
    expect(ring.entries).toContainEqual(
      expect.objectContaining({ kid: stranded.active.kid, status: "retired", rowsRemaining: 1 }),
    );

    // THE assertion in this file. One row, counted, and the indicator is false.
    expect(ring.safeToRemoveOldKey).toBe(false);
  });

  it("is behind authentication like everything else", async () => {
    expect((await api.fetch("/api/v1/admin/keyring", { token: null })).status).toBe(401);
  });

  it("requires a GLOBAL admin, which used to be a documented hole here", async () => {
    /*
     * DISCHARGING THE NOTE THIS FILE USED TO CARRY.
     *
     * While both handlers answered 501 they performed no authorization check,
     * and that leaked nothing because the answer was identical for everyone. It
     * stopped being harmless the moment either function did something: the
     * status endpoint reports how much of the installation is on which key, and
     * the rekey endpoint re-encrypts rows. Both now call
     * `assertRole(ctx, { type: "global" }, "admin")` as their first statement,
     * in `core`, where the SvelteKit load enters through the same check.
     */
    const stranger = await api.serviceToken("nobody.access");

    const denied = await api.json<{ code: string }>("/api/v1/admin/keyring", { token: stranger });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
  });

  it("is not enough to administer one environment", async () => {
    const projectId = await seedProject(api.db, "acme");
    const environmentId = await seedEnvironment(api.db, projectId, "prod");

    await api.grant({
      subject: "env-admin@example.com",
      role: "admin",
      scopeType: "environment",
      environmentId,
    });

    const token = await api.userToken("env-admin@example.com");

    // The key ring is installation-wide. An admin grant on one environment says
    // nothing about the master key that protects every other one.
    expect((await api.fetch("/api/v1/admin/keyring", { token })).status).toBe(403);
  });
});

describe("POST /admin/rekey", () => {
  it("answers progress, and reports nothing outstanding when nothing is", async () => {
    const { status, body: result } = await api.json<{ rekeyed: number; remaining: number }>(
      "/api/v1/admin/rekey",
      { method: "POST", token: owner, ...body({ limit: 100 }) },
    );

    expect(status).toBe(200);
    expect(result).toEqual({ rekeyed: 0, remaining: 0 });
  });

  it("fails loudly, and names the key id, when a row cannot be opened", async () => {
    const projectId = await seedProject(api.db, "acme");
    const environmentId = await seedEnvironment(api.db, projectId, "prod");

    const stranded = await buildKeyring({ active: TEST_MASTER_KEY_OLD, retired: [] });

    await insertVersionRow(api.db, {
      environmentId,
      key: "TOKEN",
      version: 1,
      ciphertext: await encryptSecretValue({
        ringKey: stranded.active,
        environmentId,
        key: "TOKEN",
        version: 1,
        plaintext: "sealed-under-a-key-this-worker-does-not-have",
      }),
      kid: stranded.active.kid,
    });

    const { status, body: error } = await api.json<{ code: string; message: string }>(
      "/api/v1/admin/rekey",
      { method: "POST", token: owner, ...body({ limit: 100 }) },
    );

    // UNKNOWN_KID and not a generic failure: "you removed MASTER_KEY_OLD too
    // early" and "this row has been tampered with" need opposite responses, and
    // the distinction has to survive all the way out to the operator.
    expect(status).toBe(500);
    expect(error.code).toBe("UNKNOWN_KID");
    expect(error.message).toContain(stranded.active.kid);
    expect(error.message).not.toContain("sealed-under-a-key");
  });

  it("validates the page size before it gets there", async () => {
    // The bound is not decorative: a rekey re-encrypts row by row inside one
    // invocation, and `batch()` has a documented 30 s ceiling. An unbounded
    // `limit` is a request that either finishes or times out having done an
    // unknown amount of work.
    for (const payload of [{ limit: 0 }, { limit: 100_000 }, { limit: "100" }, { pages: 1 }]) {
      const response = await api.fetch("/api/v1/admin/rekey", {
        method: "POST",
        token: owner,
        ...body(payload),
      });

      expect(response.status, JSON.stringify(payload)).toBe(422);
    }
  });

  it("defaults the page size when the field is omitted", async () => {
    const response = await api.fetch("/api/v1/admin/rekey", {
      method: "POST",
      token: owner,
      ...body({}),
    });

    expect(response.status).toBe(200);
  });

  it("requires a global admin, and re-encrypts nothing for anyone else", async () => {
    const stranger = await api.serviceToken("nobody.access");

    const denied = await api.json<{ code: string }>("/api/v1/admin/rekey", {
      method: "POST",
      token: stranger,
      ...body({ limit: 100 }),
    });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
  });

  it("is behind authentication like everything else", async () => {
    const response = await api.fetch("/api/v1/admin/rekey", {
      method: "POST",
      token: null,
      ...body({ limit: 100 }),
    });

    expect(response.status).toBe(401);
  });
});
