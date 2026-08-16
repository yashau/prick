import { and, asc, count, eq, isNotNull, ne, sql } from "drizzle-orm";

import { decryptSecretValue, encryptSecretValue, type Keyring } from "../crypto/index.js";
import { environments, keyringState, secretVersions } from "../db/schema.js";
import { auditStatement, recordAudit } from "./audit.js";
import { requireKeyring, type CoreContext } from "./context.js";
import { INTERNAL_MESSAGE, PrickError, toPrickError } from "./errors.js";
import { assertRole } from "./guards.js";
import { runBatch, type Statement } from "./sql.js";

/**
 * THE KEY RING: what is stored under which master key, and moving it.
 *
 * Two functions, and one thing they share: they answer with COUNTED ROWS, never
 * with a cached number and never with an inference. `keyring_state` carries a
 * `rows_remaining` column, and this module writes it -- but nothing here READS
 * it to decide anything, because a "safe to remove MASTER_KEY_OLD" indicator
 * derived from a counter that drifted is worse than no indicator: it is wrong
 * in the one direction that destroys data.
 *
 * Both are global-admin only, and the check is the first statement in each. It
 * lives here rather than in the transports because authorization is written
 * once -- the Hono route and the SvelteKit load both enter through these two
 * functions, and a check in one of those transports is a check the other does
 * not have.
 */

export interface KeyringStatus {
  activeKid: string;
  entries: {
    kid: string;
    status: "active" | "retiring" | "retired";
    rowsRemaining: number;
    lastRekeyAt: number | null;
  }[];
  /**
   * True only when every non-active kid has `rowsRemaining === 0`.
   *
   * The settings screen renders this as the "safe to remove MASTER_KEY_OLD"
   * indicator. Removing the old key while rows still reference a retired kid
   * is the ONE irreversible mistake available in this design -- those values
   * can never be decrypted again -- so the UI has to be what tells you, and it
   * only goes green at zero.
   */
  safeToRemoveOldKey: boolean;
}

type KeyringStatusEntry = KeyringStatus["entries"][number];

/**
 * The largest page a single invocation will re-encrypt, whatever it was asked
 * for.
 *
 * A page is ONE `batch()` -- one UPDATE per row plus the key-state maintenance
 * and the audit insert -- because a rekey split across two batches would leave
 * the first committed when the second failed, which is the defect the whole
 * write path is shaped to prevent. So when a page does not fit, the page gets
 * smaller; it never gets split.
 *
 * 100 is also what `RekeyBody` accepts as its maximum -- it imports this
 * constant rather than repeating the number, so the edge refuses an oversized
 * limit instead of clamping it. A clamp would answer 200 to a request for 1000,
 * and a caller pacing itself off the number it asked for would be wrong by a
 * factor of ten with nothing to notice. The
 * bulk write path already runs ~90 statements in one batch at its 500-secret
 * cap, which is the largest batch this codebase is known to commit; matching
 * that magnitude rather than exceeding it by an order of magnitude is the
 * whole justification for the number.
 */
export const REKEY_MAX_PAGE = 100;

/** What a caller that expresses no preference gets. */
export const REKEY_DEFAULT_PAGE = 100;

// ---------------------------------------------------------------------------
// Counting -- the only source of truth for "is it safe yet"
// ---------------------------------------------------------------------------

interface KidCensus {
  /** kid -> rows whose stored ciphertext is sealed under it. */
  byKid: Map<string, number>;
  /**
   * Rows that carry a ciphertext and NO kid.
   *
   * Structurally impossible from this codebase -- a tombstone has neither, a
   * value row has both -- so a non-zero count here is evidence of direct
   * database manipulation. It cannot be attributed to a key id, which means it
   * cannot be reasoned about, which means it is an UNKNOWN. An unknown must not
   * read as safe, so it forces `safeToRemoveOldKey` false even though no entry
   * can display it.
   */
  unattributed: number;
}

/**
 * Count every stored ciphertext, grouped by the key that protects it.
 *
 * ONE query, over `secret_versions` and not over `keyring_state`. The
 * distinction is the point of this module: `keyring_state.rows_remaining` is a
 * number some earlier invocation wrote, and the question being asked -- "may I
 * delete the only copy of a key" -- is not one to answer from a cache.
 *
 * HISTORY COUNTS, not just the current version of each key. `rollbackSecret`
 * decrypts an arbitrary historical version, so a version left behind under a
 * retired kid is a rollback that will fail after the key is removed. Counting
 * only live rows would turn the indicator green while the history was still
 * hostage.
 */
async function census(ctx: CoreContext): Promise<KidCensus> {
  const rows = await ctx.db
    .select({ kid: secretVersions.kid, rows: count() })
    .from(secretVersions)
    .where(isNotNull(secretVersions.ciphertext))
    .groupBy(secretVersions.kid);

  const byKid = new Map<string, number>();
  let unattributed = 0;

  for (const row of rows) {
    if (row.kid === null) unattributed += row.rows;
    else byKid.set(row.kid, row.rows);
  }

  return { byKid, unattributed };
}

/**
 * Where a kid stands RELATIVE TO THE RING, which is a fact about configuration
 * and deliberately not a fact about progress.
 *
 *   active    this deployment's `MASTER_KEY`. Everything new is written here.
 *   retiring  loaded as `MASTER_KEY_OLD`: decrypt-only, and the rekey can still
 *             move rows off it.
 *   retired   not in the ring at all. If it still has rows, those rows are
 *             ALREADY undecryptable and the key has to come back.
 *
 * The tempting alternative -- "retiring means it still has rows, retired means
 * it is done" -- conflates the two facts and mislabels the one case that
 * matters: a kid with rows whose key has been deleted would read as "retiring",
 * as though a rekey could still drain it. It cannot. `rowsRemaining` is the
 * progress number; this is the configuration number.
 */
function statusOf(keyring: Keyring, kid: string): KeyringStatusEntry["status"] {
  if (kid === keyring.active.kid) return "active";
  if (keyring.find(kid) !== undefined) return "retiring";
  return "retired";
}

/**
 * Every kid worth showing: the ring's own, plus every one observed in a row or
 * recorded by a previous rekey.
 *
 * The union matters in both directions. A ring key with no rows has to appear
 * so an operator can see that the new key is loaded; a kid with rows that the
 * ring does NOT hold has to appear, because that is the emergency.
 */
function orderKids(keyring: Keyring, observed: Iterable<string>, recorded: Iterable<string>) {
  const rest = new Set<string>([...observed, ...recorded]);
  for (const kid of keyring.kids) rest.delete(kid);

  return [...keyring.kids, ...[...rest].sort((left, right) => left.localeCompare(right))];
}

/**
 * The ring, its per-kid row counts, and the one boolean that gates an
 * irreversible action.
 *
 * READ-ONLY. It writes nothing, including no `keyring_state` row for a kid it
 * has just observed for the first time -- a GET that mutates would need an
 * audit row in a batch it has no reason to open, and the counts it reports are
 * computed live regardless, so there would be nothing to gain.
 */
export async function getKeyringStatus(ctx: CoreContext): Promise<KeyringStatus> {
  await assertRole(ctx, { type: "global" }, "admin");

  const keyring = requireKeyring(ctx);

  // If either of these throws, the whole call throws. There is no branch that
  // degrades to an empty ring or a zero count, because both of those render as
  // "safe to remove MASTER_KEY_OLD" and neither of them means it.
  const counted = await census(ctx);

  const recorded = new Map(
    (await ctx.db.select().from(keyringState)).map((row) => [row.kid, row] as const),
  );

  const entries: KeyringStatusEntry[] = orderKids(
    keyring,
    counted.byKid.keys(),
    recorded.keys(),
  ).map((kid) => ({
    kid,
    status: statusOf(keyring, kid),
    rowsRemaining: counted.byKid.get(kid) ?? 0,
    lastRekeyAt: recorded.get(kid)?.lastRekeyAt ?? null,
  }));

  return {
    activeKid: keyring.active.kid,
    entries,
    /*
     * TRUE ONLY AT ZERO, AND ONLY WITH EVERYTHING ACCOUNTED FOR.
     *
     * Two distinct hazards, and it is worth being exact about which one each
     * half covers, because they are easy to conflate:
     *
     *   `unattributed === 0` covers ciphertext this application cannot have
     *   written -- a row with a value and no `kid`. It belongs to no entry, so
     *   `every` below would never look at it, and something unreadable that no
     *   key accounts for is the last thing that should read as safe.
     *
     *   `every` covers kids the ring no longer holds. A kid present in the
     *   census but absent from the ring gets `status: "retired"` and its real
     *   count, so a key that was deleted while rows still referenced it keeps
     *   this red rather than vanishing from the comparison.
     *
     * What NEITHER covers, and no expression here could: a census that returns
     * nothing because the query drifted looks exactly like an empty
     * `secret_versions`, and both produce `true`. That is not defended by
     * cleverness in this function -- it is defended by the tests in
     * `test/core/keyring.test.ts`, which seed real rows and assert this goes
     * false. If you change `census`, run them and watch them fail first.
     */
    safeToRemoveOldKey:
      counted.unattributed === 0 &&
      entries.every((entry) => entry.status === "active" || entry.rowsRemaining === 0),
  };
}

// ---------------------------------------------------------------------------
// The rekey
// ---------------------------------------------------------------------------

/** One row of the page, with the two nullable columns already established. */
interface StaleRow {
  id: string;
  projectId: string;
  environmentId: string;
  key: string;
  version: number;
  ciphertext: string;
  kid: string;
}

/**
 * `WHERE` for "still sealed under something other than the active key".
 *
 * Shared by the page query and the count so the two can never disagree about
 * what work is outstanding -- a `remaining` computed against a different
 * predicate from the one that selects the page is a progress bar that never
 * reaches zero.
 */
function stalePredicate(activeKid: string) {
  return and(
    isNotNull(secretVersions.ciphertext),
    isNotNull(secretVersions.kid),
    ne(secretVersions.kid, activeKid),
  );
}

function boundedPage(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PrickError("VALIDATION_FAILED", "The rekey page size must be a positive integer.", {
      hint: `Send a limit between 1 and ${String(REKEY_MAX_PAGE)}; anything larger is clamped to ${String(REKEY_MAX_PAGE)}.`,
    });
  }

  return Math.min(limit, REKEY_MAX_PAGE);
}

/**
 * Read one page of rows that are still sealed under a retired key.
 *
 * ORDERED BY `id`, which is a UUIDv7 and therefore in creation order -- the same
 * property the audit log's keyset paginator relies on. That ordering is the
 * cursor, and it is deliberately NOT a stored one: a rekeyed row leaves this
 * predicate permanently, so the next invocation's `WHERE` clause resumes
 * exactly where the last one committed, with no bookmark to go stale, no
 * bookmark to skip a row that failed, and nothing to reset when a page rolls
 * back.
 */
async function readPage(ctx: CoreContext, activeKid: string, pageSize: number) {
  return ctx.db
    .select({
      id: secretVersions.id,
      projectId: environments.projectId,
      environmentId: secretVersions.environmentId,
      key: secretVersions.key,
      version: secretVersions.version,
      ciphertext: secretVersions.ciphertext,
      kid: secretVersions.kid,
    })
    .from(secretVersions)
    .innerJoin(environments, eq(environments.id, secretVersions.environmentId))
    .where(stalePredicate(activeKid))
    .orderBy(asc(secretVersions.id))
    .limit(pageSize);
}

/**
 * Re-seal one row under the active key, UNDER THE IDENTICAL AAD.
 *
 * `environmentId`, `key` and `version` are copied straight from the row and
 * none of them is recomputed, offset or "corrected". That is the entire
 * contract of a rekey: the AAD binds `(purpose, environment_id, key, version)`
 * and the row's identity has not changed -- only the key protecting it has.
 * `kid` can move because `kid` lives in the envelope and not in the AAD; if it
 * were in the AAD, every rotation would be a version bump and rotating a key
 * would rewrite the history of every secret in the installation.
 *
 * A DECRYPT FAILURE ENDS THE WHOLE PAGE. It is audited and rethrown, never
 * skipped: a rekey that stepped over the one row it could not open would leave
 * that row behind under a key the operator is about to delete, and the
 * "remaining" count would still fall to zero. The loud failure is what makes
 * the count trustworthy.
 */
async function reseal(ctx: CoreContext, keyring: Keyring, row: StaleRow): Promise<string> {
  let plaintext: string;

  try {
    plaintext = await decryptSecretValue({
      keyring,
      envelope: row.ciphertext,
      environmentId: row.environmentId,
      key: row.key,
      version: row.version,
    });
  } catch (error) {
    // Standalone, because there is no batch yet -- nothing has been written and
    // nothing will be. The row it names is the row that failed, and it carries
    // the kid so an operator can tell "MASTER_KEY_OLD was removed too early"
    // from "this row has been altered".
    await recordAudit(ctx, {
      action: "admin.rekey",
      outcome: "error",
      projectId: row.projectId,
      environmentId: row.environmentId,
      targetKey: row.key,
      detail: { kind: "secret.unreadable", keys: [row.key], kid: row.kid },
    });

    throw toPrickError(error);
  }

  return encryptSecretValue({
    ringKey: keyring.active,
    environmentId: row.environmentId,
    key: row.key,
    // NOT `+ 1`, and not recomputed from history. The row keeps its identity.
    version: row.version,
    plaintext,
    /*
     * DELIBERATELY UNBOUNDED, and the only place in this codebase that is.
     *
     * `SECRET_MAX_BYTES` is an INGRESS limit: it decides what may enter the
     * system. This value entered it already, under whatever limit was in force
     * at the time. Re-applying today's limit to data at rest would mean that
     * lowering the configured maximum silently converts every larger stored
     * value into a row the rekey can never move -- and therefore a rotation
     * that can never finish, on an installation whose operator is waiting for
     * the count to reach zero.
     */
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * Maintain `keyring_state` for the kids this page touched.
 *
 * `first_seen_at` is set on insert and never on update -- it is the FIRST time,
 * not the latest, and an "updated" first-seen is just a second `updated_at`.
 * `rows_remaining` is written by the statement after this one rather than here,
 * so the value in these rows is a placeholder that never becomes observable:
 * both statements are in the same batch, and a batch is a transaction.
 */
function recordKids(ctx: CoreContext, keyring: Keyring, kids: readonly string[]): Statement {
  return ctx.db
    .insert(keyringState)
    .values(
      kids.map((kid) => ({
        kid,
        status: statusOf(keyring, kid),
        firstSeenAt: ctx.now,
        lastRekeyAt: ctx.now,
        rowsRemaining: 0,
        updatedAt: ctx.now,
      })),
    )
    .onConflictDoUpdate({
      target: keyringState.kid,
      set: {
        status: sql`excluded.status`,
        lastRekeyAt: sql`excluded.last_rekey_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * RECOMPUTE `rows_remaining` for every recorded kid. Never decrement it.
 *
 * The schema says this column is recomputed by the rekey job rather than
 * maintained as a running counter, and this statement is that promise. A
 * counter that is decremented by however many rows a page moved is correct only
 * for as long as nothing else ever writes a row -- and ordinary secret writes
 * do, constantly, under the active kid. One drifted decrement in the direction
 * of zero is a green "safe to remove" on an installation that is not.
 *
 * It runs AFTER the row updates and inside the same batch, so it counts the
 * rows as they will be committed rather than as they were read. No `WHERE`: a
 * kid whose count this pass did not change is still a kid whose count should be
 * right.
 */
function recomputeRowsRemaining(ctx: CoreContext): Statement {
  return ctx.db.update(keyringState).set({
    rowsRemaining: sql`(select count(*) from ${secretVersions} where ${secretVersions.kid} = ${keyringState.kid} and ${secretVersions.ciphertext} is not null)`,
    updatedAt: ctx.now,
  });
}

/**
 * Re-encrypt one bounded page of rows onto the active key.
 *
 * INCREMENTAL, RESUMABLE AND IDEMPOTENT, in that order of importance:
 *
 *   incremental  one page per invocation, so a large database never needs a
 *                transaction that approaches D1's 30 s ceiling.
 *   resumable    the predicate is the cursor. A committed page leaves the
 *                candidate set; a rolled-back page does not, and is simply
 *                retried by the next call.
 *   idempotent   a second run over the same data selects nothing, writes
 *                nothing and audits nothing, because there is no such thing as
 *                a row that is stale twice.
 *
 * ONE `batch()`, and the audit insert is the last statement in it, so a rekey
 * that moved rows without recording that it did is unrepresentable rather than
 * merely discouraged. A no-op page opens no batch and writes no audit row: an
 * audit row for every empty poll would bury the pages that did something.
 *
 * THE ENVIRONMENT'S `rev` IS NOT BUMPED. `rev` is the optimistic-concurrency
 * token for an environment's CONTENTS, and a rekey changes no content -- same
 * keys, same values, same versions. Bumping it would make every rotation
 * invalidate every `expected_rev` a client is holding, turning a background
 * maintenance job into a source of spurious 412s on unrelated writes.
 */
export async function rekeyPage(
  ctx: CoreContext,
  limit: number,
): Promise<{ rekeyed: number; remaining: number }> {
  await assertRole(ctx, { type: "global" }, "admin");

  const keyring = requireKeyring(ctx);
  const pageSize = boundedPage(limit);
  const activeKid = keyring.active.kid;

  const page = await readPage(ctx, activeKid, pageSize);

  // Nothing outstanding. `remaining` is 0 rather than unknown: it is the same
  // predicate that just returned nothing.
  if (page.length === 0) return { rekeyed: 0, remaining: 0 };

  const sealed: { id: string; envelope: string }[] = [];
  const sourceKids = new Set<string>();

  for (const row of page) {
    /* istanbul ignore next -- the predicate selects only rows with both */
    if (row.ciphertext === null || row.kid === null) {
      throw new PrickError("INTERNAL", INTERNAL_MESSAGE);
    }

    const stale: StaleRow = { ...row, ciphertext: row.ciphertext, kid: row.kid };

    // EVERY row is resealed before ANY row is written. A failure on the
    // fortieth leaves the first thirty-nine untouched in the database, because
    // the batch below has not been built yet, let alone sent.
    sealed.push({ id: stale.id, envelope: await reseal(ctx, keyring, stale) });
    sourceKids.add(stale.kid);
  }

  const statements: Statement[] = sealed.map((row) =>
    ctx.db
      .update(secretVersions)
      // Two columns, and only these two. The row keeps its id, its environment,
      // its key, its version and its `op`: it is the same version of the same
      // secret, sealed under a different key.
      .set({ ciphertext: row.envelope, kid: activeKid })
      .where(eq(secretVersions.id, row.id)),
  );

  statements.push(recordKids(ctx, keyring, [activeKid, ...sourceKids]));
  statements.push(recomputeRowsRemaining(ctx));

  // LAST. If this fails, every re-encryption above it is rolled back with it.
  statements.push(
    auditStatement(ctx, {
      action: "admin.rekey",
      outcome: "success",
      /*
       * `from` is sorted so two pages that moved the same kids produce the same
       * detail, which is what lets a reader diff one audit row against another
       * instead of re-reading both.
       *
       * This used to be `{ kind: "secret.read", reason: "rekey", count }`, which
       * was truthful -- N values really were decrypted into memory -- but could
       * not name the kids. "100 keys were read" and "100 rows left kid abc for
       * kid def" answer different questions, and only the second tells an
       * auditor whether the retired key is finished with.
       *
       * A dedicated `admin.rekey` member -- naming the source kids and the
       * destination -- would be better, and `AuditDetail` in `core/audit.ts` is
       * where it would go.
       */
      detail: {
        kind: "admin.rekey",
        from: [...sourceKids].sort(),
        to: activeKid,
        count: sealed.length,
      },
    }),
  );

  try {
    await runBatch(ctx.db, statements);
  } catch (error) {
    // Nothing committed, so there is nothing to undo and nothing to report
    // beyond the failure itself. The next invocation reads the same page.
    throw toPrickError(error);
  }

  return {
    rekeyed: sealed.length,
    remaining: await remainingAfter(ctx, activeKid, page.length, pageSize),
  };
}

/**
 * How much is left, counted AFTER the page has committed.
 *
 * A SHORT PAGE NEEDS NO QUERY: the page query asked for `pageSize` rows against
 * this exact predicate and got fewer, so there were no others, so there are
 * none left. Only a full page can hide more work, and only then is a count
 * worth a full scan of `secret_versions` -- which is what it costs, since `kid`
 * carries no index of its own.
 *
 * Counted rather than subtracted. `outstanding - rekeyed` would be arithmetic
 * over a number read before the write, and this is the number an operator
 * watches fall to zero before deleting a key.
 */
async function remainingAfter(
  ctx: CoreContext,
  activeKid: string,
  pageLength: number,
  pageSize: number,
): Promise<number> {
  if (pageLength < pageSize) return 0;

  const rows = await ctx.db
    .select({ rows: count() })
    .from(secretVersions)
    .where(stalePredicate(activeKid));

  return rows[0]?.rows ?? 0;
}
