import { and, asc, desc, eq } from "drizzle-orm";

import { decryptSecretValue } from "../crypto/index.js";
import { secrets, secretVersions } from "../db/schema.js";
import { recordAudit } from "./audit.js";
import { requireKeyring, type CoreContext } from "./context.js";
import { environmentScope, requireEnvironment } from "./environments.js";
import { PrickError, toPrickError } from "./errors.js";
import { assertRole } from "./guards.js";

/**
 * THE READ PATH -- everything that takes ciphertext out of the database.
 *
 * Separated from the write path because the two have opposite failure rules and
 * it should be possible to check each one without reading the other:
 *
 *   a WRITE fails atomically, and the batch is the guarantee;
 *   a READ fails LOUDLY, and the audit row is the guarantee.
 *
 * Every function here decrypts, and none of them swallows a decrypt failure.
 * `listSecrets` marks the row and audits it, `revealSecret` and `exportSecrets`
 * throw. There is deliberately no `catch { continue }` anywhere in this file:
 * a tamper attempt that turns into a quietly shorter result is the exact defect
 * this design exists to reject.
 */

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
