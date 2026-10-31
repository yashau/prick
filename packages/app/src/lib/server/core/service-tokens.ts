import type {
  AdoptServiceTokenBody,
  CreateServiceTokenBody,
  RotateServiceTokenBody,
} from "@prick/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { assertNotLastAdminAfter } from "../auth/bootstrap.js";
import {
  CloudflareApiError,
  type AccessServiceTokens,
  type CloudflareServiceToken,
  type IssuedServiceToken,
} from "../cloudflare/access.js";
import { uuidv7 } from "../db/ids.js";
import { grants, identities, serviceTokens } from "../db/schema.js";
import { auditStatement, recordAudit } from "./audit.js";
import type { CoreContext } from "./context.js";
import { PrickError, notFound } from "./errors.js";
import { assertRole } from "./guards.js";
import { resolveGrantScope, type GrantRecord, type ResolvedScope } from "./identities.js";
import { readInstanceId } from "./instance.js";
import { runBatch } from "./sql.js";

/**
 * Cloudflare Access service tokens, created and retired from prick.
 *
 * The Worker asks Cloudflare for the token itself and records the identity, and
 * any grant it starts with, in the same transaction. The token's first request
 * is therefore already authorized, and once the Access application has a
 * Service Auth policy admitting service tokens, nothing about a token's life --
 * creating, rotating, extending or revoking it -- happens in the dashboard.
 *
 * WHO. Global administrators only, on every operation including the listing. A
 * token is a new identity; minting identities is global authority for the same
 * reason curating group membership is. A project administrator grants an
 * existing token within their project through `POST /grants`, as for any other
 * identity.
 *
 * ---------------------------------------------------------------------------
 * ORDERING: EVERY CRASH POINT LEAVES ACCESS NARROWER THAN INTENDED, NEVER WIDER.
 * ---------------------------------------------------------------------------
 * A D1 `batch()` cannot contain a Cloudflare call, so the order of the two is
 * the transaction design:
 *
 *   create   Cloudflare first, then one batch (identity, token row, grant,
 *            audit). A token that exists in Cloudflare with no row holds no grant
 *            and is refused by prick; it is deleted again on the spot, and found
 *            by `reconcile` from its `prick:<instance>:` name if that fails too.
 *   revoke   One batch first (identity disabled, row revoked, audit) -- the kill
 *            switch is in force from that moment -- then the Cloudflare delete.
 *            A delete that fails leaves a token prick already refuses.
 *   rotate   Cloudflare, then the batch. A secret whose rotation could not be
 *            recorded is never handed out.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT SECRET
 * ---------------------------------------------------------------------------
 * It exists in Cloudflare's response, in a local here, and in the value this
 * module returns to the transport -- which sends it once, with `no-store`. It is
 * never written to D1, never put in an audit row (the `service_token` detail has
 * no field that could hold it), never logged, and never thrown.
 */

export interface ServiceTokenCloudflareState {
  /** Epoch ms; `null` for a token created with `forever`. */
  expiresAt: number | null;
  lastSeenAt: number | null;
  enabled: boolean;
  duration: string | null;
  leakReportedAt: number | null;
}

export interface ServiceTokenRecord {
  id: string;
  identityId: string;
  /** The token's client id, which is also the identity's subject. */
  clientId: string;
  /** The identity's display name. */
  name: string | null;
  cloudflareId: string;
  cloudflareName: string;
  adopted: boolean;
  /** The identity's kill switch. */
  disabled: boolean;
  /**
   * `active`: managed and present in Cloudflare (or Cloudflare was not asked).
   * `revoked`: retired here. `missing`: not revoked, and Cloudflare no longer
   * has it -- deleted in the dashboard; `reconcile` retires the row.
   */
  status: "active" | "revoked" | "missing";
  createdAt: number;
  createdBy: string;
  rotatedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  /** Cloudflare's live view, or `null` when it was not available. */
  cloudflare: ServiceTokenCloudflareState | null;
}

export interface ServiceTokenList {
  tokens: ServiceTokenRecord[];
  /** `unavailable` when Cloudflare could not be asked; records are then D1's alone. */
  cloudflare: "ok" | "unavailable";
}

export interface IssuedServiceTokenResult {
  token: ServiceTokenRecord;
  grant: GrantRecord | null;
  clientId: string;
  /** Shown once. Never stored anywhere by prick. */
  clientSecret: string;
}

export interface RotatedServiceTokenResult {
  token: ServiceTokenRecord;
  clientId: string;
  /** Shown once. Never stored anywhere by prick. */
  clientSecret: string;
  /** When the previous secret stops working; `null` means it already has. */
  previousSecretExpiresAt: number | null;
  /** Set when the rotation succeeded but left something for the operator to do. */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Global admin, then the API. In that order, so a non-admin learns nothing about configuration. */
export async function authorizeAndConnect(ctx: CoreContext): Promise<AccessServiceTokens> {
  await assertRole(ctx, { type: "global" }, "admin");

  const config = ctx.config.cloudflare;
  if (config.state !== "enabled") {
    throw new PrickError(
      "SERVICE_TOKENS_UNCONFIGURED",
      "Service-token management is not configured on this server.",
      { hint: config.problem },
    );
  }

  if (ctx.serviceTokenApi === undefined) {
    throw new PrickError(
      "SERVICE_TOKENS_UNCONFIGURED",
      "Service-token management is not available on this request path.",
      { hint: "Service tokens are managed through /api/v1/service-tokens." },
    );
  }

  return ctx.serviceTokenApi;
}

/** A Cloudflare failure as this application's taxonomy, with a hint about what was left behind. */
export function upstream(error: unknown, leftBehind?: string): PrickError {
  if (error instanceof PrickError) return error;

  const suffix = leftBehind === undefined ? "" : ` ${leftBehind}`;

  if (error instanceof CloudflareApiError) {
    if (error.kind === "refused") {
      return new PrickError("SERVICE_TOKENS_UNCONFIGURED", error.message, {
        hint: `The CF_API_TOKEN secret must be an API token for this account with the permission "Access: Service Tokens Write" (in the dashboard: Access: Service Tokens → Edit).${suffix}`,
        cause: error,
      });
    }
    if (error.kind === "not_found") {
      return new PrickError("NOT_FOUND", "Cloudflare has no such service token.", {
        hint: `It may have been deleted in the dashboard. \`prk access token reconcile\` retires the record.${suffix}`,
        cause: error,
      });
    }

    const hints: Record<"unavailable" | "rejected" | "malformed", string> = {
      unavailable: "Cloudflare may be briefly unavailable; try again.",
      rejected:
        "Cloudflare refused the request itself, so retrying will not change the answer. The status and Cloudflare error code in the message say why; check the token's state in Cloudflare.",
      malformed:
        "Cloudflare answered in a shape prick does not recognise, which suggests its API changed. Retrying will not help; report it with the request id.",
    };
    return new PrickError("UPSTREAM_FAILED", error.message, {
      hint: `${hints[error.kind]}${suffix}`,
      cause: error,
    });
  }

  return new PrickError("UPSTREAM_FAILED", "The Cloudflare API call failed unexpectedly.", {
    ...(leftBehind === undefined ? {} : { hint: leftBehind }),
    cause: error,
  });
}

function cloudflareState(token: CloudflareServiceToken): ServiceTokenCloudflareState {
  return {
    expiresAt: token.expiresAt,
    lastSeenAt: token.lastSeenAt,
    enabled: token.enabled,
    duration: token.duration,
    leakReportedAt: token.leakReportedAt,
  };
}

interface JoinedRow {
  id: string;
  identityId: string;
  clientId: string;
  cloudflareId: string;
  cloudflareName: string;
  adopted: boolean;
  createdAt: number;
  createdBy: string;
  rotatedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  name: string | null;
  disabled: boolean;
}

export function selectJoined(ctx: CoreContext) {
  return ctx.db
    .select({
      id: serviceTokens.id,
      identityId: serviceTokens.identityId,
      clientId: serviceTokens.clientId,
      cloudflareId: serviceTokens.cloudflareId,
      cloudflareName: serviceTokens.cloudflareName,
      adopted: serviceTokens.adopted,
      createdAt: serviceTokens.createdAt,
      createdBy: serviceTokens.createdBy,
      rotatedAt: serviceTokens.rotatedAt,
      revokedAt: serviceTokens.revokedAt,
      revokedBy: serviceTokens.revokedBy,
      name: identities.displayName,
      disabled: identities.disabled,
    })
    .from(serviceTokens)
    .innerJoin(identities, eq(identities.id, serviceTokens.identityId));
}

function toRecord(
  row: JoinedRow,
  live: CloudflareServiceToken | null,
  cloudflareAsked: boolean,
): ServiceTokenRecord {
  const status: ServiceTokenRecord["status"] =
    row.revokedAt !== null ? "revoked" : cloudflareAsked && live === null ? "missing" : "active";

  return {
    id: row.id,
    identityId: row.identityId,
    clientId: row.clientId,
    name: row.name,
    cloudflareId: row.cloudflareId,
    cloudflareName: row.cloudflareName,
    adopted: row.adopted,
    disabled: row.disabled,
    status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    cloudflare: live === null ? null : cloudflareState(live),
  };
}

/** A live (not revoked) managed token, or a 404. */
async function requireActive(ctx: CoreContext, id: string): Promise<JoinedRow> {
  const rows = await selectJoined(ctx)
    .where(and(eq(serviceTokens.id, id), isNull(serviceTokens.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw notFound("service token");
  return row;
}

export async function requireInstance(ctx: CoreContext): Promise<string> {
  const instance = await readInstanceId(ctx.db);
  if (instance === null) {
    throw new PrickError("SERVER_MISCONFIGURED", "This database has no instance id.", {
      hint: "Apply the D1 migrations (`wrangler d1 migrations apply`); one of them writes the instance row.",
    });
  }
  return instance;
}

/** Cloudflare's current view of a token, or `null` when it cannot be had right now. */
async function liveOrNull(
  api: AccessServiceTokens,
  cloudflareId: string,
): Promise<CloudflareServiceToken | null> {
  try {
    return await api.get(cloudflareId);
  } catch {
    return null;
  }
}

/**
 * A statement that aborts its batch when the token is ALREADY revoked.
 *
 * It re-inserts the row under its own primary key, selecting it only when
 * `revoked_at` is set, so a revoke that lost a race fails on the primary key
 * before its audit row is written. Two concurrent revokes therefore produce one
 * revocation, one audit row and one `revoked_by` -- the mechanism the secret
 * write path uses for `expected_rev`, and the projection is written column by
 * column in declaration order for the reason given there.
 */
export function revokedGuard(ctx: CoreContext, id: string) {
  return ctx.db.insert(serviceTokens).select((qb) =>
    qb
      .select({
        id: serviceTokens.id,
        identityId: serviceTokens.identityId,
        cloudflareId: serviceTokens.cloudflareId,
        clientId: serviceTokens.clientId,
        cloudflareName: serviceTokens.cloudflareName,
        adopted: serviceTokens.adopted,
        createdAt: serviceTokens.createdAt,
        createdBy: serviceTokens.createdBy,
        rotatedAt: serviceTokens.rotatedAt,
        revokedAt: serviceTokens.revokedAt,
        revokedBy: serviceTokens.revokedBy,
      })
      .from(serviceTokens)
      .where(and(eq(serviceTokens.id, id), isNotNull(serviceTokens.revokedAt))),
  );
}

/** `prick:<instance>:` -- the prefix every token created by THIS deployment carries. */
export function cloudflareNamePrefix(instance: string): string {
  return `prick:${instance}:`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listServiceTokens(ctx: CoreContext): Promise<ServiceTokenList> {
  const api = await authorizeAndConnect(ctx);

  const rows = await selectJoined(ctx).orderBy(serviceTokens.createdAt);

  let live: Map<string, CloudflareServiceToken> | null = null;
  try {
    live = new Map((await api.list()).map((token) => [token.id, token]));
  } catch (error) {
    // A refused API token is configuration, and the operator needs the hint
    // that names the permission -- not a quiet "unavailable".
    if (error instanceof CloudflareApiError && error.kind === "refused") throw upstream(error);

    // An outage is different: the records are still worth showing, since which
    // identities are managed tokens, and who made them, is D1's to know. The
    // response says Cloudflare was not asked, so a reader does not mistake
    // "unknown" for "missing".
    live = null;
  }

  return {
    tokens: rows.map((row) =>
      toRecord(
        row,
        row.revokedAt === null ? (live?.get(row.cloudflareId) ?? null) : null,
        live !== null,
      ),
    ),
    cloudflare: live === null ? "unavailable" : "ok",
  };
}

export async function createServiceToken(
  ctx: CoreContext,
  input: CreateServiceTokenBody,
): Promise<IssuedServiceTokenResult> {
  const api = await authorizeAndConnect(ctx);

  // Every refusal that can be decided locally is decided BEFORE Cloudflare is
  // asked for anything, so a 404 on the grant's project leaves nothing behind.
  const scope: ResolvedScope | null =
    input.grant === undefined ? null : await resolveGrantScope(ctx, input.grant);
  if (scope !== null) await assertRole(ctx, scope.scope, "admin");

  const instance = await requireInstance(ctx);
  const id = uuidv7(ctx.now);
  const cloudflareName = `${cloudflareNamePrefix(instance)}${id}`;

  let issued: IssuedServiceToken;
  try {
    issued = await api.create({ name: cloudflareName, duration: input.duration });
  } catch (error) {
    throw upstream(error);
  }

  const existing = await ctx.db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.kind, "service"), eq(identities.subject, issued.clientId)))
    .limit(1);

  const identityId = existing[0]?.id ?? uuidv7(ctx.now);
  const grantId = scope === null ? null : uuidv7(ctx.now);

  const statements = [
    existing[0] === undefined
      ? ctx.db.insert(identities).values({
          id: identityId,
          kind: "service",
          subject: issued.clientId,
          displayName: input.name,
          disabled: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          lastSeenAt: null,
        })
      : ctx.db
          .update(identities)
          .set({ displayName: input.name, updatedAt: ctx.now })
          .where(eq(identities.id, identityId)),
    ctx.db.insert(serviceTokens).values({
      id,
      identityId,
      cloudflareId: issued.id,
      clientId: issued.clientId,
      cloudflareName,
      adopted: false,
      createdAt: ctx.now,
      createdBy: ctx.actor.subject,
    }),
    ...(scope === null || grantId === null || input.grant === undefined
      ? []
      : [
          ctx.db.insert(grants).values({
            id: grantId,
            identityId,
            role: input.grant.role,
            scopeType: input.grant.scope_type,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            expiresAt: input.grant.expires_at,
            createdAt: ctx.now,
            createdBy: ctx.actor.subject,
          }),
          auditStatement(ctx, {
            action: "grant.create",
            outcome: "success",
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            detail: {
              kind: "grant",
              role: input.grant.role,
              scopeType: input.grant.scope_type,
              subject: issued.clientId,
              expiresAt: input.grant.expires_at,
            },
          }),
        ]),
    auditStatement(ctx, {
      action: "service_token.create",
      outcome: "success",
      detail: {
        kind: "service_token",
        clientId: issued.clientId,
        name: input.name,
        duration: input.duration,
      },
    }),
  ];

  try {
    await runBatch(ctx.db, statements);
  } catch (error) {
    // Nothing recorded, so the token must not outlive this request: nobody will
    // ever see its secret, and a credential prick has no record of is one an
    // operator cannot find to revoke.
    let compensated = false;
    try {
      await api.remove(issued.id);
      compensated = true;
    } catch {
      compensated = false;
    }

    try {
      await recordAudit(ctx, {
        action: "service_token.create",
        outcome: "error",
        detail: { kind: "service_token", clientId: issued.clientId, name: input.name, compensated },
      });
    } catch {
      // The write already failed; the database is the thing that is broken.
    }

    throw new PrickError("INTERNAL", "The service token could not be recorded.", {
      hint: compensated
        ? "It was deleted from Cloudflare again, so nothing was left behind. Try again."
        : `It could not be deleted from Cloudflare either. \`prk access token reconcile --apply\` removes it (name ${cloudflareName}).`,
      cause: error,
    });
  }

  const row: JoinedRow = {
    id,
    identityId,
    clientId: issued.clientId,
    cloudflareId: issued.id,
    cloudflareName,
    adopted: false,
    createdAt: ctx.now,
    createdBy: ctx.actor.subject,
    rotatedAt: null,
    revokedAt: null,
    revokedBy: null,
    name: input.name,
    disabled: false,
  };

  // The create response carries no expiry. Ask for the token, and report the
  // expiry as unknown -- never as "never expires" -- if that fails.
  const live = await liveOrNull(api, issued.id);

  return {
    token: toRecord(row, live, live !== null),
    grant:
      scope === null || grantId === null || input.grant === undefined
        ? null
        : {
            id: grantId,
            identityId,
            subject: issued.clientId,
            role: input.grant.role,
            scopeType: input.grant.scope_type,
            projectSlug: scope.projectSlug,
            environmentSlug: scope.environmentSlug,
            expiresAt: input.grant.expires_at,
          },
    clientId: issued.clientId,
    clientSecret: issued.clientSecret,
  };
}

export async function rotateServiceToken(
  ctx: CoreContext,
  id: string,
  input: RotateServiceTokenBody,
): Promise<RotatedServiceTokenResult> {
  const api = await authorizeAndConnect(ctx);
  const row = await requireActive(ctx, id);

  const previousSecretExpiresAt =
    input.grace_seconds > 0 ? ctx.now + input.grace_seconds * 1000 : null;

  let before: CloudflareServiceToken;
  try {
    before = await api.get(row.cloudflareId);
  } catch (error) {
    throw upstream(error);
  }

  // Cloudflare discards a leaked secret at rotation and refuses a grace period
  // for it. Saying so here beats relaying a bare 400.
  if (before.leakReportedAt !== null && previousSecretExpiresAt !== null) {
    throw new PrickError(
      "CONFLICT",
      "Cloudflare reported this token's secret as leaked, so the previous secret cannot be kept.",
      {
        hint: "Rotate without a grace period. The leaked secret stops working at once; update the job with the new secret straight after.",
      },
    );
  }

  let issued: IssuedServiceToken;
  try {
    issued = await api.rotate(row.cloudflareId, previousSecretExpiresAt);
  } catch (error) {
    throw upstream(error);
  }

  // Cloudflare disables a token reported as leaked, and allows re-enabling it
  // only once the secret has been rotated -- which it now has. A token disabled
  // for any other reason is re-enabled too: rotating is the operator saying the
  // token should work.
  const needsEnabling = before.leakReportedAt !== null || !before.enabled;
  let warning: string | null = null;
  if (needsEnabling) {
    try {
      await api.enable(row.cloudflareId);
    } catch {
      warning =
        "The secret was rotated, but Cloudflare did not re-enable the token, so it still cannot authenticate. Rotate again, or enable it in Cloudflare.";
    }
  }

  try {
    await runBatch(ctx.db, [
      ctx.db.update(serviceTokens).set({ rotatedAt: ctx.now }).where(eq(serviceTokens.id, id)),
      auditStatement(ctx, {
        action: "service_token.rotate",
        outcome: "success",
        detail: {
          kind: "service_token",
          clientId: row.clientId,
          name: row.name ?? row.clientId,
          graceSeconds: input.grace_seconds,
          ...(needsEnabling ? { reenabled: warning === null } : {}),
        },
      }),
    ]);
  } catch (error) {
    // An unrecorded rotation is not handed out. The secret it produced is
    // discarded here, so the caller rotates again rather than receiving a
    // credential the audit log has no trace of.
    throw new PrickError(
      "INTERNAL",
      "The rotation could not be recorded, so its secret was discarded.",
      {
        hint:
          previousSecretExpiresAt === null
            ? "The previous secret has already stopped working. Rotate again to obtain a usable one."
            : "The previous secret keeps working for the grace period. Rotate again.",
        cause: error,
      },
    );
  }

  const live = await liveOrNull(api, row.cloudflareId);

  return {
    token: toRecord({ ...row, rotatedAt: ctx.now }, live, live !== null),
    clientId: row.clientId,
    clientSecret: issued.clientSecret,
    previousSecretExpiresAt,
    warning,
  };
}

export async function refreshServiceToken(
  ctx: CoreContext,
  id: string,
): Promise<ServiceTokenRecord> {
  const api = await authorizeAndConnect(ctx);
  const row = await requireActive(ctx, id);

  let refreshed: CloudflareServiceToken;
  try {
    refreshed = await api.refresh(row.cloudflareId);
  } catch (error) {
    throw upstream(error);
  }

  // The change is Cloudflare's; D1 has nothing to write but the record of it.
  await recordAudit(ctx, {
    action: "service_token.refresh",
    outcome: "success",
    detail: { kind: "service_token", clientId: row.clientId, name: row.name ?? row.clientId },
  });

  return toRecord(row, refreshed, true);
}

export async function revokeServiceToken(ctx: CoreContext, id: string): Promise<void> {
  const api = await authorizeAndConnect(ctx);
  const row = await requireActive(ctx, id);

  // Disabling outranks every grant the identity holds, by any route -- so a
  // token that is the last global administrator is guarded like any other.
  await assertNotLastAdminAfter(ctx, { identityId: row.identityId });

  try {
    await runBatch(ctx.db, [
      revokedGuard(ctx, id),
      ctx.db
        .update(identities)
        .set({ disabled: true, updatedAt: ctx.now })
        .where(eq(identities.id, row.identityId)),
      ctx.db
        .update(serviceTokens)
        .set({ revokedAt: ctx.now, revokedBy: ctx.actor.subject })
        .where(and(eq(serviceTokens.id, id), isNull(serviceTokens.revokedAt))),
      auditStatement(ctx, {
        action: "service_token.revoke",
        outcome: "success",
        detail: { kind: "service_token", clientId: row.clientId, name: row.name ?? row.clientId },
      }),
    ]);
  } catch (error) {
    // The guard fired: another request revoked it first, and wrote the record.
    if (/UNIQUE constraint failed: service_tokens\.id/i.test(String(error))) {
      throw notFound("service token");
    }
    throw error;
  }

  try {
    await api.remove(row.cloudflareId);
  } catch (error) {
    throw upstream(
      error,
      "The token is already disabled in prick and refused on every request; `prk access token reconcile --apply` finishes deleting it from Cloudflare.",
    );
  }
}

export async function adoptServiceToken(
  ctx: CoreContext,
  input: AdoptServiceTokenBody,
): Promise<ServiceTokenRecord> {
  const api = await authorizeAndConnect(ctx);

  let live: CloudflareServiceToken[];
  try {
    live = await api.list();
  } catch (error) {
    throw upstream(error);
  }

  const token = live.find((candidate) => candidate.clientId === input.client_id);
  if (token === undefined) {
    throw new PrickError("NOT_FOUND", "Cloudflare has no service token with that client id.", {
      hint: "Check the client id; it ends in `.access`. A token in another account cannot be adopted.",
    });
  }

  const managed = await ctx.db
    .select({ id: serviceTokens.id })
    .from(serviceTokens)
    .where(eq(serviceTokens.cloudflareId, token.id))
    .limit(1);
  if (managed[0] !== undefined) {
    throw new PrickError("CONFLICT", "That service token is already managed here.", {
      hint: "`prk access token list` shows it.",
    });
  }

  const existing = await ctx.db
    .select({
      id: identities.id,
      displayName: identities.displayName,
      disabled: identities.disabled,
    })
    .from(identities)
    .where(and(eq(identities.kind, "service"), eq(identities.subject, token.clientId)))
    .limit(1);

  const identity = existing[0];
  const identityId = identity?.id ?? uuidv7(ctx.now);
  const name = input.name ?? identity?.displayName ?? (token.name === "" ? null : token.name);
  const id = uuidv7(ctx.now);

  await runBatch(ctx.db, [
    identity === undefined
      ? ctx.db.insert(identities).values({
          id: identityId,
          kind: "service",
          subject: token.clientId,
          displayName: name,
          disabled: false,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          lastSeenAt: null,
        })
      : ctx.db
          .update(identities)
          .set({ displayName: name, updatedAt: ctx.now })
          .where(eq(identities.id, identityId)),
    ctx.db.insert(serviceTokens).values({
      id,
      identityId,
      cloudflareId: token.id,
      clientId: token.clientId,
      cloudflareName: token.name,
      adopted: true,
      createdAt: ctx.now,
      createdBy: ctx.actor.subject,
    }),
    auditStatement(ctx, {
      action: "service_token.adopt",
      outcome: "success",
      detail: { kind: "service_token", clientId: token.clientId, name: name ?? token.clientId },
    }),
  ]);

  return toRecord(
    {
      id,
      identityId,
      clientId: token.clientId,
      cloudflareId: token.id,
      cloudflareName: token.name,
      adopted: true,
      createdAt: ctx.now,
      createdBy: ctx.actor.subject,
      rotatedAt: null,
      revokedAt: null,
      revokedBy: null,
      name,
      disabled: identity?.disabled ?? false,
    },
    token,
    true,
  );
}
