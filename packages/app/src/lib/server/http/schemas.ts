import {
  AuditQuery,
  EpochMillis,
  Id,
  IdentityKind,
  Revision,
  Role,
  ScopeType,
  SecretKey,
  Slug,
} from "@prick/shared";
import { z } from "zod";

import type { AuditEntryView, AuditPage } from "../core/audit.js";
import type { EnvironmentSummary } from "../core/environments.js";
import type { GrantRecord, IdentityRecord, UnknownIdentity } from "../core/identities.js";
import type { EffectivePermissions } from "../core/permissions.js";
import type { GroupGrantRecord, GroupMemberRecord, GroupRecord } from "../core/groups.js";
import type { KeyringStatus } from "../core/keyring.js";
import type { ProjectSummary } from "../core/projects.js";
import type {
  ImportResult,
  SecretListEntry,
  VersionEntry,
  WriteSecretsResult,
} from "../core/secrets.js";

/**
 * Schemas that belong to the HTTP transport rather than to the domain.
 *
 * `@prick/shared` owns every REQUEST BODY, because the browser bundle and the
 * MCP package validate against the same objects the Worker does. What lives here
 * is the part that only exists because there is an HTTP request in the first
 * place:
 *
 *   - path parameters, which are a routing concept
 *   - query strings, which arrive as strings and therefore need coercion that a
 *     shared body schema must not have
 *   - RESPONSE shapes, which exist to be published in the OpenAPI document
 *
 * Every object here is `.strict()`, including the path-parameter objects. That
 * is not decorative on a path: `.strict()` is what makes the schema a total
 * description of the route's parameters, so adding a `:segment` without adding
 * it here fails loudly instead of being silently unvalidated.
 */

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const ProjectParams = z.object({ project: Slug }).strict();

/**
 * The environment-scoped parameter pair.
 *
 * `project` and `env` are named identically on BOTH mounts of the environment
 * router -- `/projects/:project/environments/:env` and `/p/:project/e/:env` --
 * which is what lets one sub-application serve the canonical route and the CLI
 * alias without a second set of handlers reading differently-named params.
 */
export const EnvironmentParams = z.object({ project: Slug, env: Slug }).strict();

export const SecretKeyParams = EnvironmentParams.extend({ key: SecretKey }).strict();

/** The `:reveal` custom-method suffix, stripped before the key is validated. */
const REVEAL_SUFFIX = ":reveal";

/**
 * The reveal route's parameters.
 *
 * ONE HANDLER SERVES TWO SPELLINGS, and it has to, because Hono cannot express
 * the second one as a path. A segment like `:key{...}:reveal` does not parse:
 * Hono's parameter grammar is `^:([^{}]+)(?:\{(.+)\})?$` over a whole segment,
 * so a literal suffix after the pattern makes the label static rather than
 * parameterised. Registering `/secrets/:key` once and stripping the suffix here
 * is the only shape that serves both.
 *
 * It is unambiguous because `SecretKey` is a POSIX environment-variable name and
 * therefore cannot contain a colon. `DATABASE_URL:reveal` has exactly one parse.
 * The strip runs BEFORE `SecretKey` validates, so `FOO:reveal:reveal` strips one
 * suffix, fails the key grammar, and is a 422 rather than something clever.
 */
export const RevealParams = EnvironmentParams.extend({
  key: z
    .string()
    .transform((value) =>
      value.endsWith(REVEAL_SUFFIX) ? value.slice(0, -REVEAL_SUFFIX.length) : value,
    )
    .pipe(SecretKey),
}).strict();

export const IdParams = z.object({ id: Id }).strict();

/**
 * A membership, addressed as the pair it is.
 *
 * `group_members` has no surrogate key, and this is why that is comfortable
 * rather than awkward: a removal names the group and the identity, both of which
 * the caller already has, instead of requiring a lookup to turn the pair into an
 * id and then post the id back.
 */
export const GroupMemberParams = z.object({ id: Id, identityId: Id }).strict();

/**
 * A group's grant, addressed through the group.
 *
 * Both halves are validated and both are checked in `core`, so a grant id from
 * another group is a 404 rather than a revocation of somebody else's access
 * because a UI paired the wrong two values.
 */
export const GroupGrantParams = z.object({ id: Id, grantId: Id }).strict();

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

/**
 * `AuditQuery`, with the three numeric fields coerced.
 *
 * A query string is text. `AuditQuery` in `@prick/shared` declares `since`,
 * `until` and `limit` as `z.number()`, which is right for the body-shaped
 * consumers that build the object in JavaScript and wrong for a URL, where
 * `?limit=50` arrives as `"50"` and would be rejected as "expected number,
 * received string".
 *
 * Coercing HERE rather than loosening the shared schema keeps the coercion at
 * the one boundary that needs it. The shared schema stays the strict statement
 * of what `queryAudit` accepts, and `z.infer` of this one is assignable to it --
 * asserted below, so the two cannot drift.
 */
export const AuditQueryParams = AuditQuery.extend({
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/**
 * `reason` on a reveal.
 *
 * Restated rather than imported from `@prick/shared` for one reason: `.strict()`
 * on a query object means an unknown parameter is a 422, and `RevealQuery` over
 * there is already exactly this. It is re-exported so a route imports its query
 * schema from the same module as its path schema.
 */
export { RevealQuery } from "@prick/shared";

// ---------------------------------------------------------------------------
// Request bodies with no home in `@prick/shared`
// ---------------------------------------------------------------------------

/**
 * Rename a key.
 *
 * There is no cheap rename and this body cannot make one look cheap: `core`
 * decrypts under the old key's AAD and re-encrypts under the new one, in a
 * single batch. The body carries names only, which is the whole point -- a
 * rename never transports a value in either direction.
 */
export const RenameBody = z.object({ from: SecretKey, to: SecretKey }).strict();
export type RenameBody = z.infer<typeof RenameBody>;

/**
 * One page of a rekey.
 *
 * Bounded because a rekey re-encrypts row by row inside a single invocation and
 * `batch()` has a documented 30 s ceiling. The cron trigger and this endpoint
 * drive the same function; the limit is what makes it resumable rather than a
 * request that either finishes or times out having done an unknown amount.
 */
export const RekeyBody = z
  .object({ limit: z.number().int().min(1).max(1000).default(100) })
  .strict();
export type RekeyBody = z.infer<typeof RekeyBody>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/*
 * These exist to be PUBLISHED, not to be enforced.
 *
 * Nothing validates a response against them at runtime: `core` is the authority
 * on what it returns, re-parsing its output on the way out would cost a full
 * schema walk per request, and a mismatch would surface as a 500 on a request
 * that actually succeeded. What they buy is a truthful OpenAPI document -- and,
 * through the assertions at the bottom of this file, a COMPILE error the moment
 * a `core` return type changes without the document changing with it.
 *
 * That is the drift problem this project has three consumers of: the Rust
 * models, the browser client's mirrored interfaces, and the MCP projections. A
 * document generated from hand-written prose would go stale silently. This one
 * cannot: `pnpm typecheck` fails first.
 */

export const ProjectSummaryResponse = z
  .object({
    id: Id,
    slug: Slug,
    name: z.string(),
    description: z.string().nullable(),
    environmentCount: z.number().int().nonnegative(),
    updatedAt: EpochMillis,
  })
  .strict();

export const EnvironmentSummaryResponse = z
  .object({
    id: Id,
    projectId: Id,
    slug: Slug,
    name: z.string(),
    description: z.string().nullable(),
    /** Round-trip as `expected_rev`, or as the `ETag` of the secret collection. */
    rev: Revision,
    secretCount: z.number().int().nonnegative(),
    updatedAt: EpochMillis,
  })
  .strict();

/**
 * A secret in a LIST. There is no `value` field and there must never be one.
 *
 * `unreadable` is the loud half of the contract: a row whose envelope failed its
 * AEAD tag comes back MARKED rather than omitted. A list that silently drops
 * what it could not read turns a tamper attempt into a shorter `.env` file, and
 * a shorter `.env` file into a production deploy with no `DATABASE_URL`.
 */
export const SecretListEntryResponse = z
  .object({
    key: SecretKey,
    description: z.string().nullable(),
    version: z.number().int().positive(),
    updatedAt: EpochMillis,
    updatedBy: z.string(),
    /** The master key id the current version is sealed under. Not secret. */
    kid: z.string().nullable(),
    unreadable: z.boolean(),
  })
  .strict();

export const VersionEntryResponse = z
  .object({
    version: z.number().int().positive(),
    op: z.string(),
    createdAt: EpochMillis,
    createdBy: z.string(),
    kid: z.string().nullable(),
    /** A tombstone: this version records the key's deletion. */
    deleted: z.boolean(),
  })
  .strict();

export const WriteSecretsResultResponse = z
  .object({
    /** The environment's revision AFTER the write. Send it back as `If-Match`. */
    rev: Revision,
    added: z.array(SecretKey),
    changed: z.array(SecretKey),
    removed: z.array(SecretKey),
  })
  .strict();

/**
 * The import diff. KEY NAMES AND CHANGE KINDS ONLY.
 *
 * `changed` means "this key already existed and is being rewritten". It does NOT
 * mean "the value differs", and it cannot: telling those apart would require
 * decrypting every existing value to compare, which is a silent full-environment
 * reveal performed by the screen whose entire purpose is to avoid one.
 */
export const ImportResultResponse = z
  .object({
    added: z.array(SecretKey),
    changed: z.array(SecretKey),
    removed: z.array(SecretKey),
    /** `false` for a dry run. */
    applied: z.boolean(),
    warnings: z.array(
      z.object({ line: z.number().int(), key: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();

/**
 * ONE decrypted value.
 *
 * There is no `version` field, and its absence is a `core` limitation rather
 * than an oversight: `revealSecret` returns the plaintext and nothing else, and
 * obtaining the version would cost a second resolution of the environment and a
 * third query for a number the caller did not ask for.
 */
export const RevealResponse = z.object({ key: SecretKey, value: z.string() }).strict();

/** The whole environment, decrypted. A flat map, exactly as `core` returns it. */
export const ExportResponse = z.record(SecretKey, z.string());

export const IdentityRecordResponse = z
  .object({
    id: Id,
    kind: IdentityKind,
    subject: z.string(),
    displayName: z.string().nullable(),
    disabled: z.boolean(),
    lastSeenAt: EpochMillis.nullable(),
  })
  .strict();

export const GrantRecordResponse = z
  .object({
    id: Id,
    identityId: Id,
    subject: z.string(),
    role: Role,
    scopeType: ScopeType,
    projectSlug: Slug.nullable(),
    environmentSlug: Slug.nullable(),
    expiresAt: EpochMillis.nullable(),
  })
  .strict();

export const GroupRecordResponse = z
  .object({
    id: Id,
    slug: Slug,
    name: z.string(),
    description: z.string().nullable(),
    /** Members, and live grants. Both zero is a group that confers nothing. */
    memberCount: z.number().int().nonnegative(),
    grantCount: z.number().int().nonnegative(),
    updatedAt: EpochMillis,
  })
  .strict();

export const GroupMemberRecordResponse = z
  .object({
    identityId: Id,
    kind: IdentityKind,
    subject: z.string(),
    displayName: z.string().nullable(),
    /** The kill switch. A disabled member of a privileged group holds nothing. */
    disabled: z.boolean(),
    addedAt: EpochMillis,
    addedBy: z.string(),
  })
  .strict();

export const GroupGrantRecordResponse = z
  .object({
    id: Id,
    groupId: Id,
    groupSlug: Slug,
    role: Role,
    scopeType: ScopeType,
    projectSlug: Slug.nullable(),
    environmentSlug: Slug.nullable(),
    expiresAt: EpochMillis.nullable(),
  })
  .strict();

/** A group named as the provenance of a role. */
const GroupRefResponse = z.object({ id: Id, slug: Slug, name: z.string() }).strict();

/**
 * ONE ROW THAT CONFERS A ROLE, named well enough to be acted on.
 *
 * This is the field that makes the effective-permissions view worth having.
 * `role: "admin"` is not an answer to "why does Bob have production" -- `via:
 * "group"`, `group: {slug: "platform"}`, `scopeType: "project"`, `grantId: …` is,
 * because it says both what to look at and what to delete.
 *
 * `grantId` is nullable for exactly one source: `via: "bootstrap"`, which comes
 * from the `BOOTSTRAP_ADMINS` var and has no row behind it anywhere. That is the
 * source an operator would otherwise never find, having searched the database
 * for it.
 */
const PermissionSourceResponse = z
  .object({
    via: z.enum(["direct", "group", "bootstrap"]),
    grantId: Id.nullable(),
    role: Role,
    /** Where the GRANT sits, which may be broader than the scope it explains. */
    scopeType: ScopeType,
    projectSlug: Slug.nullable(),
    environmentSlug: Slug.nullable(),
    group: GroupRefResponse.nullable(),
    expiresAt: EpochMillis.nullable(),
    /** The one that set `role` on the entry. None, for a disabled identity. */
    decisive: z.boolean(),
  })
  .strict();

const EffectiveScopeEntryResponse = z
  .object({
    scopeType: ScopeType,
    projectSlug: Slug.nullable(),
    environmentSlug: Slug.nullable(),
    /** `null` ONLY for a disabled identity, whose grants are all overruled. */
    role: Role.nullable(),
    /** Every live grant reaching this scope, strongest first. Never empty. */
    sources: z.array(PermissionSourceResponse),
  })
  .strict();

export const EffectivePermissionsResponse = z
  .object({
    identity: IdentityRecordResponse,
    /** Every group, including ones holding no grants -- also an answer. */
    groups: z.array(GroupRefResponse),
    bootstrap: z.boolean(),
    /**
     * One entry per scope some grant NAMES. An empty array means no access
     * anywhere, which is the correct answer for an identity nobody has granted
     * anything -- there is no implicit role in this system.
     */
    scopes: z.array(EffectiveScopeEntryResponse),
  })
  .strict();

/**
 * A subject that authenticated, was denied, and holds no grant.
 *
 * There is no `id` here on purpose: this list is read out of the AUDIT LOG,
 * which records subjects rather than identity rows. Match it to
 * `GET /identities` on `subject` to obtain the `identity_id` a grant needs.
 */
export const UnknownIdentityResponse = z
  .object({
    kind: IdentityKind,
    subject: z.string(),
    firstSeenAt: EpochMillis,
    lastSeenAt: EpochMillis,
    attempts: z.number().int().nonnegative(),
  })
  .strict();

export const AuditEntryResponse = z
  .object({
    id: Id,
    ts: EpochMillis,
    requestId: z.string().nullable(),
    actorKind: z.string(),
    actorSubject: z.string(),
    action: z.string(),
    outcome: z.string(),
    projectId: Id.nullable(),
    environmentId: Id.nullable(),
    targetKey: z.string().nullable(),
    /** Structured, and typed in `core` so that no member can hold a value. */
    detail: z.unknown(),
  })
  .strict();

export const AuditPageResponse = z
  .object({
    entries: z.array(AuditEntryResponse),
    /** Pass back as `cursor`. `null` at the end of the log. */
    cursor: z.string().nullable(),
  })
  .strict();

export const KeyringStatusResponse = z
  .object({
    activeKid: z.string(),
    entries: z.array(
      z
        .object({
          kid: z.string(),
          status: z.enum(["active", "retiring", "retired"]),
          rowsRemaining: z.number().int().nonnegative(),
          lastRekeyAt: EpochMillis.nullable(),
        })
        .strict(),
    ),
    /** The "safe to remove MASTER_KEY_OLD" indicator. True only at zero rows. */
    safeToRemoveOldKey: z.boolean(),
  })
  .strict();

export const RekeyResultResponse = z
  .object({ rekeyed: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() })
  .strict();

export const RollbackResultResponse = z
  .object({ rev: Revision, version: z.number().int().positive() })
  .strict();

export const RenameResultResponse = z.object({ rev: Revision }).strict();

/**
 * The liveness probe.
 *
 * `service` is a CONSTANT, and it is the field that lets `prk login` tell "this
 * is a prick server" from "a captive portal answered 200 with JSON". Nothing
 * else may be added here: this endpoint is unauthenticated, so every field is a
 * field an anonymous caller can read.
 */
export const HealthResponse = z
  .object({ service: z.literal("prick"), status: z.literal("ok"), version: z.string() })
  .strict();

export const WhoamiResponse = z
  .object({
    kind: IdentityKind,
    subject: z.string(),
    identityId: Id.nullable(),
    /** The caller's GLOBAL role, or `null`. Not the maximum over every scope. */
    role: Role.nullable(),
    /** True while this actor is an admin by `BOOTSTRAP_ADMINS` alone. */
    bootstrap: z.boolean(),
  })
  .strict();

export const ErrorResponse = z
  .object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    hint: z.string().optional(),
    /** `{path, message}` only. The rejected value is never echoed. */
    issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Drift assertions
// ---------------------------------------------------------------------------

/*
 * `pnpm typecheck` fails if any response schema stops describing what `core`
 * actually returns.
 *
 * Mutual assignability rather than one-way: a schema NARROWER than the return
 * type publishes a lie about what a client will receive, and a schema WIDER than
 * it publishes fields that do not exist. Both are drift, and only checking both
 * directions catches both.
 */
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type ResponseSchemasDescribeCore = [
  Assert<Same<ProjectSummary, z.infer<typeof ProjectSummaryResponse>>>,
  Assert<Same<EnvironmentSummary, z.infer<typeof EnvironmentSummaryResponse>>>,
  Assert<Same<SecretListEntry, z.infer<typeof SecretListEntryResponse>>>,
  Assert<Same<VersionEntry, z.infer<typeof VersionEntryResponse>>>,
  Assert<Same<WriteSecretsResult, z.infer<typeof WriteSecretsResultResponse>>>,
  Assert<Same<ImportResult, z.infer<typeof ImportResultResponse>>>,
  Assert<Same<IdentityRecord, z.infer<typeof IdentityRecordResponse>>>,
  Assert<Same<GrantRecord, z.infer<typeof GrantRecordResponse>>>,
  Assert<Same<GroupRecord, z.infer<typeof GroupRecordResponse>>>,
  Assert<Same<GroupMemberRecord, z.infer<typeof GroupMemberRecordResponse>>>,
  Assert<Same<GroupGrantRecord, z.infer<typeof GroupGrantRecordResponse>>>,
  Assert<Same<EffectivePermissions, z.infer<typeof EffectivePermissionsResponse>>>,
  Assert<Same<UnknownIdentity, z.infer<typeof UnknownIdentityResponse>>>,
  Assert<Same<AuditEntryView, z.infer<typeof AuditEntryResponse>>>,
  Assert<Same<AuditPage, z.infer<typeof AuditPageResponse>>>,
  Assert<Same<KeyringStatus, z.infer<typeof KeyringStatusResponse>>>,
];

/** The coerced query schema still produces exactly what `queryAudit` accepts. */
export type AuditQueryParamsMatchCore = Assert<
  z.infer<typeof AuditQueryParams> extends AuditQuery ? true : false
>;
