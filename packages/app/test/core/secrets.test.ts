import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getEnvironment } from "../../src/lib/server/core/environments.js";
import {
  exportSecrets,
  importSecrets,
  listSecrets,
  listVersions,
  renameSecret,
  revealSecret,
  rollbackSecret,
  writeSecrets,
} from "../../src/lib/server/core/secrets.js";
import { encryptSecretValue, type Keyring } from "../../src/lib/server/crypto/index.js";
import type { Database } from "../../src/lib/server/db/client.js";
import { auditLog, secretVersions } from "../../src/lib/server/db/schema.js";
import { rejectsWith } from "../auth/rejects.js";
import {
  freshDatabase,
  secretsContext,
  seedEnvironment,
  seedGlobalAdmin,
  seedProject,
  testKeyring,
  userActor,
} from "./fixtures.js";

const ADMIN = "admin@example.com";

let db: Database;
let keyring: Keyring;
let environmentId: string;
let otherEnvironmentId: string;

beforeEach(async () => {
  db = await freshDatabase();
  keyring = await testKeyring();
  await seedGlobalAdmin(db, ADMIN);
  const projectId = await seedProject(db, "acme");
  environmentId = await seedEnvironment(db, projectId, "prod");
  otherEnvironmentId = await seedEnvironment(db, projectId, "dev");
});

function ctx() {
  return secretsContext(db, userActor(ADMIN), keyring);
}

async function write(set: Record<string, string>, mode: "merge" | "replace" = "merge") {
  return writeSecrets(ctx(), "acme", "prod", { mode, set });
}

describe("round trip", () => {
  it("writes, lists and reveals", async () => {
    await write({ DATABASE_URL: "postgres://localhost/app" });

    const list = await listSecrets(ctx(), "acme", "prod");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "DATABASE_URL", version: 1, unreadable: false });

    // The list carries NO value field at all -- not an empty one, not a masked
    // one. There is nothing on the object for an SSR payload to serialise.
    expect(Object.keys(list[0] ?? {})).not.toContain("value");

    const value = await revealSecret(ctx(), "acme", "prod", "DATABASE_URL", "reveal");
    expect(value).toBe("postgres://localhost/app");
  });

  it("bumps the version on every write, without decrypting to compare", async () => {
    await write({ TOKEN: "a" });
    await write({ TOKEN: "a" });

    // Deliberately the SAME value. Detecting "unchanged" would require
    // decrypting the existing row to compare, which is a silent full reveal on
    // a write path. A no-op write producing a version is the honest trade.
    const versions = await listVersions(ctx(), "acme", "prod", "TOKEN");
    expect(versions.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("exports every value at once", async () => {
    await write({ A: "1", B: "2", C: "3" });

    await expect(exportSecrets(ctx(), "acme", "prod")).resolves.toEqual({
      A: "1",
      B: "2",
      C: "3",
    });
  });

  it("replace removes what it does not mention", async () => {
    await write({ A: "1", B: "2" });
    const result = await write({ A: "1", C: "3" }, "replace");

    expect(result.removed).toEqual(["B"]);
    expect(Object.keys(await exportSecrets(ctx(), "acme", "prod")).sort()).toEqual(["A", "C"]);
  });

  it("merge leaves unmentioned keys alone", async () => {
    await write({ A: "1", B: "2" });
    await write({ C: "3" });

    expect(Object.keys(await exportSecrets(ctx(), "acme", "prod")).sort()).toEqual(["A", "B", "C"]);
  });
});

/**
 * DESCRIPTIONS, and the one thing the upsert makes easy to get wrong.
 *
 * A description is plaintext metadata: it is NOT in the AAD, which binds
 * `(purpose, environment_id, key, version)` and nothing else, so writing one
 * re-encrypts nothing and moves no version beyond the ordinary bump the value
 * write was already making.
 *
 * The hazard is structural rather than cryptographic. ONE `onConflictDoUpdate`
 * applies ONE `SET` expression to every row in its statement, so an
 * implementation that wrote `description = excluded.description` for the whole
 * batch would clear the description of every key it merely happened to be
 * writing alongside -- a data loss that no test of the described key itself can
 * see. Every case below is written from the other keys' point of view for that
 * reason.
 */
describe("descriptions", () => {
  /** Every live key's description, by key. */
  async function stored(): Promise<Record<string, string | null>> {
    const entries = await listSecrets(ctx(), "acme", "prod");
    return Object.fromEntries(entries.map((entry) => [entry.key, entry.description]));
  }

  it("stores the description written alongside a value", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { STRIPE_SECRET_KEY: "sk-live-hunter2" },
      descriptions: { STRIPE_SECRET_KEY: "Live mode, rotates quarterly" },
    });

    expect(await stored()).toEqual({ STRIPE_SECRET_KEY: "Live mode, rotates quarterly" });

    // The description is metadata and the value is not. Listing one must not
    // have leaked the other.
    const entries = await listSecrets(ctx(), "acme", "prod");
    expect(JSON.stringify(entries)).not.toContain("hunter2");
  });

  it("describing ONE key does not clear the descriptions of the others in the same batch", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { A: "1", B: "2", C: "3" },
      descriptions: { A: "alpha", B: "beta", C: "gamma" },
    });

    // One batch, three keys, ONE of which names a description. The other two
    // are rewritten in the same statement group -- and their descriptions must
    // survive a write that simply did not mention them.
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { A: "1-again", B: "2-again", C: "3-again" },
      descriptions: { B: "beta, revised" },
    });

    expect(await stored()).toEqual({ A: "alpha", B: "beta, revised", C: "gamma" });
  });

  it("an explicit null clears that key's description and only that key's", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { A: "1", B: "2" },
      descriptions: { A: "alpha", B: "beta" },
    });

    // `Description` is nullable, so `null` is the clear. There is no sentinel
    // string, and an empty one would be a description that renders as a blank
    // line rather than as nothing.
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { A: "1-again", B: "2-again" },
      descriptions: { A: null },
    });

    expect(await stored()).toEqual({ A: null, B: "beta" });
  });

  it("a write that mentions no descriptions at all keeps every one of them", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { A: "1", B: "2" },
      descriptions: { A: "alpha", B: "beta" },
    });

    await write({ A: "1-again", B: "2-again" });

    expect(await stored()).toEqual({ A: "alpha", B: "beta" });
  });

  it("leaves the value, its version and its readability exactly where an undescribed write would", async () => {
    await write({ TOKEN: "v1", OTHER: "o1" });

    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { TOKEN: "v2", OTHER: "o2" },
      descriptions: { TOKEN: "rotates quarterly" },
    });

    // ONE new version for each, not two: the description rode along with the
    // value write rather than causing a second one. The AAD binds
    // `(purpose, environment_id, key, version)` and a description is in none of
    // it, so there is nothing here to re-encrypt.
    expect((await listVersions(ctx(), "acme", "prod", "TOKEN")).map((e) => e.version)).toEqual([
      2, 1,
    ]);
    expect((await listVersions(ctx(), "acme", "prod", "OTHER")).map((e) => e.version)).toEqual([
      2, 1,
    ]);

    // And both still decrypt -- under an AAD the description did not widen.
    expect(await exportSecrets(ctx(), "acme", "prod")).toEqual({ TOKEN: "v2", OTHER: "o2" });

    // The environment advanced by exactly one revision, as any single write
    // does. A description is not a second mutation.
    expect((await getEnvironment(ctx(), "acme", "prod")).rev).toBe(2);
  });

  it("carries a description onto a key created and deleted and created again", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { API_KEY: "first" },
      descriptions: { API_KEY: "the first one" },
    });
    await writeSecrets(ctx(), "acme", "prod", { mode: "merge", delete: ["API_KEY"] });

    // The row was deleted, so there is nothing to coalesce onto: the recreated
    // key takes the description this write gave it, and nothing of the old row
    // survives to be inherited.
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      set: { API_KEY: "second" },
      descriptions: { API_KEY: "the second one" },
    });

    expect(await stored()).toEqual({ API_KEY: "the second one" });

    await write({ API_KEY: "third" });
    expect(await stored()).toEqual({ API_KEY: "the second one" });
  });
});

describe("delete and recreate", () => {
  it("CONTINUES the version sequence rather than restarting at 1", async () => {
    // The property `secret_versions` has no foreign key on `key` in order to
    // preserve. Restarting at 1 would collide with the surviving history on
    // `UNIQUE(environment_id, key, version)` and make the key permanently
    // uncreatable -- and, worse, would mean one version number referred to two
    // different values in one environment, which is a number that is inside the
    // AEAD additional data.
    await write({ API_KEY: "first" });
    await writeSecrets(ctx(), "acme", "prod", { mode: "merge", delete: ["API_KEY"] });
    await write({ API_KEY: "second" });

    const versions = await listVersions(ctx(), "acme", "prod", "API_KEY");

    expect(versions.map((entry) => entry.version)).toEqual([3, 2, 1]);
    // v2 is the tombstone: it records that the key ceased to exist, and it
    // occupies the number in between.
    expect(versions.find((entry) => entry.version === 2)).toMatchObject({
      deleted: true,
      op: "delete",
      kid: null,
    });

    await expect(revealSecret(ctx(), "acme", "prod", "API_KEY", "reveal")).resolves.toBe("second");
  });

  it("a tombstone carries no ciphertext and no kid", async () => {
    await write({ GONE: "x" });
    await writeSecrets(ctx(), "acme", "prod", { mode: "merge", delete: ["GONE"] });

    const rows = await db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.key, "GONE"), eq(secretVersions.version, 2)));

    expect(rows[0]).toMatchObject({ ciphertext: null, kid: null, op: "delete" });
  });

  it("deleting an absent key is a no-op, not a 404", async () => {
    await write({ A: "1" });

    const result = await writeSecrets(ctx(), "acme", "prod", {
      mode: "merge",
      delete: ["NEVER_EXISTED"],
    });

    expect(result.removed).toEqual([]);
  });

  it("refuses a key named in both set and delete", async () => {
    const error = await rejectsWith(
      () =>
        writeSecrets(ctx(), "acme", "prod", {
          mode: "merge",
          set: { BOTH: "value" },
          delete: ["BOTH"],
        }),
      "VALIDATION_FAILED",
    );

    // Names the KEY -- plaintext metadata -- and not the value.
    expect(error.message).toContain("BOTH");
    expect(error.message).not.toContain("value");
  });
});

describe("a tampered row is the loudest thing in the system", () => {
  /**
   * Transplant a ciphertext from one environment into another.
   *
   * This is upstream's most serious defect made concrete: with no AAD, the two
   * blobs are interchangeable, and anyone with D1 write access can move a
   * production secret into a dev environment they are allowed to read. Here the
   * AAD binds `(purpose, environment_id, key, version)`, so the transplanted row
   * fails its tag check.
   */
  async function transplant(key: string): Promise<void> {
    const envelope = await encryptSecretValue({
      ringKey: keyring.active,
      // Sealed against the OTHER environment...
      environmentId: otherEnvironmentId,
      key,
      version: 1,
      plaintext: "production-database-password",
    });

    // ...and stored in this one.
    await db
      .update(secretVersions)
      .set({ ciphertext: envelope })
      .where(and(eq(secretVersions.environmentId, environmentId), eq(secretVersions.key, key)));
  }

  it("marks the row unreadable on a list, and audits it with outcome=error", async () => {
    await write({ DATABASE_URL: "real" });
    await transplant("DATABASE_URL");

    const list = await listSecrets(ctx(), "acme", "prod");

    // NOT SKIPPED. The row is present and flagged. Upstream's
    // `catch { /* skip */ }` turned this into a shorter .env file, which is how
    // production gets deployed without its DATABASE_URL.
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "DATABASE_URL", unreadable: true });

    const rows = await db.select().from(auditLog);
    const failure = rows.find((row) => row.action === "secret.list");
    expect(failure?.outcome).toBe("error");
    expect(JSON.parse(failure?.detail ?? "{}")).toMatchObject({
      kind: "secret.unreadable",
      keys: ["DATABASE_URL"],
    });
  });

  it("FAILS the request on a reveal, and audits it", async () => {
    await write({ DATABASE_URL: "real" });
    await transplant("DATABASE_URL");

    const error = await rejectsWith(
      () => revealSecret(ctx(), "acme", "prod", "DATABASE_URL", "reveal"),
      "DECRYPT_FAILED",
    );

    expect(error.status).toBe(500);
    // The message names the ROW so an operator can act, and carries neither
    // plaintext nor ciphertext.
    expect(error.message).toContain("DATABASE_URL");
    expect(error.message).not.toContain("production-database-password");

    const rows = await db.select().from(auditLog);
    expect(rows.find((row) => row.action === "secret.reveal")?.outcome).toBe("error");
  });

  it("FAILS the whole export rather than returning a short one", async () => {
    await write({ A: "1", DATABASE_URL: "real", Z: "26" });
    await transplant("DATABASE_URL");

    await rejectsWith(() => exportSecrets(ctx(), "acme", "prod"), "DECRYPT_FAILED");
  });
});

describe("rollback", () => {
  it("re-encrypts forward instead of resurrecting the old envelope", async () => {
    await write({ TOKEN: "v1" });
    await write({ TOKEN: "v2" });

    const before = await db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.key, "TOKEN"), eq(secretVersions.version, 1)));

    const result = await rollbackSecret(ctx(), "acme", "prod", { key: "TOKEN", to_version: 1 });

    expect(result.version).toBe(3);
    await expect(revealSecret(ctx(), "acme", "prod", "TOKEN", "reveal")).resolves.toBe("v1");

    const after = await db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.key, "TOKEN"), eq(secretVersions.version, 3)));

    // A DIFFERENT envelope. The v1 blob's AAD binds it to version 1, so writing
    // those exact bytes back as version 3 would fail its own tag check on the
    // next read.
    expect(after[0]?.ciphertext).not.toBe(before[0]?.ciphertext);
    expect(after[0]?.op).toBe("rollback");

    // And v1's row is untouched -- history is append-only in both directions.
    const stillThere = await db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.key, "TOKEN"), eq(secretVersions.version, 1)));
    expect(stillThere[0]?.ciphertext).toBe(before[0]?.ciphertext);
  });

  it("refuses to roll back to a tombstone", async () => {
    await write({ TOKEN: "v1" });
    await writeSecrets(ctx(), "acme", "prod", { mode: "merge", delete: ["TOKEN"] });
    await write({ TOKEN: "v3" });

    await rejectsWith(
      () => rollbackSecret(ctx(), "acme", "prod", { key: "TOKEN", to_version: 2 }),
      "VALIDATION_FAILED",
    );
  });
});

describe("rename", () => {
  it("decrypts and re-encrypts under the new key, tombstoning the old one", async () => {
    await write({ OLD_NAME: "secret-value" });

    await renameSecret(ctx(), "acme", "prod", "OLD_NAME", "NEW_NAME");

    await expect(revealSecret(ctx(), "acme", "prod", "NEW_NAME", "reveal")).resolves.toBe(
      "secret-value",
    );

    // There is no cheap rename: the ciphertext is bound to the key NAME, so
    // moving the blob would break the binding that makes cross-key transplant
    // impossible.
    const oldRows = await db
      .select()
      .from(secretVersions)
      .where(eq(secretVersions.key, "OLD_NAME"));

    expect(oldRows.find((row) => row.version === 2)).toMatchObject({
      op: "delete",
      ciphertext: null,
    });

    await rejectsWith(() => revealSecret(ctx(), "acme", "prod", "OLD_NAME", "reveal"), "NOT_FOUND");
  });

  it("continues the DESTINATION key's history, not the source's", async () => {
    // The design note says the new version is `old + 1`, which is only right
    // when the destination has no history. Rename onto a previously-used name
    // and it is not.
    await write({ TARGET: "old-value" });
    await writeSecrets(ctx(), "acme", "prod", { mode: "merge", delete: ["TARGET"] });
    // TARGET now has versions 1 and 2 (a tombstone).

    await write({ SOURCE: "moved" });
    await renameSecret(ctx(), "acme", "prod", "SOURCE", "TARGET");

    const versions = await listVersions(ctx(), "acme", "prod", "TARGET");
    expect(versions[0]?.version).toBe(3);

    await expect(revealSecret(ctx(), "acme", "prod", "TARGET", "reveal")).resolves.toBe("moved");
  });

  it("refuses to rename onto a live key", async () => {
    await write({ A: "1", B: "2" });

    await rejectsWith(() => renameSecret(ctx(), "acme", "prod", "A", "B"), "CONFLICT");
  });
});

describe("import", () => {
  it("dry-runs a .env file and reports names only", async () => {
    await write({ KEEP: "stored-alpha", REPLACED: "stored-beta", DROPPED: "stored-gamma" });

    const result = await importSecrets(ctx(), "acme", "prod", {
      format: "env",
      mode: "replace",
      dry_run: true,
      content: "KEEP=stored-alpha\nREPLACED=incoming-delta\nADDED=incoming-epsilon\n",
    });

    expect(result.applied).toBe(false);
    expect(result.added).toEqual(["ADDED"]);
    expect(result.changed.sort()).toEqual(["KEEP", "REPLACED"]);
    expect(result.removed).toEqual(["DROPPED"]);

    // Nothing was written by the dry run.
    expect(await exportSecrets(ctx(), "acme", "prod")).toEqual({
      KEEP: "stored-alpha",
      REPLACED: "stored-beta",
      DROPPED: "stored-gamma",
    });

    // The diff carries NO values, in either direction. "old vs new" is the
    // shape that leaks two secrets where the naive one leaks one -- and note
    // that KEEP is reported as "changed" even though its value is identical,
    // because establishing that would require decrypting the stored row.
    const serialised = JSON.stringify(result);
    for (const value of [
      "stored-alpha",
      "stored-beta",
      "stored-gamma",
      "incoming-delta",
      "incoming-epsilon",
    ]) {
      expect(serialised).not.toContain(value);
    }
  });

  it("applies when dry_run is false", async () => {
    await importSecrets(ctx(), "acme", "prod", {
      format: "env",
      mode: "replace",
      dry_run: false,
      content: "A=1\nB=2\n",
    });

    expect(await exportSecrets(ctx(), "acme", "prod")).toEqual({ A: "1", B: "2" });
  });

  /**
   * An import and a hand-written batch are the same statements in the same
   * batch, and they must not be the same ROW.
   *
   * "Someone pasted a `.env` over production" and "someone changed one key" are
   * different events to whoever is reading the log after the fact, and until
   * this held they were distinguishable only by whatever `reason` the caller
   * happened to send -- which is to say, not at all when nobody sent one.
   */
  it("audits an applied import as secret.import, in one row", async () => {
    await importSecrets(ctx(), "acme", "prod", {
      format: "env",
      mode: "merge",
      dry_run: false,
      content: 'DATABASE_URL="postgres://user:hunter2@db/app"\n',
      reason: "pasted the staging .env",
    });

    const rows = await db.select().from(auditLog);
    const imports = rows.filter((entry) => entry.action === "secret.import");

    // ONE row, and no `secret.write` beside it: the action was relabelled, not
    // supplemented. A second insert would be a second row for one mutation.
    expect(imports).toHaveLength(1);
    expect(rows.filter((entry) => entry.action === "secret.write")).toHaveLength(0);

    expect(imports[0]?.outcome).toBe("success");
    expect(imports[0]?.environmentId).toBe(environmentId);
    expect(JSON.parse(imports[0]?.detail ?? "{}")).toMatchObject({
      kind: "secret.diff",
      mode: "merge",
      added: ["DATABASE_URL"],
      reason: "pasted the staging .env",
    });

    // The relabelling did not smuggle a value into the row on the way past.
    expect(JSON.stringify(imports[0])).not.toContain("hunter2");
  });

  it("writes no audit row at all for a dry run", async () => {
    await importSecrets(ctx(), "acme", "prod", {
      format: "env",
      mode: "merge",
      dry_run: true,
      content: "A=1\n",
    });

    // A dry run is a read that writes nothing, so there is no mutation for a row
    // to ride in and nothing to record. `secret.import` must not become the
    // action that means "somebody looked at what an import would do".
    const rows = await db.select().from(auditLog);
    expect(rows.filter((entry) => entry.action === "secret.import")).toHaveLength(0);
  });

  it("leaves a hand-written batch as secret.write", async () => {
    await write({ A: "1" });

    const rows = await db.select().from(auditLog);
    expect(rows.filter((entry) => entry.action === "secret.write")).toHaveLength(1);
    expect(rows.filter((entry) => entry.action === "secret.import")).toHaveLength(0);
  });

  it("imports JSON, refusing non-string values by NAME", async () => {
    const error = await rejectsWith(
      () =>
        importSecrets(ctx(), "acme", "prod", {
          format: "json",
          mode: "merge",
          dry_run: false,
          content: '{"PORT": 8080}',
        }),
      "VALIDATION_FAILED",
    );

    expect(error.message).toContain("PORT");
    expect(error.message).not.toContain("8080");
  });

  it("does not quote the content when the JSON is malformed", async () => {
    const error = await rejectsWith(
      () =>
        importSecrets(ctx(), "acme", "prod", {
          format: "json",
          mode: "merge",
          dry_run: false,
          content: '{"TOKEN": "sk-live-secret"',
        }),
      "VALIDATION_FAILED",
    );

    expect(error.message).not.toContain("sk-live-secret");
  });
});

describe("the revision", () => {
  it("advances by exactly one per write, whatever its size", async () => {
    expect((await getEnvironment(ctx(), "acme", "prod")).rev).toBe(0);

    await write({ A: "1" });
    expect((await getEnvironment(ctx(), "acme", "prod")).rev).toBe(1);

    await write({ B: "2", C: "3", D: "4" });
    expect((await getEnvironment(ctx(), "acme", "prod")).rev).toBe(2);
  });
});

describe("what an audit row for a write contains", () => {
  it("names the keys and nothing else", async () => {
    await writeSecrets(ctx(), "acme", "prod", {
      mode: "replace",
      set: { DATABASE_URL: "postgres://user:hunter2@db/app" },
      reason: "rotating credentials",
    });

    const rows = await db.select().from(auditLog);
    const row = rows.find((entry) => entry.action === "secret.write");

    expect(row?.outcome).toBe("success");
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({
      kind: "secret.diff",
      mode: "replace",
      added: ["DATABASE_URL"],
      reason: "rotating credentials",
    });

    // The value appears nowhere in the row -- not in detail, not in
    // target_key, not anywhere.
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });
});
