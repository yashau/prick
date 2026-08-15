import { beforeEach, describe, expect, it } from "vitest";

import {
  exportSecrets,
  listSecrets,
  listVersions,
  writeSecrets,
} from "../../src/lib/server/core/secrets.js";
import type { Keyring } from "../../src/lib/server/crypto/index.js";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import { environments } from "../../src/lib/server/db/schema.js";
import { rejectsWith } from "../auth/rejects.js";
import {
  countingBinding,
  freshDatabase,
  insertVersionRow,
  racingBinding,
  secretsContext,
  seedEnvironment,
  seedGlobalAdmin,
  seedProject,
  snapshotEnvironment,
  testKeyring,
  userActor,
} from "./fixtures.js";

/**
 * THE REGRESSION TEST. This file is the reason the write path is shaped the way
 * it is, and it was written before it.
 *
 * The defect it reproduces, from upstream's `handleSetSecrets`:
 *
 *     await deleteAllSecrets(env)
 *     for (const [key, value] of Object.entries(body)) {
 *       await upsertSecret(env, key, value)     // <- one round-trip each
 *     }
 *
 * Every secret in the environment is deleted, and then they are written back one
 * at a time. A failure on the third of five -- a constraint, a transient D1
 * error, an isolate eviction, anything -- leaves the environment holding two
 * secrets. The other three are GONE: the plaintext was in the request that just
 * failed, the ciphertext has been deleted, and there is no transaction to roll
 * back because there was never a transaction. The caller sees an error and has
 * no way to know what state their production environment is now in.
 *
 * The fix is not "be careful", it is `db.batch()`, which D1 documents as a real
 * transaction: "if a statement in the sequence fails ... it aborts or rolls back
 * the entire sequence."
 *
 * So the property under test is not "the write works". It is: WHEN THE WRITE
 * FAILS, NOTHING HAPPENED.
 */

const ADMIN = "admin@example.com";

let db: Database;
let keyring: Keyring;
let environmentId: string;

beforeEach(async () => {
  db = await freshDatabase();
  keyring = await testKeyring();
  await seedGlobalAdmin(db, ADMIN);
  const projectId = await seedProject(db, "acme");
  environmentId = await seedEnvironment(db, projectId, "prod");
});

/** The five secrets the environment starts with. */
const SEED = {
  KEY_1: "one",
  KEY_2: "two",
  KEY_3: "three",
  KEY_4: "four",
  KEY_5: "five",
};

async function seedFive(): Promise<void> {
  await writeSecrets(secretsContext(db, userActor(ADMIN), keyring), "acme", "prod", {
    mode: "replace",
    set: SEED,
  });
}

describe("a full replace whose 3rd row fails", () => {
  /**
   * HOW THE THIRD ROW IS MADE TO FAIL, and why this particular way.
   *
   * `secret_versions` carries `UNIQUE(environment_id, key, version)` -- the
   * schema's concurrency primitive. A row at `(env, KEY_3, N)` is EXACTLY what a
   * concurrent writer that computed `N` and committed first leaves behind, so
   * this is not a contrived failure: it is the one the constraint exists to
   * produce.
   *
   * THE TIMING IS THE WHOLE TEST. Seeding that row before the request does
   * nothing, because the write path reads `MAX(version)` across the full history
   * and simply plans around a row that is already there -- correctly. The
   * collision only happens if the other writer commits AFTER our read and BEFORE
   * our batch, which is the window `racingBinding` reproduces.
   *
   * The interleaved commit fires on EVERY attempt, so the loss is permanent. The
   * write path retries once, and a single interleaved commit would be defeated
   * by that retry -- which is correct behaviour, and is what "retries once and
   * wins" below asserts. This test needs the failure to stick, so it can observe
   * the rolled-back state.
   *
   * Critically the failure occurs INSIDE the batch, alongside four other row
   * inserts and a revision bump that D1 has to undo. A failure BEFORE the first
   * write -- an oversized value, say -- would prove nothing about atomicity: a
   * delete-then-loop implementation would leave the data intact too, having
   * never reached its delete.
   */
  function racingWriter(): Database {
    let version = 1;

    return createDatabase(
      racingBinding(async () => {
        version += 1;
        await insertVersionRow(db, { environmentId, key: "KEY_3", version });
      }),
    );
  }

  it("leaves the environment with exactly its original 5 secrets, at the original rev, and writes no audit row", async () => {
    await seedFive();

    const before = await snapshotEnvironment(db, environmentId);

    // Sanity: the fixture is what the test claims it is.
    expect(Object.keys(before.secrets).sort()).toEqual([
      "KEY_1",
      "KEY_2",
      "KEY_3",
      "KEY_4",
      "KEY_5",
    ]);
    expect(before.rev).toBe(1);

    const ctx = secretsContext(racingWriter(), userActor(ADMIN), keyring);

    await rejectsWith(
      () =>
        writeSecrets(ctx, "acme", "prod", {
          mode: "replace",
          set: {
            KEY_1: "replaced-one",
            KEY_2: "replaced-two",
            KEY_3: "replaced-three",
            KEY_4: "replaced-four",
            KEY_5: "replaced-five",
          },
        }),
      "VERSION_CONFLICT",
    );

    const after = await snapshotEnvironment(db, environmentId);

    // 1. Exactly the original five keys, still live.
    expect(Object.keys(after.secrets).sort()).toEqual([
      "KEY_1",
      "KEY_2",
      "KEY_3",
      "KEY_4",
      "KEY_5",
    ]);

    // 2. Each still pointing at its ORIGINAL version. A partially applied write
    //    would have advanced some of them.
    expect(after.secrets).toEqual(before.secrets);

    // 3. The revision is untouched, so a client holding `expected_rev` from
    //    before this request still holds a valid one.
    expect(after.rev).toBe(before.rev);

    // 4. NO AUDIT ROW. The audit insert is the last statement of the batch, so a
    //    row here would mean the batch had partially committed -- the audit log
    //    asserting that a write happened which did not.
    expect(after.auditRows).toBe(before.auditRows);

    // 5. No half-written history: not one of the five version INSERTs survived.
    //    (The other writer's rows are excluded from this count -- they are the
    //    simulated second request, not ours.)
    expect(after.versionRows).toBe(before.versionRows);
  });

  it("still reveals the ORIGINAL values afterwards", async () => {
    await seedFive();

    const ctx = secretsContext(racingWriter(), userActor(ADMIN), keyring);

    await rejectsWith(
      () =>
        writeSecrets(ctx, "acme", "prod", {
          mode: "replace",
          set: { KEY_1: "replaced", KEY_2: "replaced", KEY_3: "replaced" },
        }),
      "VERSION_CONFLICT",
    );

    // Row counts being unchanged is necessary but not sufficient: the values
    // themselves have to still decrypt, under their ORIGINAL AAD. A write that
    // rolled back the `secrets` rows but not `secret_versions` would leave
    // `current_version` pointing at a ciphertext sealed for a different version,
    // and every read would fail its tag check.
    const values = await exportSecrets(
      secretsContext(db, userActor(ADMIN), keyring),
      "acme",
      "prod",
    );

    expect(values).toEqual(SEED);
  });
});

describe("the write is ONE batch", () => {
  /**
   * The structural half of the guarantee.
   *
   * Chunking to D1's 100-bound-parameter ceiling produces MANY statements, and
   * the tempting mistake is to send them as several `batch()` calls -- which
   * would pass every assertion above (all the data arrives) while quietly
   * reintroducing exactly the defect: a failure in the second batch leaves the
   * first committed.
   *
   * That cannot be observed from the data, so it is observed from the binding.
   */
  it("issues exactly one batch() for a 40-key write, despite chunking", async () => {
    const counter = countingBinding();
    const countedDb = createDatabase(counter.binding);

    const set: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) set[`KEY_${String(i)}`] = `value-${String(i)}`;

    counter.reset();

    await writeSecrets(secretsContext(countedDb, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "replace",
      set,
    });

    expect(counter.batches()).toBe(1);

    // And all the data landed: 40 keys across 4 version-INSERT chunks (11 rows
    // each) and 4 secrets-upsert chunks (12 rows each).
    const snapshot = await snapshotEnvironment(db, environmentId);
    expect(Object.keys(snapshot.secrets)).toHaveLength(40);
  });

  /**
   * Descriptions DOUBLE the number of upsert statement groups, and that is the
   * whole hazard.
   *
   * One `onConflictDoUpdate` applies one `SET` expression to every row in its
   * statement, so "overwrite this description" and "keep that one" cannot share
   * a statement -- the described rows and the undescribed rows are chunked
   * separately. Two groups is two obvious places to put a `batch()`, and doing
   * so would pass every assertion about the DATA while making a description
   * write commit whose value write rolled back.
   *
   * The mix is deliberately uneven and larger than one chunk on both sides, so
   * both groups really are chunked rather than being one statement each.
   */
  it("issues exactly one batch() when descriptions split the upsert into two groups", async () => {
    const counter = countingBinding();
    const countedDb = createDatabase(counter.binding);

    const set: Record<string, string> = {};
    const descriptions: Record<string, string | null> = {};
    for (let i = 0; i < 40; i += 1) {
      const key = `KEY_${String(i)}`;
      set[key] = `value-${String(i)}`;
      // 15 described (2 chunks of 12 + 3), 25 not (12 + 12 + 1).
      if (i < 15) descriptions[key] = `described ${String(i)}`;
    }

    counter.reset();

    await writeSecrets(secretsContext(countedDb, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "replace",
      set,
      descriptions,
    });

    expect(counter.batches()).toBe(1);

    // Both groups landed, and each carries its own clause: the described half
    // has its text, the other half has `null` rather than somebody else's.
    const entries = await listSecrets(
      secretsContext(db, userActor(ADMIN), keyring),
      "acme",
      "prod",
    );
    expect(entries).toHaveLength(40);
    expect(entries.filter((entry) => entry.description !== null)).toHaveLength(15);
    expect(entries.find((entry) => entry.key === "KEY_0")?.description).toBe("described 0");
    expect(entries.find((entry) => entry.key === "KEY_39")?.description).toBeNull();
  });

  it("stays one batch at 250 keys, where chunking produces ~45 statements", async () => {
    const counter = countingBinding();
    const countedDb = createDatabase(counter.binding);

    const set: Record<string, string> = {};
    for (let i = 0; i < 250; i += 1) set[`K${String(i)}`] = `v${String(i)}`;

    counter.reset();

    await writeSecrets(secretsContext(countedDb, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "replace",
      set,
    });

    expect(counter.batches()).toBe(1);

    const snapshot = await snapshotEnvironment(db, environmentId);
    expect(Object.keys(snapshot.secrets)).toHaveLength(250);
    expect(snapshot.rev).toBe(1);
  });
});

describe("optimistic concurrency -- both branches", () => {
  it("applies the write when expected_rev matches", async () => {
    await seedFive();

    const ctx = secretsContext(db, userActor(ADMIN), keyring);

    const result = await writeSecrets(ctx, "acme", "prod", {
      mode: "replace",
      set: { KEY_1: "next" },
      expected_rev: 1,
    });

    expect(result.rev).toBe(2);

    const after = await snapshotEnvironment(db, environmentId);
    expect(Object.keys(after.secrets)).toEqual(["KEY_1"]);
    expect(after.rev).toBe(2);
  });

  it("aborts with PRECONDITION_FAILED when expected_rev is stale, and changes nothing", async () => {
    await seedFive();

    const before = await snapshotEnvironment(db, environmentId);
    const ctx = secretsContext(db, userActor(ADMIN), keyring);

    const error = await rejectsWith(
      () =>
        writeSecrets(ctx, "acme", "prod", {
          mode: "replace",
          set: { KEY_1: "next" },
          // The environment is at rev 1 after the seed write.
          expected_rev: 0,
        }),
      "PRECONDITION_FAILED",
    );

    expect(error.status).toBe(412);

    const after = await snapshotEnvironment(db, environmentId);
    expect(after).toEqual(before);
  });

  it("the guard is a no-op, not an insert, when the revision matches", async () => {
    await seedFive();

    // The guard is an `INSERT ... SELECT` into `environments`. If its WHERE
    // clause were inverted it would insert a duplicate row on the HAPPY path
    // instead of aborting on the unhappy one -- and that failure would be
    // silent, because a second environment row only surfaces much later.
    await writeSecrets(secretsContext(db, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "merge",
      set: { KEY_6: "six" },
      expected_rev: 1,
    });

    const rows = await db.select().from(environments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rev).toBe(2);
  });
});

describe("per-key version races", () => {
  it("retries once and wins, leaving NO GAP in the version history", async () => {
    await writeSecrets(secretsContext(db, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "merge",
      set: { TOKEN: "v1" },
    });

    // One interleaved commit, on the first attempt only: the other writer takes
    // version 2 in the window between our read and our batch.
    const racing = createDatabase(
      racingBinding(async (attempt) => {
        if (attempt === 1) {
          await insertVersionRow(db, { environmentId, key: "TOKEN", version: 2 });
        }
      }),
    );

    const result = await writeSecrets(
      secretsContext(racing, userActor(ADMIN), keyring),
      "acme",
      "prod",
      { mode: "merge", set: { TOKEN: "v3" } },
    );

    expect(result.changed).toEqual(["TOKEN"]);

    const versions = await listVersions(
      secretsContext(db, userActor(ADMIN), keyring),
      "acme",
      "prod",
      "TOKEN",
    );

    // 3, 2, 1 -- consecutive. A gap would mean the retry had skipped a number,
    // and a skipped number is a hole in the AAD version space that a later
    // rollback would try to address.
    expect(versions.map((entry) => entry.version)).toEqual([3, 2, 1]);

    // The retry is recorded, so an operator reading the log can tell a contended
    // environment from a quiet one.
    const audit = await db.query.auditLog.findMany();
    const write = audit.filter((row) => row.action === "secret.write").at(-1);
    expect(JSON.parse(write?.detail ?? "{}")).toMatchObject({ retried: true });
  });

  it("gives up with VERSION_CONFLICT after losing twice, having written nothing", async () => {
    await writeSecrets(secretsContext(db, userActor(ADMIN), keyring), "acme", "prod", {
      mode: "merge",
      set: { TOKEN: "v1" },
    });

    const before = await snapshotEnvironment(db, environmentId);

    let version = 1;
    const racing = createDatabase(
      racingBinding(async () => {
        version += 1;
        await insertVersionRow(db, { environmentId, key: "TOKEN", version });
      }),
    );

    await rejectsWith(
      () =>
        writeSecrets(secretsContext(racing, userActor(ADMIN), keyring), "acme", "prod", {
          mode: "merge",
          set: { TOKEN: "v4" },
        }),
      "VERSION_CONFLICT",
    );

    const after = await snapshotEnvironment(db, environmentId);
    expect(after).toEqual(before);
  });
});

describe("the size cap", () => {
  it("refuses a write that would exceed ENV_MAX_SECRETS rather than splitting the batch", async () => {
    const base = secretsContext(db, userActor(ADMIN), keyring);
    const ctx = secretsContext(db, userActor(ADMIN), keyring, {
      config: { ...base.config, envMaxSecrets: 3 },
    });

    const error = await rejectsWith(
      () =>
        writeSecrets(ctx, "acme", "prod", {
          mode: "replace",
          set: { A: "1", B: "2", C: "3", D: "4" },
        }),
      "PAYLOAD_TOO_LARGE",
    );

    expect(error.status).toBe(413);

    // Nothing was written -- in particular nothing for the first three keys.
    // The refusal happens before the batch is built, let alone sent.
    const after = await snapshotEnvironment(db, environmentId);
    expect(after.secrets).toEqual({});
    expect(after.auditRows).toBe(0);
  });

  it("counts the RESULTING size, not the request size", async () => {
    const base = secretsContext(db, userActor(ADMIN), keyring);
    const ctx = secretsContext(db, userActor(ADMIN), keyring, {
      config: { ...base.config, envMaxSecrets: 3 },
    });

    await writeSecrets(ctx, "acme", "prod", { mode: "merge", set: { A: "1", B: "2" } });

    // Two more would make four. A merge does not remove what it does not
    // mention, so the resulting size is what the cap applies to.
    await rejectsWith(
      () => writeSecrets(ctx, "acme", "prod", { mode: "merge", set: { C: "3", D: "4" } }),
      "PAYLOAD_TOO_LARGE",
    );

    // The same two keys as a REPLACE fit, because the replace removes A and B.
    await writeSecrets(ctx, "acme", "prod", { mode: "replace", set: { C: "3", D: "4" } });

    const after = await snapshotEnvironment(db, environmentId);
    expect(Object.keys(after.secrets).sort()).toEqual(["C", "D"]);
  });
});
