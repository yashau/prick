import { z } from "zod";

import { BODY_MAX_BYTES, ENV_MAX_SECRETS, REASON_MAX_LENGTH } from "./limits.js";
import {
  Description,
  DisplayName,
  EpochMillis,
  Id,
  Revision,
  Role,
  SecretKey,
  SecretsMap,
  Slug,
} from "./primitives.js";

/*
 * EVERY object schema in this file is `.strict()`.
 *
 * An unknown field must be a 422, not something silently dropped. The failure
 * mode this prevents is concrete: a client that sends `{"expectedRev": 3}`
 * instead of `{"expected_rev": 3}` would otherwise get a 200 and a write with
 * NO concurrency guard at all -- the exact request it believed it was making,
 * minus the safety.
 */

// ---------------------------------------------------------------------------
// Projects and environments
// ---------------------------------------------------------------------------

export const CreateProjectBody = z
  .object({
    slug: Slug,
    name: DisplayName,
    description: Description.optional(),
  })
  .strict();
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export const UpdateProjectBody = z
  .object({
    name: DisplayName.optional(),
    description: Description.optional(),
  })
  .strict();
export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

export const CreateEnvironmentBody = z
  .object({
    slug: Slug,
    name: DisplayName,
    description: Description.optional(),
  })
  .strict();
export type CreateEnvironmentBody = z.infer<typeof CreateEnvironmentBody>;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * One atomic mutation of an environment's secrets.
 *
 * `mode` decides what happens to keys that appear in neither `set` nor
 * `delete`:
 *
 *   merge   -> left alone.
 *   replace -> deleted. This is `prk secrets upload` / the UI's "replace all",
 *              and it is why `expected_rev` exists.
 *
 * The whole body is applied in ONE D1 `batch()`, audit row included. There is
 * no partial application: either every statement lands or none does.
 */
export const BatchBody = z
  .object({
    mode: z.enum(["merge", "replace"]).default("merge"),
    set: SecretsMap.optional(),
    /**
     * Free-text descriptions, keyed exactly as `set` is.
     *
     * `Description` is nullable, and `null` is the CLEAR -- not a sentinel
     * string, not an empty one. A key omitted from this map keeps whatever
     * description it already had, so a batch that never mentions descriptions
     * cannot silently wipe them.
     */
    descriptions: z.record(SecretKey, Description).optional(),
    delete: z.array(SecretKey).max(ENV_MAX_SECRETS).optional(),
    /** Optimistic guard. Omit to write unconditionally. */
    expected_rev: Revision.optional(),
    /** Recorded verbatim in the audit row. Never contains a secret value. */
    reason: z.string().max(REASON_MAX_LENGTH).optional(),
  })
  .strict()
  .refine(
    (body) => body.mode === "replace" || body.set !== undefined || body.delete !== undefined,
    { error: 'a merge batch must specify at least one of "set" or "delete"' },
  )
  /*
   * EVERY `descriptions` KEY MUST ALSO BE IN `set`.
   *
   * A description for a key this batch is not writing would be a METADATA-ONLY
   * UPDATE, and that immediately raises "does it bump a version?". It must not:
   * a description is not ciphertext, the AAD binds `(purpose, environment_id,
   * key, version)` and a description is in none of it, so nothing is
   * re-encrypted and no version moves. But a write path that answers with a new
   * `rev` and an unchanged key version is a shape nobody asked for, and the
   * documentation only ever promises a value and a description TOGETHER --
   * `prk secrets set KEY --description "..."`. Refusing the other case closes
   * the documented gap without inventing semantics for one that was never
   * specified. Widening it later is additive; narrowing it would not be.
   */
  .refine(
    (body) => {
      const set = body.set ?? {};
      return Object.keys(body.descriptions ?? {}).every((key) => Object.hasOwn(set, key));
    },
    {
      error:
        'every key in "descriptions" must also appear in "set": a description without a value would be a metadata-only update, which this route does not perform',
    },
  );
export type BatchBody = z.infer<typeof BatchBody>;

/**
 * Import a `.env` or JSON blob into an environment.
 *
 * `dry_run` is the default in the UI: the server parses, validates and
 * computes the diff without writing, so the operator sees "3 added, 1 changed,
 * 2 removed" before committing. The diff reports KEY names and change kinds
 * only -- it never carries values, in either direction.
 */
export const ImportBody = z
  .object({
    format: z.enum(["env", "json"]),
    /** Raw file contents. Bounded so a huge paste is a 413, not an OOM. */
    content: z.string().max(BODY_MAX_BYTES),
    mode: z.enum(["merge", "replace"]).default("merge"),
    dry_run: z.boolean().default(false),
    expected_rev: Revision.optional(),
    reason: z.string().max(REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type ImportBody = z.infer<typeof ImportBody>;

/**
 * Roll an environment (or a single key) back to an earlier version.
 *
 * A rollback does NOT resurrect the old ciphertext: the old blob is decrypted
 * and re-encrypted as `current + 1` under fresh AAD. The old envelope stays
 * exactly where it was in history.
 */
export const RollbackBody = z
  .object({
    key: SecretKey,
    to_version: z.number().int().positive(),
    reason: z.string().max(REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type RollbackBody = z.infer<typeof RollbackBody>;

/**
 * Reveal a single secret value.
 *
 * `reason` is what makes the audit log useful: the UI sends `"copy"` when the
 * copy button is pressed and `"reveal"` when the eye toggle is used, so a
 * reader can distinguish "looked at it" from "took it".
 */
export const RevealQuery = z
  .object({
    reason: z.enum(["reveal", "copy", "export", "run"]).default("reveal"),
  })
  .strict();
export type RevealQuery = z.infer<typeof RevealQuery>;

// ---------------------------------------------------------------------------
// Identities and grants
// ---------------------------------------------------------------------------

/**
 * What every grant carries, regardless of WHO holds it.
 *
 * Split out from `GrantFields` so that a grant on a group and a grant on an
 * identity cannot drift in role vocabulary or expiry semantics. They are the
 * same object with a different holder, and the day that stops being true is the
 * day "why does Bob have production?" stops having one answer.
 */
const GrantTerms = {
  role: Role,
  /** Absolute expiry in epoch ms. `null` means the grant does not expire. */
  expires_at: EpochMillis.nullable().default(null),
};

const GrantFields = {
  identity_id: Id,
  ...GrantTerms,
};

/**
 * Create a grant.
 *
 * Discriminated on `scope_type` so the scope fields are REQUIRED exactly where
 * they are meaningful and REJECTED where they are not. A flat optional-fields
 * object would accept `{scope_type: "global", project: "prod"}` and then have
 * to decide at runtime whether that meant global or project -- the exact
 * ambiguity that produces an over-broad grant nobody notices.
 */
export const CreateGrantBody = z.discriminatedUnion("scope_type", [
  z
    .object({
      scope_type: z.literal("global"),
      ...GrantFields,
    })
    .strict(),
  z
    .object({
      scope_type: z.literal("project"),
      project: Slug,
      ...GrantFields,
    })
    .strict(),
  z
    .object({
      scope_type: z.literal("environment"),
      project: Slug,
      environment: Slug,
      ...GrantFields,
    })
    .strict(),
]);
export type CreateGrantBody = z.infer<typeof CreateGrantBody>;

export const UpdateIdentityBody = z
  .object({
    display_name: DisplayName.nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type UpdateIdentityBody = z.infer<typeof UpdateIdentityBody>;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Create a group.
 *
 * A group is a NAMED SET OF IDENTITIES and nothing else -- there is no `role`
 * and no scope here, and their absence is the design. Creating a group grants
 * nobody anything; the grant is a separate call, at a separate scope, requiring
 * admin at that scope. Folding the two together would mean the act of writing
 * down "these five people work on payments" was also the act of giving them
 * access to something.
 */
export const CreateGroupBody = z
  .object({
    slug: Slug,
    name: DisplayName,
    description: Description.optional(),
  })
  .strict();
export type CreateGroupBody = z.infer<typeof CreateGroupBody>;

/**
 * Rename a group, or change its description.
 *
 * `slug` is absent on purpose. It is how humans and scripts address the group,
 * and a rename that silently repoints an identifier somebody else has written
 * down is a change nobody notices until it matters. Delete and recreate, which
 * is loud and drops the grants with it.
 */
export const UpdateGroupBody = z
  .object({
    name: DisplayName.optional(),
    description: Description.optional(),
  })
  .strict();
export type UpdateGroupBody = z.infer<typeof UpdateGroupBody>;

/** Add one identity to a group. The group is named by the path. */
export const AddGroupMemberBody = z.object({ identity_id: Id }).strict();
export type AddGroupMemberBody = z.infer<typeof AddGroupMemberBody>;

/**
 * Grant a role to a GROUP at a scope.
 *
 * Discriminated on `scope_type` for the same reason `CreateGrantBody` is: the
 * scope fields are required exactly where they are meaningful and rejected where
 * they are not, so `{scope_type: "global", project: "prod"}` cannot arrive and
 * have to be guessed at.
 *
 * There is no `identity_id`, and there is no deny variant. Group grants are
 * PURELY ADDITIVE: effective role is the max over the identity's own grants and
 * its groups', so a group can only ever raise a role, never lower one. A deny
 * rule that silently overrode an explicit grant would make the access graph
 * unreadable in exactly the situation -- an incident, at 3am -- where somebody
 * has to be able to read it. Removal is what revocation is for.
 */
export const CreateGroupGrantBody = z.discriminatedUnion("scope_type", [
  z
    .object({
      scope_type: z.literal("global"),
      ...GrantTerms,
    })
    .strict(),
  z
    .object({
      scope_type: z.literal("project"),
      project: Slug,
      ...GrantTerms,
    })
    .strict(),
  z
    .object({
      scope_type: z.literal("environment"),
      project: Slug,
      environment: Slug,
      ...GrantTerms,
    })
    .strict(),
]);
export type CreateGroupGrantBody = z.infer<typeof CreateGroupGrantBody>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AuditQuery = z
  .object({
    project: Slug.optional(),
    environment: Slug.optional(),
    actor: z.string().max(320).optional(),
    action: z.string().max(64).optional(),
    outcome: z.enum(["success", "denied", "error"]).optional(),
    since: EpochMillis.optional(),
    until: EpochMillis.optional(),
    /** Opaque UUIDv7 cursor. Time-sortable ids are what make this work. */
    cursor: Id.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AuditQuery = z.infer<typeof AuditQuery>;

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * The single error shape every non-2xx API response uses.
 *
 * `issues` carries `{path, message}` ONLY. The zod error formatter must drop
 * `issue.input`: a VALIDATION_FAILED on a secret write would otherwise echo
 * the rejected secret value into the response body, the Worker log and the
 * audit detail at once.
 */
export const ApiErrorBody = z
  .object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    hint: z.string().optional(),
    issues: z
      .array(
        z
          .object({
            path: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
