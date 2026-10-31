import type { ReconcileServiceTokensBody } from "@prick/shared";
import { and, eq, isNull } from "drizzle-orm";

import { assertNotLastAdminAfter } from "../auth/bootstrap.js";
import {
  CloudflareApiError,
  type AccessServiceTokens,
  type CloudflareServiceToken,
} from "../cloudflare/access.js";
import { uuidv7Timestamp } from "../db/ids.js";
import { identities, serviceTokens } from "../db/schema.js";
import { auditStatement, recordAudit } from "./audit.js";
import type { CoreContext } from "./context.js";
import { PrickError } from "./errors.js";
import {
  authorizeAndConnect,
  cloudflareNamePrefix,
  requireInstance,
  revokedGuard,
  selectJoined,
  upstream,
} from "./service-tokens.js";
import { runBatch } from "./sql.js";

/**
 * Reconciling prick's service-token records with Cloudflare's.
 *
 * Split from `service-tokens.ts`, whose ordering rules it follows: a repair is
 * one batch with its audit row, or a Cloudflare delete followed by its audit
 * row, and nothing it does can widen access.
 */

export interface ReconcileEntry {
  kind: "orphan" | "missing" | "revoke_incomplete" | "foreign";
  cloudflareId: string;
  clientId: string;
  /** Cloudflare's name for the token, or the identity's display name. */
  name: string | null;
  /** True when `apply` repaired it. `foreign` entries are never touched. */
  applied: boolean;
  /**
   * True when the entry is reported but not repaired: too recent to judge, no
   * longer eligible when `apply` re-checked it, or another deployment's.
   */
  skipped: boolean;
  /** Why it was skipped. */
  reason: string | null;
  /** Why an attempted repair failed. Never carries a response body. */
  error: string | null;
}

export interface ReconcileResult {
  applied: boolean;
  entries: ReconcileEntry[];
}

/**
 * How old a disagreement must be before reconcile judges it.
 *
 * Reconcile lists Cloudflare and then reads D1, and a create or revoke can land
 * between the two: a token created a second ago is in Cloudflare before its row
 * commits, and a revoke disables the row before it deletes the token. Anything
 * younger than this is reported as `skipped` and never repaired, so reconcile
 * cannot delete a token another request is still recording.
 */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;

/**
 * The most `missing` tokens one apply will retire.
 *
 * Every live token reading as missing is far more often `CF_ACCOUNT_ID` naming
 * the wrong account than a mass deletion in the dashboard, and retiring them all
 * would disable every machine identity at once. So a large or total `missing`
 * set is a refusal, not a repair.
 */
export const RECONCILE_MISSING_LIMIT = 10;

/** The creation time encoded in a `prick:<instance>:<uuidv7>` name, or `null`. */
function createdAtFromName(name: string, prefix: string): number | null {
  try {
    return uuidv7Timestamp(name.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * Compare D1 with Cloudflare, and with `apply`, make them agree.
 *
 * Only tokens this deployment owns are ever touched: a row here, or a Cloudflare
 * name carrying THIS instance's prefix. A `prick:<other instance>:` token belongs
 * to another deployment sharing the account and is reported as `foreign`; a token
 * with any other name was made by hand and is not mentioned at all.
 *
 * `apply` re-checks each entry immediately before repairing it and skips any
 * that has stopped being eligible since the listing, saying why.
 */
export async function reconcileServiceTokens(
  ctx: CoreContext,
  input: ReconcileServiceTokensBody,
): Promise<ReconcileResult> {
  const api = await authorizeAndConnect(ctx);
  const instance = await requireInstance(ctx);
  const prefix = cloudflareNamePrefix(instance);

  // `ctx.now` was taken before the listing below, so it is the moment the
  // comparison starts; ages are measured against it.
  const cutoff = ctx.now - RECONCILE_MIN_AGE_MS;
  const tooNew =
    "Too recent to judge safely; a create or revoke may still be in flight. Run reconcile again in a few minutes.";

  let live: CloudflareServiceToken[];
  try {
    live = await api.list();
  } catch (error) {
    throw upstream(error);
  }

  const rows = await selectJoined(ctx);
  const byCloudflareId = new Map(rows.map((row) => [row.cloudflareId, row]));
  const liveIds = new Set(live.map((token) => token.id));

  const entries: ReconcileEntry[] = [];
  const entry = (
    kind: ReconcileEntry["kind"],
    cloudflareId: string,
    clientId: string,
    name: string | null,
    skipReason: string | null,
  ): ReconcileEntry => ({
    kind,
    cloudflareId,
    clientId,
    name,
    applied: false,
    skipped: skipReason !== null,
    reason: skipReason,
    error: null,
  });

  for (const token of live) {
    if (byCloudflareId.has(token.id) || !token.name.startsWith("prick:")) continue;

    if (!token.name.startsWith(prefix)) {
      entries.push(
        entry("foreign", token.id, token.clientId, token.name, "Another deployment's token."),
      );
      continue;
    }

    const createdAt = createdAtFromName(token.name, prefix);
    const skip =
      createdAt === null
        ? "The name carries this deployment's prefix but no id prick issued."
        : createdAt > cutoff
          ? tooNew
          : null;
    entries.push(entry("orphan", token.id, token.clientId, token.name, skip));
  }

  for (const row of rows) {
    const present = liveIds.has(row.cloudflareId);
    if (row.revokedAt === null && !present) {
      entries.push(
        entry(
          "missing",
          row.cloudflareId,
          row.clientId,
          row.name,
          row.createdAt > cutoff ? tooNew : null,
        ),
      );
    } else if (row.revokedAt !== null && present) {
      entries.push(
        entry(
          "revoke_incomplete",
          row.cloudflareId,
          row.clientId,
          row.name,
          row.revokedAt > cutoff ? tooNew : null,
        ),
      );
    }
  }

  if (!input.apply) return { applied: false, entries };

  const missing = entries.filter((candidate) => candidate.kind === "missing" && !candidate.skipped);
  const liveRows = rows.filter((row) => row.revokedAt === null).length;
  if (
    missing.length > RECONCILE_MISSING_LIMIT ||
    (missing.length >= 2 && missing.length === liveRows)
  ) {
    throw new PrickError(
      "CONFLICT",
      `Cloudflare reports ${String(missing.length)} of the ${String(liveRows)} live service tokens missing. Nothing was changed.`,
      {
        hint: "That is more often CF_ACCOUNT_ID naming the wrong account than tokens deleted in the dashboard. Check the account id; to retire tokens that really are gone, revoke them one at a time with `prk access token revoke`.",
      },
    );
  }

  for (const candidate of entries) {
    if (candidate.kind === "foreign" || candidate.skipped) continue;

    try {
      if (candidate.kind === "missing") {
        const row = byCloudflareId.get(candidate.cloudflareId);
        if (row === undefined) continue;

        // Still missing? A token Cloudflare answers for is not retired.
        const now = await liveOrAbsent(api, candidate.cloudflareId);
        if (now !== "absent") {
          candidate.skipped = true;
          candidate.reason = "Cloudflare has the token after all; nothing was changed.";
          continue;
        }

        await assertNotLastAdminAfter(ctx, { identityId: row.identityId });
        try {
          await runBatch(ctx.db, [
            revokedGuard(ctx, row.id),
            ctx.db
              .update(identities)
              .set({ disabled: true, updatedAt: ctx.now })
              .where(eq(identities.id, row.identityId)),
            ctx.db
              .update(serviceTokens)
              .set({ revokedAt: ctx.now, revokedBy: ctx.actor.subject })
              .where(and(eq(serviceTokens.id, row.id), isNull(serviceTokens.revokedAt))),
            auditStatement(ctx, {
              action: "service_token.reconcile",
              outcome: "success",
              detail: {
                kind: "service_token",
                clientId: row.clientId,
                name: row.name ?? row.clientId,
                drift: "missing",
              },
            }),
          ]);
        } catch (error) {
          if (/UNIQUE constraint failed: service_tokens\.id/i.test(String(error))) {
            candidate.skipped = true;
            candidate.reason = "Revoked by another request since the check.";
            continue;
          }
          throw error;
        }
      } else {
        if (candidate.kind === "orphan") {
          // Still unrecorded? A row that committed since the listing owns it now.
          const recorded = await ctx.db
            .select({ id: serviceTokens.id })
            .from(serviceTokens)
            .where(eq(serviceTokens.cloudflareId, candidate.cloudflareId))
            .limit(1);
          if (recorded[0] !== undefined) {
            candidate.skipped = true;
            candidate.reason = "Recorded by another request since the check; nothing was changed.";
            continue;
          }
        }

        await api.remove(candidate.cloudflareId);
        await recordAudit(ctx, {
          action: "service_token.reconcile",
          outcome: "success",
          detail: {
            kind: "service_token",
            clientId: candidate.clientId,
            name: candidate.name ?? candidate.clientId,
            drift: candidate.kind,
          },
        });
      }
      candidate.applied = true;
    } catch (error) {
      candidate.error = error instanceof Error ? error.message : "The repair failed.";
    }
  }

  return { applied: true, entries };
}

/** Cloudflare's view of a token, `"absent"` when it has none, or a throw for anything else. */
async function liveOrAbsent(
  api: AccessServiceTokens,
  cloudflareId: string,
): Promise<CloudflareServiceToken | "absent"> {
  try {
    return await api.get(cloudflareId);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.kind === "not_found") return "absent";
    throw error;
  }
}
