import type { RollbackBody } from "@prick/shared";
import { and, eq, sql } from "drizzle-orm";

import { decryptSecretValue, encryptSecretValue } from "../crypto/index.js";
import { uuidv7 } from "../db/ids.js";
import { environments, secrets, secretVersions } from "../db/schema.js";
import { auditStatement, recordAudit } from "./audit.js";
import { requireKeyring, type CoreContext } from "./context.js";
import { environmentScope, requireEnvironment } from "./environments.js";
import { PrickError, toPrickError } from "./errors.js";
import { assertRole } from "./guards.js";
import { readKeyState } from "./secret-state.js";
import { runBatch, type Statement } from "./sql.js";

/**
 * MOVING A VALUE THAT ALREADY EXISTS: rename and rollback.
 *
 * The two live together because they are the same operation seen from two
 * angles. Both take a value that is already sealed and give it a NEW identity
 * -- a new key name for `renameSecret`, a new version for `rollbackSecret` --
 * and the AAD binds a ciphertext to `(purpose, environment_id, key, version)`,
 * so neither can be a row update. Both must DECRYPT under the old identity and
 * RE-ENCRYPT under the new one. There is no cheap rename and no cheap rollback,
 * and this file is where that cost is paid.
 *
 * Both are also one `batch()` each, assembled inline below so the whole
 * transaction is a single array literal you can read top to bottom, ending in
 * the audit statement. The bulk write path -- where the statement count is
 * variable and the chunking arithmetic lives -- is in `secrets.ts`.
 */

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
