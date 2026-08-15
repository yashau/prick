import type { BatchBody, ImportBody, RollbackBody } from "@prick/shared";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  decryptSecretValue,
  encryptSecretValue,
  type Keyring,
} from "../crypto/index.js";
import { uuidv7 } from "../db/ids.js";
import {
  environments,
  secrets,
  secretVersions,
  type Environment,
  type NewSecret,
  type NewSecretVersion,
} from "../db/schema.js";
import { auditStatement, recordAudit } from "./audit.js";
import { requireKeyring, type CoreContext } from "./context.js";
import { environmentScope, requireEnvironment } from "./environments.js";
import { classifyD1Constraint, PrickError, toPrickError } from "./errors.js";
import { assertRole } from "./guards.js";
import { parseDotenv } from "./dotenv.js";
import { chunk, rowsPerChunk, runBatch, type Statement } from "./sql.js";

/**
 * A secret as it appears in a LIST. There is no value here, and there must
 * never be one -- this is what the SSR-rendered screens and the audit views
 * consume.
 */
export interface SecretListEntry {
  key: string;
  description: string | null;
  version: number;
  updatedAt: number;
  updatedBy: string;
  /** The master key id the current version is sealed under. Not secret. */
  kid: string | null;
  /**
   * `true` when the stored envelope failed to decrypt or failed its AEAD tag.
   *
   * NOT swallowed, NOT skipped. A catch-and-continue around decryption turns a
   * tamper attempt into a QUIETLY SHORTER .env file -- which is how you deploy
   * production without DATABASE_URL and find out from an outage. Here the row
   * is returned marked unreadable, the UI renders it red, and the read is
   * audited with `outcome: 'error'`.
   */
  unreadable: boolean;
}

export interface WriteSecretsResult {
  /** The environment's revision AFTER the write. */
  rev: number;
  added: string[];
  changed: string[];
  removed: string[];
}

// ---------------------------------------------------------------------------
// Column arithmetic -- derived from the schema, never written down
// ---------------------------------------------------------------------------

/**
 * id, environment_id, key, version, ciphertext, kid, op, created_at, created_by
 *
 * NINE. `floor(100/9) = 11` rows per INSERT, 99 bound parameters.
 */
const SECRET_VERSION_COLUMNS = 9;

/**
 * id, environment_id, key, current_version, description, created_at,
 * updated_at, updated_by
 *
 * EIGHT, not the ten the design note claimed. `floor(100/8) = 12` rows per
 * upsert, 96 bound parameters. The `ON CONFLICT ... DO UPDATE SET x =
 * excluded.x` clause binds NOTHING -- that is why it reads from `excluded`
 * rather than repeating the values, which would halve the chunk size.
 */
const SECRET_COLUMNS = 8;

const VERSION_ROWS_PER_STATEMENT = rowsPerChunk(SECRET_VERSION_COLUMNS);
const SECRET_ROWS_PER_STATEMENT = rowsPerChunk(SECRET_COLUMNS);

/** `DELETE ... WHERE environment_id = ? AND key IN (...)` spends one first. */
const DELETE_KEYS_PER_STATEMENT = rowsPerChunk(1, 1);

// ---------------------------------------------------------------------------
// The one read
// ---------------------------------------------------------------------------

interface KeyState {
  /** Highest version ever issued for this key, INCLUDING tombstones. */
  maxVersion: number;
  /** Whether a live `secrets` row exists. A tombstoned key is not live. */
  live: boolean;
}

/**
 * ONE query for the entire prior state of an environment's keys.
 *
 * It serves four purposes simultaneously, which is why it is one query and not
 * four:
 *
 *   the AAD version numbers   nextVersion = maxVersion + 1
 *   the delete set            every live key not named in a full replace
 *   the audit diff            added / changed / removed
 *   the write plan            which keys are inserts and which are updates
 *
 * (The fifth thing the design note attributed to it, the `expected_rev` check,
 * comes from the environment row that resolving the slug pair already loaded.
 * It is not a separate read either.)
 *
 * THE UNION IS LOAD-BEARING, and the design note's `SELECT key, version, kid
 * FROM secrets` is not sufficient for two independent reasons:
 *
 *   1. `secrets` HAS NO `kid` COLUMN. The key id lives on `secret_versions`,
 *      deliberately -- it belongs to a version, not to a key, and that is what
 *      makes rekeying a version-preserving operation.
 *
 *   2. Reading only `secrets` misses DELETED keys entirely, and their history is
 *      still there. `secret_versions` has no foreign key on `key` precisely so
 *      that deleting `API_TOKEN` and recreating it CONTINUES the version
 *      sequence. Computing `nextVersion` from the live table alone would issue
 *      version 1 for the recreated key, collide with the surviving history on
 *      `UNIQUE(environment_id, key, version)`, and abort the batch -- forever,
 *      since the retry recomputes the same 1. The key would be permanently
 *      uncreatable, and the error would say "version conflict", which is true
 *      and useless.
 *
 * So the state comes from the union of both tables, aggregated once.
 */
async function readKeyState(
  ctx: CoreContext,
  environmentId: string,
): Promise<Map<string, KeyState>> {
  const rows = await ctx.db.all<{ key: string; max_version: number; live: number }>(sql`
    SELECT key, MAX(version) AS max_version, MAX(live) AS live
    FROM (
      SELECT key, version, 0 AS live
        FROM secret_versions WHERE environment_id = ${environmentId}
      UNION ALL
      SELECT key, current_version AS version, 1 AS live
        FROM secrets WHERE environment_id = ${environmentId}
    )
    GROUP BY key
  `);

  const state = new Map<string, KeyState>();
  for (const row of rows) {
    state.set(row.key, { maxVersion: Number(row.max_version), live: Number(row.live) === 1 });
  }

  return state;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/**
 * `rev = rev + 1`, as a statement for a batch.
 *
 * A query BUILDER rather than `db.run(sql`...`)`, and not by preference:
 * drizzle 0.45's D1 batch implementation reaches for `preparedQuery.stmt` on
 * every statement that carries bound parameters, and a raw `SQLiteRaw` has no
 * `.stmt`. A parameterised raw statement in a batch therefore fails with
 * `Cannot read properties of undefined (reading 'bind')` -- at runtime, from
 * inside drizzle, with nothing in the type system to warn you.
 *
 * The alternative -- interpolating the values into the SQL text with
 * `sql.raw()` -- would make every id and timestamp in this module a string
 * concatenation. In a secrets manager that is not a trade worth considering.
 */
function bumpRevision(ctx: CoreContext, environmentId: string): Statement {
  return ctx.db
    .update(environments)
    .set({ rev: sql`${environments.rev} + 1`, updatedAt: ctx.now })
    .where(eq(environments.id, environmentId));
}

interface WritePlan {
  sets: { key: string; value: string; version: number; existed: boolean }[];
  deletes: { key: string; version: number }[];
  added: string[];
  changed: string[];
  removed: string[];
}

function planWrite(
  input: BatchBody,
  state: Map<string, KeyState>,
  maxSecrets: number,
): WritePlan {
  const set = input.set ?? {};
  const setKeys = Object.keys(set);
  const explicitDeletes = input.delete ?? [];

  const overlap = setKeys.filter((key) => explicitDeletes.includes(key));
  if (overlap.length > 0) {
    // Named in both `set` and `delete`. There is no defensible resolution: one
    // order stores the value, the other tombstones it, and the request does not
    // say which was meant. Refusing names the KEYS -- plaintext metadata -- and
    // never touches the values.
    throw new PrickError(
      "VALIDATION_FAILED",
      `These keys appear in both "set" and "delete": ${overlap.join(", ")}.`,
      { hint: "A single batch cannot both write and remove the same key." },
    );
  }

  const liveKeys = [...state.entries()]
    .filter(([, value]) => value.live)
    .map(([key]) => key);

  const deleteKeys =
    input.mode === "replace"
      ? liveKeys.filter((key) => !Object.hasOwn(set, key))
      : explicitDeletes.filter((key) => state.get(key)?.live === true);

  // A merge that names an absent key in `delete` is a NO-OP, not a 404. The
  // caller asked for that key to be gone and it is gone; reporting failure for
  // an already-satisfied request makes `.env`-driven workflows non-idempotent
  // for no benefit. It simply does not appear in `removed`.

  const survivors = new Set(liveKeys);
  for (const key of deleteKeys) survivors.delete(key);
  for (const key of setKeys) survivors.add(key);

  if (survivors.size > maxSecrets) {
    throw new PrickError(
      "PAYLOAD_TOO_LARGE",
      `This write would leave ${String(survivors.size)} secrets in the environment; the limit is ${String(maxSecrets)}.`,
      {
        hint: "The cap exists because a full replace must fit in ONE D1 batch -- splitting it across batches would forfeit atomicity, so the write is refused rather than made non-atomic.",
        detail: { limit: maxSecrets, requested: survivors.size },
      },
    );
  }

  const sets = Object.entries(set).map(([key, value]) => {
    const existing = state.get(key);
    return {
      key,
      value,
      // maxVersion, NOT the live current_version: a key that was deleted and is
      // being recreated continues its old sequence, because its tombstone still
      // occupies the number in between.
      version: (existing?.maxVersion ?? 0) + 1,
      existed: existing?.live === true,
    };
  });

  const deletes = deleteKeys.map((key) => ({
    key,
    version: (state.get(key)?.maxVersion ?? 0) + 1,
  }));

  return {
    sets,
    deletes,
    added: sets.filter((entry) => !entry.existed).map((entry) => entry.key),
    changed: sets.filter((entry) => entry.existed).map((entry) => entry.key),
    removed: deletes.map((entry) => entry.key),
  };
}

/**
 * Encrypt every value in the plan.
 *
 * A NEW ENCRYPTION PER VERSION, ALWAYS. There is no path here that copies an
 * existing ciphertext blob forward, because the AAD binds the blob to
 * `(purpose, environment_id, key, version)` and the version has just changed --
 * a copied blob would fail its tag check on the next read, or, if the AAD were
 * "helpfully" widened to make copying work, would stop preventing the
 * cross-version replay it exists to prevent.
 *
 * Sealed under `keyring.active` and nothing else. Writing under a retired key
 * would be creating fresh work for the next rekey.
 */
async function sealValues(
  ctx: CoreContext,
  keyring: Keyring,
  environmentId: string,
  plan: WritePlan,
): Promise<Map<string, string>> {
  const sealed = new Map<string, string>();

  for (const entry of plan.sets) {
    const envelope = await encryptSecretValue({
      // ONE object carrying both the DEK and the kid that names it. The pair
      // cannot disagree, so a row cannot name a key that did not seal it.
      ringKey: keyring.active,
      environmentId,
      key: entry.key,
      version: entry.version,
      plaintext: entry.value,
      maxBytes: ctx.config.secretMaxBytes,
    });

    sealed.set(entry.key, envelope);
  }

  return sealed;
}

/**
 * Assemble the statements. ONE batch, in this order, no exceptions.
 *
 *   1. the optimistic-concurrency guard (only when `expected_rev` was sent)
 *   2. UPDATE environments SET rev = rev + 1
 *   3. multi-row INSERT into secret_versions        (11 rows per statement)
 *   4. multi-row upsert into secrets                (12 rows per statement)
 *   5. tombstone rows into secret_versions          (11 rows per statement)
 *   6. DELETE FROM secrets WHERE key IN (...)       (99 keys per statement)
 *   7. INSERT INTO audit_log                        <- LAST
 *
 * Every chunk is an element of the SAME array. Chunking is about the
 * hundred-parameter ceiling on one QUERY; it has nothing to do with how many
 * queries a batch may hold, and splitting these across two `batch()` calls to
 * "be safe" would trade the ceiling for the loss of atomicity that this entire
 * module exists to prevent.
 */
function buildStatements(
  ctx: CoreContext,
  environment: Environment,
  input: BatchBody,
  plan: WritePlan,
  sealed: Map<string, string>,
  activeKid: string,
  retried: boolean,
): Statement[] {
  const statements: Statement[] = [];

  /*
   * THE OPTIMISTIC-CONCURRENCY GUARD.
   *
   * `UPDATE environments SET ... WHERE rev = ?` DOES NOT WORK, and the reason is
   * subtle enough to be worth stating in the code rather than in a commit
   * message: D1 rolls a batch back when a statement ERRORS, not when it changes
   * zero rows. A non-matching UPDATE is a perfectly successful statement that
   * happened to affect nothing, so the batch would sail past the guard and
   * commit the write it was supposed to prevent.
   *
   * What works is a deliberate constraint violation. This INSERT ... SELECT
   * selects zero rows when the revision matches (a no-op) and exactly one when
   * it does not -- and that one row collides with the primary key it was just
   * read from, which is an ERROR, which aborts the whole batch. The guard's
   * failure mode IS the rollback.
   *
   * The column list is written out on both sides rather than `SELECT *` because
   * an `INSERT INTO t SELECT * FROM t` silently depends on column ORDER, and a
   * future migration that adds a column in the middle would turn this from a
   * guard into a corruption.
   */
  const expectedRev = input.expected_rev;

  if (expectedRev !== undefined) {
    statements.push(
      ctx.db.insert(environments).select((qb) =>
        qb
          // The projection is written out column by column, in the table's
          // declaration order, and NOT as `select *`. Drizzle emits the insert
          // column list from the schema, so an `INSERT INTO t (a,b,c) SELECT *
          // FROM t` would silently depend on the two orders agreeing -- and a
          // migration that adds a column in the middle would turn this guard
          // into a corruption that still typechecks.
          .select({
            id: environments.id,
            projectId: environments.projectId,
            slug: environments.slug,
            name: environments.name,
            description: environments.description,
            rev: environments.rev,
            createdAt: environments.createdAt,
            updatedAt: environments.updatedAt,
            createdBy: environments.createdBy,
          })
          .from(environments)
          .where(and(eq(environments.id, environment.id), ne(environments.rev, expectedRev))),
      ),
    );
  }

  statements.push(
    ctx.db
      .update(environments)
      .set({ rev: sql`${environments.rev} + 1`, updatedAt: ctx.now })
      .where(eq(environments.id, environment.id)),
  );

  const versionRows: NewSecretVersion[] = plan.sets.map((entry) => ({
    id: uuidv7(ctx.now),
    environmentId: environment.id,
    key: entry.key,
    version: entry.version,
    ciphertext: sealed.get(entry.key) ?? null,
    kid: activeKid,
    op: "set",
    createdAt: ctx.now,
    createdBy: ctx.actor.subject,
  }));

  for (const rows of chunk(versionRows, VERSION_ROWS_PER_STATEMENT)) {
    statements.push(ctx.db.insert(secretVersions).values(rows));
  }

  const secretRows: NewSecret[] = plan.sets.map((entry) => ({
    id: uuidv7(ctx.now),
    environmentId: environment.id,
    key: entry.key,
    currentVersion: entry.version,
    description: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    updatedBy: ctx.actor.subject,
  }));

  for (const rows of chunk(secretRows, SECRET_ROWS_PER_STATEMENT)) {
    statements.push(
      ctx.db
        .insert(secrets)
        .values(rows)
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: {
            currentVersion: sql`excluded.current_version`,
            // COALESCE, not overwrite: this write path carries no description,
            // and a batch that silently cleared every description because it
            // did not mention them would be indistinguishable from one that
            // meant to.
            description: sql`coalesce(excluded.description, ${secrets.description})`,
            updatedAt: sql`excluded.updated_at`,
            updatedBy: sql`excluded.updated_by`,
          },
        }),
    );
  }

  const tombstones: NewSecretVersion[] = plan.deletes.map((entry) => ({
    id: uuidv7(ctx.now),
    environmentId: environment.id,
    key: entry.key,
    version: entry.version,
    // A tombstone records that the key CEASED TO EXIST at this version. It
    // carries no ciphertext and no kid, and it occupies a version number, which
    // is what makes delete-then-recreate continue the sequence.
    ciphertext: null,
    kid: null,
    op: "delete",
    createdAt: ctx.now,
    createdBy: ctx.actor.subject,
  }));

  for (const rows of chunk(tombstones, VERSION_ROWS_PER_STATEMENT)) {
    statements.push(ctx.db.insert(secretVersions).values(rows));
  }

  for (const keys of chunk(
    plan.deletes.map((entry) => entry.key),
    DELETE_KEYS_PER_STATEMENT,
  )) {
    statements.push(
      ctx.db
        .delete(secrets)
        .where(and(eq(secrets.environmentId, environment.id), inArray(secrets.key, keys))),
    );
  }

  // LAST. If this fails, everything above it is rolled back with it, which is
  // what makes an un-audited mutation unrepresentable rather than merely
  // discouraged.
  statements.push(
    auditStatement(ctx, {
      action: "secret.write",
      outcome: "success",
      projectId: environment.projectId,
      environmentId: environment.id,
      detail: {
        kind: "secret.diff",
        mode: input.mode,
        added: plan.added,
        changed: plan.changed,
        removed: plan.removed,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(retried ? { retried: true } : {}),
      },
    }),
  );

  return statements;
}

/**
 * THE write path: full replace (`PUT`) and `:batch` are the same function.
 *
 * They differ by one field (`mode`) and share every other property, which is the
 * point -- upstream had `handleSetSecrets` doing `deleteAllSecrets()` followed by
 * `await upsertSecret()` in a loop, so a failure on the 3rd of 5 rows left the
 * environment holding 2 secrets and no way to find out what the other 3 were.
 * That is 101 round-trips for 100 secrets AND unrecoverable data loss from any
 * one of them failing.
 *
 * Here: one read, one batch, all or nothing.
 *
 * ON A VERSION RACE the batch aborts on `UNIQUE(environment_id, key, version)`
 * -- the loser writes NOTHING, not a partial update and not an out-of-order
 * version -- and we retry ONCE against freshly read state. A second loss is a
 * 409: retrying indefinitely turns a contended key into an unbounded latency
 * spike, and two writers colliding twice in a row means something is looping.
 */
export async function writeSecrets(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  input: BatchBody,
): Promise<WriteSecretsResult> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "writer");

  const keyring = requireKeyring(ctx);

  // Refuse an oversized request before doing any work at all. `planWrite`
  // checks the RESULTING size against the same limit; this one bounds the
  // request itself so a million-key body is rejected without being encrypted.
  const requestedKeys = Object.keys(input.set ?? {}).length;
  if (requestedKeys > ctx.config.envMaxSecrets) {
    throw new PrickError(
      "PAYLOAD_TOO_LARGE",
      `This request sets ${String(requestedKeys)} secrets; the limit is ${String(ctx.config.envMaxSecrets)} per environment.`,
      {
        hint: "A bulk write must fit in ONE D1 batch to stay atomic. Split it into separate environments, not separate requests.",
        detail: { limit: ctx.config.envMaxSecrets, requested: requestedKeys },
      },
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await readKeyState(ctx, environment.id);
    const plan = planWrite(input, state, ctx.config.envMaxSecrets);
    const sealed = await sealValues(ctx, keyring, environment.id, plan);

    const statements = buildStatements(
      ctx,
      environment,
      input,
      plan,
      sealed,
      keyring.active.kid,
      attempt > 0,
    );

    try {
      await runBatch(ctx.db, statements);
    } catch (error) {
      const kind = classifyD1Constraint(error);

      if (kind === "environment-rev") {
        throw new PrickError(
          "PRECONDITION_FAILED",
          "The environment has changed since you last read it.",
          {
            hint: "Re-read the environment and re-submit with its current `expected_rev`. Nothing was written.",
            detail: { expectedRev: input.expected_rev ?? null },
            cause: error,
          },
        );
      }

      if (kind === "secret-version" && attempt === 0) {
        // Another writer took the version we computed. Its batch committed,
        // ours rolled back entirely, so there is nothing to undo -- read the
        // new state and build the whole plan again.
        continue;
      }

      if (kind === "secret-version") {
        throw new PrickError(
          "VERSION_CONFLICT",
          "Another write to this environment won the race twice.",
          {
            hint: "Read the environment again and re-submit. Nothing was written by this request.",
            cause: error,
          },
        );
      }

      throw toPrickError(error);
    }

    return {
      rev: environment.rev + 1,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
    };
  }

  /* istanbul ignore next -- the loop either returns or throws on both passes */
  throw new PrickError("VERSION_CONFLICT", "Another write to this environment won the race.");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface CurrentRow {
  key: string;
  description: string | null;
  version: number;
  ciphertext: string | null;
  kid: string | null;
  updatedAt: number;
  updatedBy: string;
}

/** The live rows of an environment joined to their current ciphertext. */
async function readCurrent(ctx: CoreContext, environmentId: string): Promise<CurrentRow[]> {
  return ctx.db
    .select({
      key: secrets.key,
      description: secrets.description,
      version: secrets.currentVersion,
      ciphertext: secretVersions.ciphertext,
      kid: secretVersions.kid,
      updatedAt: secrets.updatedAt,
      updatedBy: secrets.updatedBy,
    })
    .from(secrets)
    .innerJoin(
      secretVersions,
      and(
        eq(secretVersions.environmentId, secrets.environmentId),
        eq(secretVersions.key, secrets.key),
        eq(secretVersions.version, secrets.currentVersion),
      ),
    )
    .where(eq(secrets.environmentId, environmentId))
    .orderBy(asc(secrets.key));
}

/**
 * List an environment's secrets. NO VALUES, ever.
 *
 * Every row IS decrypted, and the plaintext is discarded immediately. That looks
 * wasteful and is not: `unreadable` cannot be determined any other way. AES-GCM
 * has no "verify without decrypting" operation -- the tag check IS the
 * decryption -- so the choice is between attempting it and not knowing.
 *
 * Not knowing is what upstream did. `catch { /* Skip corrupted secrets *\/ }`
 * turned a tampered row into a shorter list, and a shorter list into a `.env`
 * file that deploys production without its `DATABASE_URL`. Here the row comes
 * back marked, the UI renders it red, and an audit row records it with
 * `outcome: 'error'`.
 */
export async function listSecrets(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
): Promise<SecretListEntry[]> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  const keyring = requireKeyring(ctx);

  const rows = await readCurrent(ctx, environment.id);
  const entries: SecretListEntry[] = [];
  const unreadable: string[] = [];

  for (const row of rows) {
    let readable = false;

    if (row.ciphertext !== null) {
      try {
        await decryptSecretValue({
          keyring,
          envelope: row.ciphertext,
          environmentId: environment.id,
          key: row.key,
          version: row.version,
        });
        readable = true;
      } catch {
        readable = false;
      }
    }

    if (!readable) unreadable.push(row.key);

    entries.push({
      key: row.key,
      description: row.description,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      kid: row.kid,
      unreadable: !readable,
    });
  }

  if (unreadable.length > 0) {
    // ONE row for the list, naming the affected keys. Not one per key: a
    // corrupted environment would otherwise write 500 audit rows on every page
    // load and bury the event that mattered.
    await recordAudit(ctx, {
      action: "secret.list",
      outcome: "error",
      projectId: environment.projectId,
      environmentId: environment.id,
      detail: { kind: "secret.unreadable", keys: unreadable },
    });
  }

  return entries;
}

/**
 * Decrypt and return ONE value.
 *
 * Fetches exactly the one row. Upstream's `secrets get` downloaded every secret
 * in the environment in order to print one of them -- which meant reading one
 * value decrypted all of them into memory, and audited none of them
 * individually.
 *
 * A decrypt failure FAILS THE REQUEST. It is never downgraded to an empty
 * string, an omitted key, or a `null`, and the audit row is written BEFORE the
 * throw, so the record of the attempt survives the failure.
 */
export async function revealSecret(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  key: string,
  reason: string,
): Promise<string> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "reader");

  const keyring = requireKeyring(ctx);

  const rows = await ctx.db
    .select({
      version: secrets.currentVersion,
      ciphertext: secretVersions.ciphertext,
    })
    .from(secrets)
    .innerJoin(
      secretVersions,
      and(
        eq(secretVersions.environmentId, secrets.environmentId),
        eq(secretVersions.key, secrets.key),
        eq(secretVersions.version, secrets.currentVersion),
      ),
    )
    .where(and(eq(secrets.environmentId, environment.id), eq(secrets.key, key)))
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.ciphertext === null) {
    throw new PrickError("NOT_FOUND", "No such secret.");
  }

  let value: string;
  try {
    value = await decryptSecretValue({
      keyring,
      envelope: row.ciphertext,
      environmentId: environment.id,
      key,
      version: row.version,
    });
  } catch (error) {
    await recordAudit(ctx, {
      action: "secret.reveal",
      outcome: "error",
      projectId: environment.projectId,
      environmentId: environment.id,
      targetKey: key,
      detail: { kind: "secret.unreadable", keys: [key] },
    });

    throw toPrickError(error);
  }

  // Audited BEFORE the value is returned. The reason ('reveal' | 'copy' |
  // 'export' | 'run') is what makes the log answer "did anyone take this", not
  // merely "did anyone look at it".
  await recordAudit(ctx, {
    action: "secret.reveal",
    outcome: "success",
    projectId: environment.projectId,
    environmentId: environment.id,
    targetKey: key,
    detail: { kind: "secret.read", reason, count: 1 },
  });

  return value;
}

/**
 * Decrypt every value in the environment, for export.
 *
 * ONE audit row for the export as a whole, not one per key: an export is one
 * decision by one person at one instant, and 500 rows describing it would make
 * the log worse rather than more complete.
 *
 * A single unreadable row FAILS THE WHOLE EXPORT. That is the loud choice and it
 * is the right one: the alternative hands the operator a file that is silently
 * missing a variable, which they will discover in production.
 */
export async function exportSecrets(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
): Promise<Record<string, string>> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "reader");

  const keyring = requireKeyring(ctx);
  const rows = await readCurrent(ctx, environment.id);

  const out: Record<string, string> = {};

  for (const row of rows) {
    if (row.ciphertext === null) {
      // A LIVE secret whose current version carries no ciphertext is a
      // tombstone being pointed at as current -- structurally impossible from
      // this codebase, and therefore evidence of direct database manipulation.
      // Skipping it is the exact upstream behaviour this design rejects: the
      // export would be silently one variable short.
      throw new PrickError(
        "DECRYPT_FAILED",
        `The current version of "${row.key}" carries no ciphertext.`,
        {
          hint: "This row cannot have been written by this application. Treat it as tampering.",
        },
      );
    }

    try {
      out[row.key] = await decryptSecretValue({
        keyring,
        envelope: row.ciphertext,
        environmentId: environment.id,
        key: row.key,
        version: row.version,
      });
    } catch (error) {
      await recordAudit(ctx, {
        action: "secret.export",
        outcome: "error",
        projectId: environment.projectId,
        environmentId: environment.id,
        targetKey: row.key,
        detail: { kind: "secret.unreadable", keys: [row.key], kid: row.kid },
      });

      throw toPrickError(error);
    }
  }

  await recordAudit(ctx, {
    action: "secret.export",
    outcome: "success",
    projectId: environment.projectId,
    environmentId: environment.id,
    detail: { kind: "secret.read", reason: "export", count: rows.length },
  });

  return out;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface VersionEntry {
  version: number;
  op: string;
  createdAt: number;
  createdBy: string;
  kid: string | null;
  /** A tombstone: this version records the key's deletion. */
  deleted: boolean;
}

export async function listVersions(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  key: string,
): Promise<VersionEntry[]> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "reader");

  const rows = await ctx.db
    .select({
      version: secretVersions.version,
      op: secretVersions.op,
      createdAt: secretVersions.createdAt,
      createdBy: secretVersions.createdBy,
      kid: secretVersions.kid,
      ciphertext: secretVersions.ciphertext,
    })
    .from(secretVersions)
    .where(and(eq(secretVersions.environmentId, environment.id), eq(secretVersions.key, key)))
    .orderBy(desc(secretVersions.version));

  return rows.map((row) => ({
    version: row.version,
    op: row.op,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    kid: row.kid,
    deleted: row.ciphertext === null,
  }));
}

/**
 * Roll a key back to an earlier version.
 *
 * Decrypt version N, RE-ENCRYPT as `current + 1`. The old envelope is never
 * resurrected -- its AAD binds it to version N, so writing those exact bytes
 * back as the current value would fail its tag check on the next read. History
 * is append-only in both directions: a rollback moves forward.
 */
export async function rollbackSecret(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  input: RollbackBody,
): Promise<{ rev: number; version: number }> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "writer");

  const keyring = requireKeyring(ctx);

  const state = await readKeyState(ctx, environment.id);
  const current = state.get(input.key);

  if (current === undefined) throw new PrickError("NOT_FOUND", "No such secret.");

  const rows = await ctx.db
    .select({ ciphertext: secretVersions.ciphertext })
    .from(secretVersions)
    .where(
      and(
        eq(secretVersions.environmentId, environment.id),
        eq(secretVersions.key, input.key),
        eq(secretVersions.version, input.to_version),
      ),
    )
    .limit(1);

  const source = rows[0];
  if (source === undefined) throw new PrickError("NOT_FOUND", "No such version.");

  if (source.ciphertext === null) {
    throw new PrickError(
      "VALIDATION_FAILED",
      `Version ${String(input.to_version)} of "${input.key}" is a deletion and carries no value.`,
      { hint: "Roll back to a version that set a value, or write a new one." },
    );
  }

  const nextVersion = current.maxVersion + 1;

  let plaintext: string;
  try {
    plaintext = await decryptSecretValue({
      keyring,
      envelope: source.ciphertext,
      environmentId: environment.id,
      key: input.key,
      version: input.to_version,
    });
  } catch (error) {
    await recordAudit(ctx, {
      action: "secret.rollback",
      outcome: "error",
      projectId: environment.projectId,
      environmentId: environment.id,
      targetKey: input.key,
      detail: { kind: "secret.unreadable", keys: [input.key] },
    });
    throw toPrickError(error);
  }

  const envelope = await encryptSecretValue({
    ringKey: keyring.active,
    environmentId: environment.id,
    key: input.key,
    version: nextVersion,
    plaintext,
    maxBytes: ctx.config.secretMaxBytes,
  });

  await runBatch(ctx.db, [
    bumpRevision(ctx, environment.id),
    ctx.db.insert(secretVersions).values({
      id: uuidv7(ctx.now),
      environmentId: environment.id,
      key: input.key,
      version: nextVersion,
      ciphertext: envelope,
      kid: keyring.active.kid,
      op: "rollback",
      createdAt: ctx.now,
      createdBy: ctx.actor.subject,
    }),
    ctx.db
      .update(secrets)
      .set({ currentVersion: nextVersion, updatedAt: ctx.now, updatedBy: ctx.actor.subject })
      .where(and(eq(secrets.environmentId, environment.id), eq(secrets.key, input.key))),
    auditStatement(ctx, {
      action: "secret.rollback",
      outcome: "success",
      projectId: environment.projectId,
      environmentId: environment.id,
      targetKey: input.key,
      detail: {
        kind: "secret.version",
        key: input.key,
        from: input.to_version,
        to: nextVersion,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    }),
  ]);

  return { rev: environment.rev + 1, version: nextVersion };
}

/**
 * Rename a key.
 *
 * THERE IS NO CHEAP RENAME, and there cannot be one. The ciphertext is bound to
 * the key NAME through the AAD, so moving the blob to a new row would either
 * fail the next tag check or -- if someone "fixed" that by removing `key` from
 * the AAD -- reintroduce cross-key transplant, which is the vulnerability the
 * AAD exists to close. So: decrypt under the old identity, re-encrypt under the
 * new one, tombstone the old, all in one batch.
 *
 * The new version number is `max(history of the NEW key) + 1`, not
 * `old version + 1`. The design note says the latter; it is only correct when
 * the destination has no history of its own, and renaming onto a name that was
 * previously used and deleted is exactly when it is not.
 */
export async function renameSecret(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  oldKey: string,
  newKey: string,
): Promise<{ rev: number }> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "writer");

  const keyring = requireKeyring(ctx);

  const state = await readKeyState(ctx, environment.id);
  const source = state.get(oldKey);

  if (source === undefined || !source.live) {
    throw new PrickError("NOT_FOUND", "No such secret.");
  }

  if (state.get(newKey)?.live === true) {
    throw new PrickError("CONFLICT", `A secret named "${newKey}" already exists.`, {
      hint: "Delete or rename the existing key first.",
    });
  }

  const rows = await ctx.db
    .select({ ciphertext: secretVersions.ciphertext })
    .from(secretVersions)
    .where(
      and(
        eq(secretVersions.environmentId, environment.id),
        eq(secretVersions.key, oldKey),
        eq(secretVersions.version, source.maxVersion),
      ),
    )
    .limit(1);

  const blob = rows[0]?.ciphertext;
  if (blob === undefined || blob === null) {
    throw new PrickError("NOT_FOUND", "No such secret.");
  }

  let plaintext: string;
  try {
    plaintext = await decryptSecretValue({
      keyring,
      envelope: blob,
      environmentId: environment.id,
      key: oldKey,
      version: source.maxVersion,
    });
  } catch (error) {
    await recordAudit(ctx, {
      action: "secret.rename",
      outcome: "error",
      projectId: environment.projectId,
      environmentId: environment.id,
      targetKey: oldKey,
      detail: { kind: "secret.unreadable", keys: [oldKey] },
    });
    throw toPrickError(error);
  }

  const destinationVersion = (state.get(newKey)?.maxVersion ?? 0) + 1;
  const tombstoneVersion = source.maxVersion + 1;

  const envelope = await encryptSecretValue({
    ringKey: keyring.active,
    environmentId: environment.id,
    key: newKey,
    version: destinationVersion,
    plaintext,
    maxBytes: ctx.config.secretMaxBytes,
  });

  await runBatch(ctx.db, [
    bumpRevision(ctx, environment.id),
    ctx.db.insert(secretVersions).values([
      {
        id: uuidv7(ctx.now),
        environmentId: environment.id,
        key: newKey,
        version: destinationVersion,
        ciphertext: envelope,
        kid: keyring.active.kid,
        op: "rename",
        createdAt: ctx.now,
        createdBy: ctx.actor.subject,
      },
      {
        id: uuidv7(ctx.now),
        environmentId: environment.id,
        key: oldKey,
        version: tombstoneVersion,
        ciphertext: null,
        kid: null,
        op: "delete",
        createdAt: ctx.now,
        createdBy: ctx.actor.subject,
      },
    ]),
    ctx.db.insert(secrets).values({
      id: uuidv7(ctx.now),
      environmentId: environment.id,
      key: newKey,
      currentVersion: destinationVersion,
      description: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      updatedBy: ctx.actor.subject,
    }),
    ctx.db
      .delete(secrets)
      .where(and(eq(secrets.environmentId, environment.id), eq(secrets.key, oldKey))),
    auditStatement(ctx, {
      action: "secret.rename",
      outcome: "success",
      projectId: environment.projectId,
      environmentId: environment.id,
      targetKey: newKey,
      detail: { kind: "secret.rename", from: oldKey, to: newKey, version: destinationVersion },
    }),
  ]);

  return { rev: environment.rev + 1 };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportResult {
  added: string[];
  changed: string[];
  removed: string[];
  applied: boolean;
  /** Non-fatal parser observations. Line numbers and key names only. */
  warnings: { line: number; key: string; message: string }[];
}

/**
 * Parse a `.env` or JSON blob and either report the diff or apply it.
 *
 * THE DRY-RUN RESPONSE CARRIES KEY NAMES AND CHANGE KINDS ONLY. Not values, and
 * emphatically not "old vs new" for a changed row -- that shape looks like a
 * helpful diff and leaks two secrets where the naive version leaks one.
 *
 * "changed" means "this key already existed and is being rewritten". It does NOT
 * mean "the value differs", and it cannot: telling those apart requires
 * decrypting every existing value to compare it, which is a full environment
 * reveal performed silently, on a screen whose entire purpose is to avoid one.
 */
export async function importSecrets(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  input: ImportBody,
): Promise<ImportResult> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "writer");

  const parsed = parseContent(input);

  if (!input.dry_run) {
    const body: BatchBody = {
      mode: input.mode,
      set: parsed.values,
      ...(input.expected_rev === undefined ? {} : { expected_rev: input.expected_rev }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };

    const result = await writeSecrets(ctx, projectSlug, envSlug, body);

    return {
      added: result.added,
      changed: result.changed,
      removed: result.removed,
      applied: true,
      warnings: parsed.warnings,
    };
  }

  // The dry run reads the same state the write path would, and computes the
  // same plan through the same function -- so what it shows is what would
  // happen, rather than a second implementation that agrees by inspection.
  const state = await readKeyState(ctx, environment.id);
  const plan = planWrite(
    { mode: input.mode, set: parsed.values },
    state,
    ctx.config.envMaxSecrets,
  );

  return {
    added: plan.added,
    changed: plan.changed,
    removed: plan.removed,
    applied: false,
    warnings: parsed.warnings,
  };
}

function parseContent(input: ImportBody): {
  values: Record<string, string>;
  warnings: { line: number; key: string; message: string }[];
} {
  if (input.format === "env") {
    const document = parseDotenv(input.content);
    const values: Record<string, string> = {};
    for (const entry of document.entries) values[entry.key] = entry.value;
    return { values, warnings: document.warnings };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.content);
  } catch (cause) {
    // The parser's own message would quote the offending text, which for this
    // input is a file of secrets.
    throw new PrickError("VALIDATION_FAILED", "The content is not valid JSON.", {
      hint: "Expected a flat object of string keys to string values.",
      cause,
    });
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new PrickError("VALIDATION_FAILED", "Expected a JSON object of key/value pairs.");
  }

  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(decoded)) {
    if (typeof value !== "string") {
      // Names the KEY, never the value -- including when the value is a number
      // or an object, where quoting it would feel harmless and would still be a
      // secret in a response body.
      throw new PrickError(
        "VALIDATION_FAILED",
        `The value of "${key}" is not a string.`,
        { hint: "Secret values are strings. Quote numbers and booleans." },
      );
    }
    values[key] = value;
  }

  return { values, warnings: [] };
}
