import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getKeyringStatus, rekeyPage } from "../../src/lib/server/core/keyring.js";
import { exportSecrets, rollbackSecret, writeSecrets } from "../../src/lib/server/core/secrets.js";
import {
  buildKeyring,
  decryptSecretValue,
  encryptSecretValue,
  parseEnvelope,
  type Keyring,
} from "../../src/lib/server/crypto/index.js";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import { auditLog, keyringState, secretVersions } from "../../src/lib/server/db/schema.js";
import { rejectsWith } from "../auth/rejects.js";
import {
  NOW,
  TEST_MASTER_KEY,
  TEST_MASTER_KEY_OLD,
  countingBinding,
  freshDatabase,
  insertVersionRow,
  secretsContext,
  seedEnvironment,
  seedGlobalAdmin,
  seedGrant,
  seedIdentity,
  seedProject,
  userActor,
} from "./fixtures.js";

/**
 * THE ROTATION SUITE, and the one boolean it exists for.
 *
 * `safeToRemoveOldKey` gates the single irreversible action this design leaves
 * available: deleting `MASTER_KEY_OLD`. If it is true while one row still
 * references the retired key id, that row's value is gone -- not corrupted, not
 * recoverable from a backup this application can restore, gone. So the tests
 * below are written to fail in the direction that matters: every one of them
 * asserts the indicator is FALSE while work remains, and only two assert it
 * ever goes true.
 *
 * They are written against the two exported functions and against the DATABASE
 * -- row counts, kids, envelopes, audit rows -- rather than against anything
 * the implementation returns about itself. A test that agreed with the
 * implementation's own bookkeeping would agree with a bug in it.
 */

const ADMIN = "admin@example.com";
const OUTSIDER = "env-admin@example.com";

let db: Database;
/** The ring BEFORE the rotation: one key, and it is the one rows are sealed under. */
let before: Keyring;
/** The ring AFTER it: a new active key, the old one retained for decryption. */
let after: Keyring;
let environmentId: string;

beforeEach(async () => {
  db = await freshDatabase();

  before = await buildKeyring({ active: TEST_MASTER_KEY_OLD, retired: [] });
  after = await buildKeyring({ active: TEST_MASTER_KEY, retired: [TEST_MASTER_KEY_OLD] });

  await seedGlobalAdmin(db, ADMIN);
  const projectId = await seedProject(db, "acme");
  environmentId = await seedEnvironment(db, projectId, "prod");
});

/** A request from the global admin, on the ring named. */
function admin(keyring: Keyring, database: Database = db) {
  return secretsContext(database, userActor(ADMIN), keyring);
}

/** Write secrets the way they existed before the rotation: under the old key. */
async function seedUnderOldKey(set: Record<string, string>): Promise<void> {
  await writeSecrets(admin(before), "acme", "prod", { mode: "merge", set });
}

/** Every `secret_versions` row, in the order the rekey walks them. */
async function versionRows() {
  return db.select().from(secretVersions).orderBy(asc(secretVersions.id));
}

/**
 * The identity of every row, and nothing about the bytes that protect it.
 *
 * `(id, key, version, op)` is exactly what a rekey may not change -- three of
 * those four are the AAD, and the fourth says whether the row is a value or a
 * deletion. Comparing the whole array rather than each field means an appended
 * row, a dropped row and a reordered one all fail as well.
 */
async function rowIdentities() {
  return (await versionRows()).map((row) => ({
    id: row.id,
    environmentId: row.environmentId,
    key: row.key,
    version: row.version,
    op: row.op,
  }));
}

/** Is every value row sealed under `kid`, in the column AND in the envelope? */
async function allSealedUnder(kid: string): Promise<boolean> {
  return (await versionRows())
    .filter((row) => row.ciphertext !== null)
    .every((row) => row.kid === kid && parseEnvelope(row.ciphertext ?? "").kid === kid);
}

async function rekeyAudit() {
  const rows = await db.select().from(auditLog);
  return rows.filter((row) => row.action === "admin.rekey");
}

function entryFor(status: Awaited<ReturnType<typeof getKeyringStatus>>, kid: string) {
  return status.entries.find((entry) => entry.kid === kid);
}

// ---------------------------------------------------------------------------
// safeToRemoveOldKey
// ---------------------------------------------------------------------------

describe("safeToRemoveOldKey", () => {
  it("is false while ONE row still references the retired kid", async () => {
    await seedUnderOldKey({ TOKEN: "s3cret" });

    const status = await getKeyringStatus(admin(after));

    expect(status.activeKid).toBe(after.active.kid);
    expect(entryFor(status, before.active.kid)).toMatchObject({
      status: "retiring",
      rowsRemaining: 1,
    });
    expect(status.safeToRemoveOldKey).toBe(false);
  });

  it("is still false when the rekey has moved all but one row", async () => {
    await seedUnderOldKey({ A: "1", B: "2", C: "3" });

    // A deliberately short page, so the run stops one row short of done. This
    // is the state an operator is most likely to look at the screen in, and the
    // one where a green indicator costs them a value.
    expect(await rekeyPage(admin(after), 2)).toEqual({ rekeyed: 2, remaining: 1 });

    const status = await getKeyringStatus(admin(after));

    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(1);
    expect(status.safeToRemoveOldKey).toBe(false);
  });

  it("goes true only once the last row has moved", async () => {
    await seedUnderOldKey({ A: "1", B: "2", C: "3" });

    await rekeyPage(admin(after), 2);
    expect((await getKeyringStatus(admin(after))).safeToRemoveOldKey).toBe(false);

    expect(await rekeyPage(admin(after), 2)).toEqual({ rekeyed: 1, remaining: 0 });

    const status = await getKeyringStatus(admin(after));
    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(0);
    expect(status.safeToRemoveOldKey).toBe(true);
  });

  it("counts HISTORY, not just the live version of each key", async () => {
    await seedUnderOldKey({ TOKEN: "v1" });
    await seedUnderOldKey({ TOKEN: "v2" });

    // Two value rows for one live secret. A count that looked only at
    // `secrets.current_version` would report one, and the version-1 row would
    // be left behind under a key the operator had just been told to delete --
    // taking every future rollback with it.
    const status = await getKeyringStatus(admin(after));
    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(2);
  });

  it("does not count tombstones, which carry no ciphertext and no kid", async () => {
    await seedUnderOldKey({ TOKEN: "v1" });
    await writeSecrets(admin(before), "acme", "prod", { mode: "merge", delete: ["TOKEN"] });

    expect(await versionRows()).toHaveLength(2);

    const status = await getKeyringStatus(admin(after));
    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(1);
  });

  it("refuses to call a ciphertext it cannot attribute to a key safe", async () => {
    // A value row with no kid cannot be written by this application -- a
    // tombstone has neither ciphertext nor kid, a value row has both -- so it is
    // evidence of direct database manipulation. It belongs to no entry and can
    // therefore not be displayed, and an unknown must not read as safe.
    const blob = await encryptSecretValue({
      ringKey: after.active,
      environmentId,
      key: "GHOST",
      version: 1,
      plaintext: "unattributable",
    });

    await insertVersionRow(db, {
      environmentId,
      key: "GHOST",
      version: 1,
      ciphertext: blob,
      kid: null,
    });

    const status = await getKeyringStatus(admin(after));

    // Every entry reads zero...
    expect(status.entries.map((entry) => entry.rowsRemaining)).toEqual([0, 0]);
    // ...and the indicator is still red, because the row exists.
    expect(status.safeToRemoveOldKey).toBe(false);
  });

  it("marks a kid the ring no longer holds as retired, and refuses to go green", async () => {
    await seedUnderOldKey({ TOKEN: "s3cret" });

    // MASTER_KEY_OLD removed while a row still names it: the emergency this
    // whole screen exists to prevent, observed after the fact.
    const onlyNew = await buildKeyring({ active: TEST_MASTER_KEY, retired: [] });
    const status = await getKeyringStatus(admin(onlyNew));

    expect(entryFor(status, before.active.kid)).toMatchObject({
      status: "retired",
      rowsRemaining: 1,
    });
    expect(status.safeToRemoveOldKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The re-encryption itself
// ---------------------------------------------------------------------------

describe("a rekeyed row", () => {
  const VALUE = "postgres://user:pa55@db.internal:5432/app";

  it("keeps its identity and its value, and only changes key", async () => {
    await seedUnderOldKey({ DATABASE_URL: VALUE });

    const original = (await versionRows())[0];
    expect(original).toBeDefined();

    await rekeyPage(admin(after), 100);

    const rows = await versionRows();

    // UPDATED IN PLACE. An append would be a new version, and a new version is
    // a different AAD -- which is the one thing a rekey may not produce.
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.id).toBe(original?.id);
    expect(row?.environmentId).toBe(original?.environmentId);
    expect(row?.key).toBe(original?.key);
    expect(row?.version).toBe(original?.version);
    expect(row?.op).toBe(original?.op);

    // The envelope is new and names the new key, in the row and in the bytes.
    expect(row?.ciphertext).not.toBe(original?.ciphertext);
    expect(row?.kid).toBe(after.active.kid);
    expect(parseEnvelope(row?.ciphertext ?? "").kid).toBe(after.active.kid);

    await expect(
      decryptSecretValue({
        keyring: after,
        envelope: row?.ciphertext ?? "",
        environmentId,
        key: "DATABASE_URL",
        version: row?.version ?? 0,
      }),
    ).resolves.toBe(VALUE);
  });

  it("is still bound to (environment, key, version) -- the AAD is unchanged, not absent", async () => {
    await seedUnderOldKey({ DATABASE_URL: VALUE });
    await rekeyPage(admin(after), 100);

    const envelope = (await versionRows())[0]?.ciphertext ?? "";

    // "It decrypts" is not the property. The property is that it decrypts under
    // EXACTLY ONE identity, which is what makes a transplanted ciphertext fail.
    // A rekey that widened or dropped the AAD would pass the test above and
    // fail all three of these.
    const identity = { keyring: after, envelope, environmentId, key: "DATABASE_URL", version: 1 };

    await expect(decryptSecretValue(identity)).resolves.toBe(VALUE);
    await expect(decryptSecretValue({ ...identity, version: 2 })).rejects.toThrow();
    await expect(decryptSecretValue({ ...identity, key: "OTHER" })).rejects.toThrow();
    await expect(
      decryptSecretValue({ ...identity, environmentId: "00000000-0000-7000-8000-000000000000" }),
    ).rejects.toThrow();
  });

  it("reads back through the ordinary export path", async () => {
    await seedUnderOldKey({ A: "one", B: "two", C: "three" });

    await rekeyPage(admin(after), 100);

    // End to end, through the same function the CLI's `prk secrets export`
    // reaches. A rekey whose envelopes only open in a test's hand-built call is
    // a rekey that has not worked.
    await expect(exportSecrets(admin(after), "acme", "prod")).resolves.toEqual({
      A: "one",
      B: "two",
      C: "three",
    });
  });

  it("leaves an old version rollback-able, which is why history is rekeyed", async () => {
    await seedUnderOldKey({ TOKEN: "v1" });
    await seedUnderOldKey({ TOKEN: "v2" });

    await rekeyPage(admin(after), 100);

    const rows = await versionRows();
    expect(rows.every((row) => row.kid === after.active.kid)).toBe(true);

    // Version 1 was history, not the live row, and it still opens. `rollback`
    // decrypts an arbitrary earlier version, so a rekey that skipped history
    // would leave this working only until MASTER_KEY_OLD went away.
    await rollbackSecret(admin(after), "acme", "prod", { key: "TOKEN", to_version: 1 });

    await expect(exportSecrets(admin(after), "acme", "prod")).resolves.toEqual({ TOKEN: "v1" });
  });
});

// ---------------------------------------------------------------------------
// The property `docs/contributing/testing.md` asks for, stated in one test
// ---------------------------------------------------------------------------

describe("rekey correctness", () => {
  /**
   * A TWO-KEY RING, EVERY VALUE STILL DECRYPTS, AND NO VERSION CHANGED.
   *
   * The three clauses are one property and none of them is worth much alone:
   *
   *   a two-key ring alone     -- a rekey that did nothing at all passes it;
   *   every value decrypts     -- so does an implementation that never touched
   *                               a row, since the old key is still in the ring
   *                               and still opens everything;
   *   no version changed       -- and so does one that deleted the rows.
   *
   * Together they say the only thing that moved is which key protects the
   * bytes, and this test asserts all three over the same environment, with
   * history and a tombstone in it so "every row" means more than "the one row".
   */
  it("holds over an environment with history and a tombstone", async () => {
    // TWO keys, and genuinely two: `buildKeyring` refuses a retired entry that
    // is byte-identical to the active one, precisely so that a rotation which
    // did not happen cannot masquerade as one that did.
    expect(after.active.kid).not.toBe(before.active.kid);
    expect(after.retired.map((entry) => entry.kid)).toEqual([before.active.kid]);

    await seedUnderOldKey({ A: "one", B: "two", C: "three" });
    await seedUnderOldKey({ B: "two-again" });
    await writeSecrets(admin(before), "acme", "prod", { mode: "merge", delete: ["C"] });

    /** key|version -> plaintext, for every row that carries a value. */
    const expected = new Map([
      ["A|1", "one"],
      ["B|1", "two"],
      ["B|2", "two-again"],
      ["C|1", "three"],
    ]);

    const identitiesBefore = await rowIdentities();
    expect(await allSealedUnder(before.active.kid)).toBe(true);

    await rekeyPage(admin(after), 100);

    // 1. NO VERSION CHANGED. Same rows, same ids, same keys, same versions,
    //    same ops -- compared as a whole rather than field by field, so an
    //    appended row or a dropped one fails here too.
    expect(await rowIdentities()).toEqual(identitiesBefore);

    // 2. Everything moved onto the new key, in the column and in the envelope.
    expect(await allSealedUnder(after.active.kid)).toBe(true);

    const rows = await versionRows();
    const values = rows.filter((row) => row.ciphertext !== null);
    const tombstones = rows.filter((row) => row.ciphertext === null);

    // The tombstone is accounted for rather than skipped: it carries no value
    // by construction, and stating its count is what stops "we decrypted every
    // value" from quietly meaning "we decrypted the ones we felt like".
    expect(tombstones).toHaveLength(1);
    expect(values).toHaveLength(expected.size);

    // 3. EVERY VALUE STILL DECRYPTS, historical versions included, each to the
    //    plaintext it had before -- under the identity it always had.
    for (const row of values) {
      await expect(
        decryptSecretValue({
          keyring: after,
          envelope: row.ciphertext ?? "",
          environmentId: row.environmentId,
          key: row.key,
          version: row.version,
        }),
      ).resolves.toBe(expected.get(`${row.key}|${String(row.version)}`));
    }

    // And the retired key is now holding nothing, which is the whole point.
    const status = await getKeyringStatus(admin(after));
    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(0);
    expect(status.safeToRemoveOldKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure is loud, and it is atomic
// ---------------------------------------------------------------------------

describe("a row that does not decrypt", () => {
  /**
   * A ciphertext sealed against a DIFFERENT key name, filed under this one.
   *
   * That is the cross-key transplant the AAD exists to catch, and to AES-GCM it
   * is indistinguishable from a flipped bit: both are "these bytes were not
   * sealed against the identity they are being opened under". Simulating it
   * this way rather than by corrupting base64 means the failure is a TAG
   * failure and not a parse failure, which is the case that has to be loud.
   *
   * The key name sorts after the good row's, and `insertVersionRow` mints a
   * later UUIDv7, so the rekey reaches a good row FIRST. That ordering is the
   * test: the good row is resealed in memory before the bad one is met.
   */
  async function plantTransplantedRow(): Promise<void> {
    const forged = await encryptSecretValue({
      ringKey: before.active,
      environmentId,
      key: "SOMETHING_ELSE",
      version: 1,
      plaintext: "transplanted",
    });

    await insertVersionRow(db, {
      environmentId,
      key: "ZZZ_TAMPERED",
      version: 1,
      ciphertext: forged,
      kid: before.active.kid,
    });
  }

  it("fails the whole page loudly instead of skipping the row", async () => {
    await seedUnderOldKey({ AAA_GOOD: "keep-me" });
    await plantTransplantedRow();

    const snapshot = await versionRows();

    const error = await rejectsWith(() => rekeyPage(admin(after), 100), "DECRYPT_FAILED");

    // The message names the row so an operator can go and look at it, and
    // carries nothing that would make the log line worth stealing.
    expect(error.message).toContain("ZZZ_TAMPERED");
    expect(error.message).not.toContain("transplanted");

    // NOT ONE ROW MOVED -- including the good one, which had already been
    // resealed in memory when the bad one was reached. The batch is assembled
    // after the whole page, so a failure anywhere in the page writes nothing.
    expect(await versionRows()).toEqual(snapshot);
  });

  it("records the failure, and does not record a success", async () => {
    await seedUnderOldKey({ AAA_GOOD: "keep-me" });
    await plantTransplantedRow();

    await rejectsWith(() => rekeyPage(admin(after), 100), "DECRYPT_FAILED");

    const rows = await rekeyAudit();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    expect(rows[0]?.targetKey).toBe("ZZZ_TAMPERED");
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toMatchObject({
      kind: "secret.unreadable",
      keys: ["ZZZ_TAMPERED"],
      kid: before.active.kid,
    });
  });

  it("leaves the indicator red, because the work did not happen", async () => {
    await seedUnderOldKey({ AAA_GOOD: "keep-me" });
    await plantTransplantedRow();

    await rejectsWith(() => rekeyPage(admin(after), 100), "DECRYPT_FAILED");

    const status = await getKeyringStatus(admin(after));
    expect(entryFor(status, before.active.kid)?.rowsRemaining).toBe(2);
    expect(status.safeToRemoveOldKey).toBe(false);
  });

  it("names the missing key id when the retired key has already been deleted", async () => {
    await seedUnderOldKey({ TOKEN: "s3cret" });

    const onlyNew = await buildKeyring({ active: TEST_MASTER_KEY, retired: [] });

    // UNKNOWN_KID, not DECRYPT_FAILED. "You removed MASTER_KEY_OLD too early"
    // and "this row has been altered" need opposite responses, and the whole
    // point of the distinct code is that an operator can tell which they have.
    const error = await rejectsWith(() => rekeyPage(admin(onlyNew), 100), "UNKNOWN_KID");
    expect(error.message).toContain(before.active.kid);

    expect((await versionRows())[0]?.kid).toBe(before.active.kid);
  });
});

// ---------------------------------------------------------------------------
// Paging, batching, idempotency
// ---------------------------------------------------------------------------

describe("the page", () => {
  it("is ONE batch, and a second run is a no-op that writes nothing", async () => {
    await seedUnderOldKey({ A: "1", B: "2", C: "3" });

    const counter = countingBinding();
    const counted = createDatabase(counter.binding);
    counter.reset();

    expect(await rekeyPage(admin(after, counted), 100)).toEqual({ rekeyed: 3, remaining: 0 });

    // Splitting the re-encryptions across two batches would pass every
    // assertion about the data and would quietly forfeit atomicity: a failure
    // in the second batch leaves the first committed.
    expect(counter.batches()).toBe(1);

    counter.reset();

    expect(await rekeyPage(admin(after, counted), 100)).toEqual({ rekeyed: 0, remaining: 0 });
    expect(counter.batches()).toBe(0);

    // One event, one audit row. A second pass that re-recorded the same work
    // would make the log say a rotation happened twice.
    expect(await rekeyAudit()).toHaveLength(1);

    await expect(exportSecrets(admin(after), "acme", "prod")).resolves.toEqual({
      A: "1",
      B: "2",
      C: "3",
    });
  });

  it("resumes across invocations without a stored cursor", async () => {
    const set: Record<string, string> = {};
    for (let index = 0; index < 7; index += 1) set[`K${String(index)}`] = `v${String(index)}`;
    await seedUnderOldKey(set);

    let moved = 0;
    let guard = 0;

    for (;;) {
      const result = await rekeyPage(admin(after), 3);
      moved += result.rekeyed;
      guard += 1;

      expect(guard).toBeLessThan(10);
      if (result.remaining === 0) break;
    }

    expect(moved).toBe(7);
    expect((await versionRows()).every((row) => row.kid === after.active.kid)).toBe(true);
  });

  it("clamps an oversized request to the batch ceiling rather than splitting it", async () => {
    const set: Record<string, string> = {};
    for (let index = 0; index < 120; index += 1) set[`K${String(index)}`] = `v${String(index)}`;
    await seedUnderOldKey(set);

    const counter = countingBinding();
    const counted = createDatabase(counter.binding);
    counter.reset();

    // Asked for 1000. The ceiling exists because a page is one batch and a
    // batch that does not fit must get smaller, never split -- and the caller
    // is told the truth by `remaining` rather than being quietly short-changed.
    expect(await rekeyPage(admin(after, counted), 1000)).toEqual({ rekeyed: 100, remaining: 20 });
    expect(counter.batches()).toBe(1);

    expect(await rekeyPage(admin(after), 1000)).toEqual({ rekeyed: 20, remaining: 0 });
  });

  it("refuses a page size that is not a positive integer", async () => {
    await rejectsWith(() => rekeyPage(admin(after), 0), "VALIDATION_FAILED");
    await rejectsWith(() => rekeyPage(admin(after), -5), "VALIDATION_FAILED");
    await rejectsWith(() => rekeyPage(admin(after), 1.5), "VALIDATION_FAILED");
    await rejectsWith(() => rekeyPage(admin(after), Number.NaN), "VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// keyring_state
// ---------------------------------------------------------------------------

describe("keyring_state", () => {
  it("is RECOMPUTED by the rekey, not decremented by it", async () => {
    await seedUnderOldKey({ A: "1", B: "2", C: "3" });

    await rekeyPage(admin(after), 2);

    const rows = await db.select().from(keyringState);

    const retired = rows.find((row) => row.kid === before.active.kid);
    const active = rows.find((row) => row.kid === after.active.kid);

    // Two moved, one left. A running counter decremented by the page size would
    // agree here and diverge the moment an ordinary secret write added a row.
    expect(retired).toMatchObject({ status: "retiring", rowsRemaining: 1, lastRekeyAt: NOW });
    expect(active).toMatchObject({ status: "active", rowsRemaining: 2, lastRekeyAt: NOW });
  });

  it("stays right after an ordinary write lands between two pages", async () => {
    await seedUnderOldKey({ A: "1", B: "2", C: "3" });
    await rekeyPage(admin(after), 2);

    // A normal write, under the ACTIVE key, of a key the rekey never touched.
    await writeSecrets(admin(after), "acme", "prod", { mode: "merge", set: { D: "4" } });

    await rekeyPage(admin(after), 2);

    const rows = await db.select().from(keyringState);
    expect(rows.find((row) => row.kid === before.active.kid)?.rowsRemaining).toBe(0);
    // Three rekeyed plus the one written directly.
    expect(rows.find((row) => row.kid === after.active.kid)?.rowsRemaining).toBe(4);
  });

  it("reports lastRekeyAt through the status, and null before any rekey", async () => {
    await seedUnderOldKey({ TOKEN: "s3cret" });

    expect(
      entryFor(await getKeyringStatus(admin(after)), before.active.kid)?.lastRekeyAt,
    ).toBeNull();

    await rekeyPage(admin(after), 100);

    expect(entryFor(await getKeyringStatus(admin(after)), before.active.kid)?.lastRekeyAt).toBe(
      NOW,
    );
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("authorization", () => {
  beforeEach(async () => {
    // Admin of one environment, which is as close as a non-global admin gets.
    const identityId = await seedIdentity(db, { kind: "user", subject: OUTSIDER });
    await seedGrant(db, { identityId, role: "admin", scopeType: "environment", environmentId });
  });

  function outsider() {
    return secretsContext(db, userActor(OUTSIDER), after);
  }

  it("refuses the status to anything short of a global admin", async () => {
    await rejectsWith(() => getKeyringStatus(outsider()), "FORBIDDEN");
  });

  it("refuses the rekey, and re-encrypts nothing", async () => {
    await seedUnderOldKey({ TOKEN: "s3cret" });

    await rejectsWith(() => rekeyPage(outsider(), 100), "FORBIDDEN");

    expect((await versionRows())[0]?.kid).toBe(before.active.kid);
    expect(await rekeyAudit()).toHaveLength(0);
  });

  it("allows the global admin", async () => {
    await expect(getKeyringStatus(admin(after))).resolves.toMatchObject({
      activeKid: after.active.kid,
    });
  });
});
