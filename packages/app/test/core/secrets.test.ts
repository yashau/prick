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
