import type { BatchBody, ImportBody } from "@prick/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { encryptSecretValue, type Keyring } from "../crypto/index.js";
import { uuidv7 } from "../db/ids.js";
import {
  environments,
  secrets,
  secretVersions,
  type Environment,
  type NewSecret,
  type NewSecretVersion,
} from "../db/schema.js";
import { auditStatement } from "./audit.js";
import { requireKeyring, type CoreContext } from "./context.js";
import { environmentScope, requireEnvironment } from "./environments.js";
import { classifyD1Constraint, PrickError, toPrickError } from "./errors.js";
import { assertRole } from "./guards.js";
import { parseDotenv } from "./dotenv.js";
import { readKeyState, type KeyState } from "./secret-state.js";
import { chunk, rowsPerChunk, runBatch, type Statement } from "./sql.js";

/**
 * THE BULK WRITE PATH -- and, through the re-exports below, the module every
 * transport still imports as `core/secrets.js`.
 *
 * What is IN this file is one thing: a write of many keys at once, from the
 * plan through the chunking arithmetic to the single `batch()` that commits it.
 * `buildStatements` returns ONE array and `writeSecrets` hands that array to
 * ONE `runBatch`; there is no second call site, and there must never be one.
 * Keeping the plan, the chunking and the batch in the same file is deliberate:
 * the atomicity guarantee is an argument about all three together, and an
 * argument you have to open three files to follow is one nobody checks.
 *
 * What has moved out is everything that is NOT that write:
 *
 *   ./secret-state.js   the prior-state read every mutation begins with
 *   ./secret-reads.js   list / reveal / export / versions -- the decrypt side
 *   ./secret-moves.js   rename and rollback -- one key, one batch each
 *
 * They are re-exported here so `core/secrets.js` remains the single import
 * surface for the HTTP routes and the SvelteKit loads.
 */

export {
  exportSecrets,
  listSecrets,
  listVersions,
  revealSecret,
  type SecretListEntry,
  type VersionEntry,
} from "./secret-reads.js";
export { renameSecret, rollbackSecret } from "./secret-moves.js";

export interface WriteSecretsResult {
  /** The environment's revision AFTER the write. */
  rev: number;
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * WHICH KIND OF BULK WRITE THIS IS, for the audit row and nothing else.
 *
 * A two-member subset of `AuditAction` rather than the whole union, because the
 * only thing a caller is entitled to say here is "this same write arrived
 * through the import door". Widening it to `AuditAction` would let a transport
 * label a secret write `admin.rekey`, which is a worse hole than the one this
 * exists to close.
 *
 * It matters because the two are otherwise indistinguishable in the log: an
 * import and a hand-written batch produce identical rows, so "someone pasted a
 * `.env` over production" reads exactly like "someone changed one key" unless
 * the operator happened to send a `reason`. Deriving it from the shape of the
 * request -- a large `added` list, say -- would be a guess; the caller knows.
 */
export type WriteKind = "secret.write" | "secret.import";

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
// The write path
// ---------------------------------------------------------------------------

interface WritePlan {
  sets: { key: string; value: string; version: number; existed: boolean }[];
  deletes: { key: string; version: number }[];
  added: string[];
  changed: string[];
  removed: string[];
}

function planWrite(input: BatchBody, state: Map<string, KeyState>, maxSecrets: number): WritePlan {
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

  const liveKeys = [...state.entries()].filter(([, value]) => value.live).map(([key]) => key);

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
 *   4. multi-row upsert into secrets, DESCRIBED     (12 rows per statement)
 *   4b. multi-row upsert into secrets, INHERITED    (12 rows per statement)
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
  kind: WriteKind,
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

  // Validated to be a subset of `set` by `BatchBody`, so every key here has a
  // row in `plan.sets` and none of them is a metadata-only update.
  const descriptions = input.descriptions ?? {};

  /*
   * TWO GROUPS OF UPSERT STATEMENTS, ONE BATCH.
   *
   * ONE `onConflictDoUpdate` applies ONE `SET` expression to every row in its
   * statement, so "overwrite the description" and "keep the existing
   * description" cannot both be expressed by one upsert -- whichever clause is
   * written applies to all twelve rows of the chunk. A batch that set
   * `description = excluded.description` for every row would clear the
   * description of every key it merely happened to be writing alongside; one
   * that coalesced for every row could never clear anything, which is what
   * makes `null` mean "clear" impossible to honour.
   *
   * So the rows are partitioned by whether this request said anything about the
   * key's description, and each half gets the clause that is true of it. Both
   * halves are pushed onto the SAME `statements` array: this is more
   * statements, never more batches. Splitting them across two `batch()` calls
   * would make a description write commit while its value rolled back.
   */
  const described = plan.sets.filter((entry) => Object.hasOwn(descriptions, entry.key));
  const inherited = plan.sets.filter((entry) => !Object.hasOwn(descriptions, entry.key));

  const secretRow = (entry: WritePlan["sets"][number], description: string | null): NewSecret => ({
    id: uuidv7(ctx.now),
    environmentId: environment.id,
    key: entry.key,
    currentVersion: entry.version,
    description,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    updatedBy: ctx.actor.subject,
  });

  for (const rows of chunk(
    // `?? null` is unreachable -- `Object.hasOwn` selected these keys -- and is
    // written rather than asserted because the map's value type already admits
    // `null`, which is exactly the CLEAR this branch exists to carry.
    described.map((entry) => secretRow(entry, descriptions[entry.key] ?? null)),
    SECRET_ROWS_PER_STATEMENT,
  )) {
    statements.push(
      ctx.db
        .insert(secrets)
        .values(rows)
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: {
            currentVersion: sql`excluded.current_version`,
            // OVERWRITE. The request named this key's description, so an
            // explicit `null` has to reach the column -- coalescing here would
            // make a description unclearable, with the request appearing to
            // succeed.
            description: sql`excluded.description`,
            updatedAt: sql`excluded.updated_at`,
            updatedBy: sql`excluded.updated_by`,
          },
        }),
    );
  }

  for (const rows of chunk(
    inherited.map((entry) => secretRow(entry, null)),
    SECRET_ROWS_PER_STATEMENT,
  )) {
    statements.push(
      ctx.db
        .insert(secrets)
        .values(rows)
        .onConflictDoUpdate({
          target: [secrets.environmentId, secrets.key],
          set: {
            currentVersion: sql`excluded.current_version`,
            // COALESCE, not overwrite: this request said nothing about these
            // keys' descriptions, and a batch that silently cleared every
            // description because it did not mention them would be
            // indistinguishable from one that meant to.
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
  //
  // `kind` only changes the ACTION on this one row. An import is the same
  // statements in the same batch -- it is a different way of arriving at a bulk
  // write, not a different write -- so labelling it here rather than auditing it
  // separately is what keeps "one mutation, one audit row, one transaction"
  // true. A second insert would be a second row for one event, and a row
  // outside the batch would be exactly the un-audited-mutation hole the rule
  // closes.
  statements.push(
    auditStatement(ctx, {
      action: kind,
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
 * point. The alternative -- delete everything, then insert row by row -- is 101
 * round-trips for 100 secrets, and a failure on the 3rd of 5 rows leaves the
 * environment holding 2 secrets with no way to discover what the other 3 were.
 * Unrecoverable data loss from any single failure, in the middle of the one
 * operation a secrets manager exists to perform.
 *
 * Here: one read, one batch, all or nothing.
 *
 * ON A VERSION RACE the batch aborts on `UNIQUE(environment_id, key, version)`
 * -- the loser writes NOTHING, not a partial update and not an out-of-order
 * version -- and we retry ONCE against freshly read state. A second loss is a
 * 409: retrying indefinitely turns a contended key into an unbounded latency
 * spike, and two writers colliding twice in a row means something is looping.
 *
 * `kind` is how an import gets its own audit action without getting its own
 * write. It defaults to `secret.write`, so every transport that does not pass it
 * -- which is all of them -- is unaffected.
 */
export async function writeSecrets(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
  input: BatchBody,
  kind: WriteKind = "secret.write",
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
      kind,
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
// Import
//
// The front door to the write path above, and it stays in this file for one
// reason: the dry run must compute its answer with `planWrite` -- the same
// function the real write uses -- rather than with a second implementation that
// agrees by inspection. Keeping both callers in one file is what keeps that
// checkable, and it is why `planWrite` is module-private.
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

    /*
     * THE SAME WRITE, AUDITED AS AN IMPORT.
     *
     * Not a second batch and not a second row: `writeSecrets` builds one
     * `batch()` whose last statement is the audit insert, and all `kind` does is
     * decide what that statement's `action` says. An import that wrote its own
     * audit row would either sit outside the batch -- the un-audited-mutation
     * hole -- or double-count one event.
     *
     * It has to be said HERE rather than inferred there, because by the time the
     * write path sees it this is an ordinary `BatchBody`. That is the point: an
     * import and a hand-written batch differ in provenance, not in effect, and
     * provenance is exactly what an auditor is asking about when the question is
     * "did somebody paste a `.env` over production".
     */
    const result = await writeSecrets(ctx, projectSlug, envSlug, body, "secret.import");

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
  const plan = planWrite({ mode: input.mode, set: parsed.values }, state, ctx.config.envMaxSecrets);

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
      throw new PrickError("VALIDATION_FAILED", `The value of "${key}" is not a string.`, {
        hint: "Secret values are strings. Quote numbers and booleans.",
      });
    }
    values[key] = value;
  }

  return { values, warnings: [] };
}
