import { env } from "cloudflare:test";

import type { Actor, CoreContext, RuntimeConfig } from "../../src/lib/server/core/context.js";
import { buildKeyring, type Keyring } from "../../src/lib/server/crypto/index.js";
import type { Database } from "../../src/lib/server/db/client.js";
import { uuidv7 } from "../../src/lib/server/db/ids.js";
import { auditLog, environments, secrets, secretVersions } from "../../src/lib/server/db/schema.js";
import {
  NOW,
  freshDatabase,
  seedEnvironment,
  seedGrant,
  seedIdentity,
  seedProject,
  testConfig,
  userActor,
} from "../auth/fixtures.js";

/**
 * Fixtures for the `core` suites.
 *
 * Built ON TOP of `test/auth/fixtures.ts` rather than beside it. Two copies of
 * "migrate, then truncate in foreign-key order" would drift the moment a table
 * is added, and the first symptom would be a `core` test failing because an
 * `auth` test left a row behind.
 *
 * What is added here is the part `auth` has no use for: a real keyring, and
 * contexts that carry it.
 */

export {
  NOW,
  freshDatabase,
  seedEnvironment,
  seedGrant,
  seedIdentity,
  seedProject,
  testConfig,
  userActor,
};

/**
 * A deterministic 32-byte master key.
 *
 * Deterministic so a ciphertext produced in one test can be handed to another,
 * and 32 bytes because anything else is refused at parse time -- which is the
 * behaviour `test/http/keyring.test.ts` exercises on purpose.
 */
export const TEST_MASTER_KEY = bytesToBase64(new Uint8Array(32).map((_, index) => index));

/** A second, distinct key, for rotation and unknown-kid cases. */
export const TEST_MASTER_KEY_OLD = bytesToBase64(new Uint8Array(32).map((_, index) => 255 - index));

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let cachedKeyring: Keyring | null = null;

/** The ring every `core` test writes under. Memoised; derivation is not free. */
export async function testKeyring(): Promise<Keyring> {
  cachedKeyring ??= await buildKeyring({ active: TEST_MASTER_KEY, retired: [] });
  return cachedKeyring;
}

/**
 * A request context that can encrypt.
 *
 * A FRESH OBJECT per call, because the authorization snapshot is cached against
 * this exact reference -- reusing one across "requests" would hide every caching
 * bug the cache exists to be tested for, and would also let one test's grant
 * resolution leak into the next.
 */
export function secretsContext(
  db: Database,
  actor: Actor,
  keyring: Keyring,
  overrides: Partial<Omit<CoreContext, "db" | "actor">> = {},
): CoreContext {
  return {
    db,
    actor,
    requestId: `req-${crypto.randomUUID()}`,
    now: NOW,
    config: testConfig() as RuntimeConfig,
    keyring,
    ...overrides,
  };
}

/**
 * A D1 binding that counts `batch()` calls as well as `prepare()` calls.
 *
 * The batch counter is the one that matters, and it is the mechanical form of
 * the rule this whole module exists to enforce: "never split a bulk write across
 * multiple `batch()` calls". A 200-key write that issued four batches would pass
 * every functional assertion in the suite -- the data would all be there -- and
 * would have silently given up atomicity. Only counting catches it.
 */
export interface CountingBinding {
  binding: D1Database;
  batches(): number;
  statements(): number;
  reset(): void;
}

export function countingBinding(inner: D1Database = env.DB): CountingBinding {
  let batches = 0;
  let statements = 0;

  const binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "batch") {
        return (queries: D1PreparedStatement[]) => {
          batches += 1;
          return target.batch(queries);
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          statements += 1;
          return target.prepare(query);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  return {
    binding,
    batches: () => batches,
    statements: () => statements,
    reset: () => {
      batches = 0;
      statements = 0;
    },
  };
}

/**
 * A binding that lets another writer commit BETWEEN our read and our batch.
 *
 * This is the only honest way to test the version race. Seeding a colliding row
 * up front does not do it: the write path reads `MAX(version)` over the whole
 * history, so a row that is already there is simply part of the state it plans
 * against, and no collision occurs -- correctly.
 *
 * The race that the `UNIQUE(environment_id, key, version)` index exists to catch
 * is narrower than that: two writers read the SAME state, both compute `N+1`,
 * and one commits while the other is still assembling its batch. `onBatch` fires
 * immediately before each `batch()` reaches D1, which is exactly that window,
 * and receives the attempt number so a test can decide whether the loser wins
 * its retry or loses again.
 */
export function racingBinding(
  onBatch: (attempt: number) => Promise<void>,
  inner: D1Database = env.DB,
): D1Database {
  let attempt = 0;

  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (queries: D1PreparedStatement[]) => {
          attempt += 1;
          await onBatch(attempt);
          return target.batch(queries);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** A global admin, which is what most `core` tests want to act as. */
export async function seedGlobalAdmin(db: Database, subject: string): Promise<string> {
  const identityId = await seedIdentity(db, { kind: "user", subject });
  await seedGrant(db, { identityId, role: "admin", scopeType: "global" });
  return identityId;
}

// ---------------------------------------------------------------------------
// Direct row seeding -- deliberately bypassing the write path
// ---------------------------------------------------------------------------

/**
 * Insert a `secret_versions` row directly.
 *
 * This is how a CONCURRENT WRITER is simulated. A row at
 * `(environment, key, N)` is exactly what another request that computed `N` and
 * committed first leaves behind, and it is what makes the loser's INSERT trip
 * `secret_versions_env_key_version_uniq` -- the schema's concurrency primitive.
 *
 * It is also how a TAMPERED row is simulated, by writing a ciphertext that was
 * sealed against a different identity.
 */
/** `created_by` on rows written by a simulated racing writer. */
export const CONCURRENT_WRITER = "concurrent-writer";

export async function insertVersionRow(
  db: Database,
  row: {
    environmentId: string;
    key: string;
    version: number;
    ciphertext?: string | null;
    kid?: string | null;
    op?: string;
  },
): Promise<void> {
  await db.insert(secretVersions).values({
    id: uuidv7(NOW),
    environmentId: row.environmentId,
    key: row.key,
    version: row.version,
    ciphertext: row.ciphertext ?? null,
    kid: row.kid ?? null,
    op: row.op ?? "set",
    createdAt: NOW,
    createdBy: CONCURRENT_WRITER,
  });
}

// ---------------------------------------------------------------------------
// Assertions about state
// ---------------------------------------------------------------------------

export interface EnvironmentSnapshot {
  rev: number;
  /** key -> current version, sorted by key. */
  secrets: Record<string, number>;
  auditRows: number;
  versionRows: number;
}

/**
 * Everything the atomicity test needs to compare before and after.
 *
 * One function so that "unchanged" means the same set of facts each time it is
 * asserted, rather than whichever three the test author happened to check.
 */
export async function snapshotEnvironment(
  db: Database,
  environmentId: string,
): Promise<EnvironmentSnapshot> {
  const envRows = await db.select().from(environments);
  const secretRows = await db.select().from(secrets);
  const auditRows = await db.select().from(auditLog);
  const versionRows = await db.select().from(secretVersions);

  const live: Record<string, number> = {};
  for (const row of secretRows) {
    if (row.environmentId === environmentId) live[row.key] = row.currentVersion;
  }

  return {
    rev: envRows.find((row) => row.id === environmentId)?.rev ?? -1,
    secrets: live,
    auditRows: auditRows.length,
    // Rows written by the SIMULATED OTHER WRITER are excluded. They are the
    // second request in a race, not part of the state under test, and counting
    // them would make "nothing of ours survived" indistinguishable from
    // "nothing happened at all".
    versionRows: versionRows.filter(
      (row) => row.environmentId === environmentId && row.createdBy !== CONCURRENT_WRITER,
    ).length,
  };
}
