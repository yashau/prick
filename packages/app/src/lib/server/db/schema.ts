import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * D1 / SQLite schema.
 *
 * Conventions that hold everywhere in this file:
 *
 * IDs are UUIDv7 TEXT. Not `crypto.randomUUID()`, which is v4: v7 embeds a
 * millisecond timestamp in its high bits and therefore sorts lexicographically
 * in creation order. That is what makes `WHERE id > :cursor ORDER BY id` a
 * correct, index-only keyset paginator for the audit log. With v4 ids the same
 * query returns rows in an arbitrary order and the cursor is meaningless.
 *
 * TIMESTAMPS are INTEGER Unix epoch MILLISECONDS. Never ISO-8601 text. Text
 * timestamps compare correctly only by accident of format, cost ~24 bytes each,
 * and force a parse on every read. Milliseconds are what `Date.now()` returns
 * and what the JWT claims are compared against.
 *
 * FOREIGN KEYS are real. D1 enforces them by default, so `ON DELETE CASCADE`
 * actually fires and there is no hand-rolled cascade to get wrong.
 */

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    /** URL-safe identifier. The CLI and the alias routes address projects by this. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Actor subject (email or service-token common_name) that created the row. */
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("projects_slug_uniq").on(t.slug)],
);

// ---------------------------------------------------------------------------
// environments
// ---------------------------------------------------------------------------

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),

    /**
     * IMMUTABLE, and deliberately so.
     *
     * `project_id` is excluded from the crypto AAD precisely so that a future
     * reparent would not require re-encrypting every value. The price is that
     * `environments.id` and `.project_id` are contractually immutable and there
     * is no reparent operation. Do not add one without re-reading the AAD
     * design first.
     */
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    /**
     * Optimistic-concurrency counter, bumped on every mutation of this
     * environment's secrets.
     *
     * The guard is NOT `UPDATE ... WHERE rev = ?`: D1 rolls a batch back on an
     * ERROR, not on zero rows changed, so a non-matching UPDATE silently
     * succeeds as a no-op and the rest of the batch commits anyway. The
     * construct that works is a deliberate primary-key collision --
     *
     *   INSERT INTO environments SELECT * FROM environments
     *     WHERE id = ?1 AND rev != ?2
     *
     * -- which selects zero rows (harmless no-op) when the revision matches and
     * one row (PK violation, whole batch aborts) when it does not. Mapped to
     * HTTP 412.
     */
    rev: integer("rev").notNull().default(0),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("environments_project_slug_uniq").on(t.projectId, t.slug),
    index("environments_project_idx").on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// secrets -- current state, one row per live key
// ---------------------------------------------------------------------------

export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),

    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),

    /**
     * Stored in PLAINTEXT, on purpose. Key names are metadata: the UI lists
     * them, the diff view compares them, the audit log names them, and an
     * operator has to be able to see that `DATABASE_URL` exists without
     * decrypting anything. Only the VALUE is encrypted.
     */
    key: text("key").notNull(),

    /** Points into secret_versions. The live ciphertext is fetched from there. */
    currentVersion: integer("current_version").notNull(),

    description: text("description"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [uniqueIndex("secrets_env_key_uniq").on(t.environmentId, t.key)],
);

// ---------------------------------------------------------------------------
// secret_versions -- immutable history
// ---------------------------------------------------------------------------

/**
 * Append-only version history.
 *
 * NINE COLUMNS, and the count is load-bearing. D1 allows 100 bound parameters
 * per query, so a multi-row INSERT here fits 11 rows (9 x 11 = 99). A
 * 100-secret full replace becomes ~23 statements in ONE batch() -- still a
 * single transaction -- instead of 101 sequential round-trips. Adding a tenth
 * column drops the chunk size to 10 and must be a deliberate decision.
 *
 * There is NO foreign key on `key`, and that is intentional: history is keyed
 * by `(environment_id, key)` rather than by `secrets.id`, so deleting a key and
 * recreating it CONTINUES the version sequence instead of restarting at 1. A
 * version number therefore never refers to two different values in one
 * environment -- which matters, because the version is inside the AEAD
 * additional data.
 */
export const secretVersions = sqliteTable(
  "secret_versions",
  {
    id: text("id").primaryKey(),

    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),

    key: text("key").notNull(),

    version: integer("version").notNull(),

    /**
     * base64url( version || alg || kid[8] || iv[12] || ciphertext||tag ).
     *
     * NULL for a tombstone (`op = 'delete'`): the row records that the key
     * ceased to exist at this version, without carrying a value.
     */
    ciphertext: text("ciphertext"),

    /**
     * Hex key id of the master key this row was encrypted under.
     *
     * Lives in the ENVELOPE, not in the AAD -- which is what makes rekeying
     * possible: re-encrypting under a new key must not change the AAD, because
     * the AAD binds the row's identity and the row's identity has not changed.
     * NULL only for tombstones.
     */
    kid: text("kid"),

    /** 'set' | 'delete' | 'rollback' | 'rename' | 'import' | 'rekey' */
    op: text("op").notNull(),

    createdAt: integer("created_at").notNull(),

    createdBy: text("created_by").notNull(),
  },
  (t) => [
    /**
     * THE CONCURRENCY PRIMITIVE. There is no lock table anywhere in this
     * schema because of this one index.
     *
     * Two writers racing on the same key both read version N and both compute
     * N+1. Both batches attempt the same INSERT. One commits; the other hits
     * this constraint, which aborts its ENTIRE batch (D1 rolls back on error),
     * so the loser writes nothing at all -- not a partial update, not an
     * out-of-order version. The loser retries once against the new state and,
     * if it loses again, returns 409.
     */
    uniqueIndex("secret_versions_env_key_version_uniq").on(t.environmentId, t.key, t.version),

    /** History view: newest first for one key. */
    index("secret_versions_env_key_idx").on(t.environmentId, t.key),
  ],
);

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

/**
 * Everything that can authenticate. There are no prick-issued credentials of
 * any kind: identity comes from a verified Cloudflare Access JWT and this table
 * only records what we know about the subject in it.
 */
export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),

    /** 'user' | 'service' */
    kind: text("kind").notNull(),

    /**
     * Lower-cased `email` for a user; `common_name` for a service token.
     *
     * A service-token subject looks like
     * `e367826f93b8d71185e03fe518aff3b4.access` -- opaque, and nobody can map
     * it to "staging deploy" from memory. That is why `display_name` exists and
     * why denials are recorded even for subjects with no identity row: the
     * "Seen but not granted" screen reads them back so the normal flow becomes
     * "point CI at prick, watch it 403, click Grant".
     */
    subject: text("subject").notNull(),

    displayName: text("display_name"),

    /**
     * When Cloudflare Access was last ASKED for this identity's name -- whether
     * or not it had one to give.
     *
     * The name is resolved lazily from `/cdn-cgi/access/get-identity`, which
     * means the retry condition needs a way to tell "never looked" from "looked
     * and Access returned nothing". `display_name` alone cannot: both are NULL.
     * Without this column an identity whose provider carries no name -- a
     * one-time-PIN login, a service token -- would send a subrequest to Access
     * on EVERY authenticated request, forever, to learn the same nothing.
     *
     * NULL means never asked. Set on every attempt, including the ones that
     * fail, so a provider that is down costs one retry per interval rather than
     * one per request.
     */
    displayNameSyncedAt: integer("display_name_synced_at"),

    /**
     * A kill switch that outranks every grant. Checked before grant resolution,
     * so disabling an identity is one write rather than a hunt for its rows.
     */
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
  },
  (t) => [uniqueIndex("identities_kind_subject_uniq").on(t.kind, t.subject)],
);

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

/**
 * Authorization. `reader < writer < admin` at one of three scopes.
 *
 * There is NO god mode. A global admin is a row in this table with
 * `scope_type = 'global'` -- the same code path, the same audit trail, the same
 * revocation. An `if (actor.kind === 'user') return true` shortcut anywhere in
 * this codebase is a bug, not an optimisation.
 *
 * Effective role = max over matching, non-expired grants, resolved ONCE per
 * request. A 200-secret operation performs one authorization query.
 */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),

    identityId: text("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),

    /** 'reader' | 'writer' | 'admin' */
    role: text("role").notNull(),

    /** 'global' | 'project' | 'environment' */
    scopeType: text("scope_type").notNull(),

    /** NULL for a global grant. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),

    /** NULL for a global or project grant. */
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),

    /** Epoch ms, or NULL for a grant that does not expire. */
    expiresAt: integer("expires_at"),

    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    /*
     * PARTIAL unique indexes, one per scope type -- NOT one composite index
     * over (identity_id, scope_type, project_id, environment_id).
     *
     * SQLite follows the SQL standard in treating NULLs as DISTINCT for
     * uniqueness purposes. In a composite index a global grant is
     * (id, 'global', NULL, NULL), and two such rows do NOT collide, because
     * NULL != NULL. The constraint would look correct in the schema, pass every
     * casual test, and silently permit unlimited duplicate global admin grants
     * -- so revoking "the" global admin grant would leave the others in place.
     *
     * A partial index sidesteps NULL comparison entirely by indexing only the
     * columns that are non-NULL for that scope.
     */
    uniqueIndex("grants_global_uniq")
      .on(t.identityId)
      .where(sql`scope_type = 'global'`),

    uniqueIndex("grants_project_uniq")
      .on(t.identityId, t.projectId)
      .where(sql`scope_type = 'project'`),

    uniqueIndex("grants_environment_uniq")
      .on(t.identityId, t.environmentId)
      .where(sql`scope_type = 'environment'`),

    /** The per-request resolution query: all grants for one identity. */
    index("grants_identity_idx").on(t.identityId),

    /**
     * Answers "does any global admin grant still exist?" without a table scan.
     * That question gates both the NO_ADMINS_CONFIGURED 503 and the LAST_ADMIN
     * 409, so it runs often.
     */
    index("grants_scope_role_idx").on(t.scopeType, t.role),
  ],
);

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

/**
 * A named set of identities. FLAT -- a group holds identities, never other
 * groups.
 *
 * Nesting is excluded deliberately rather than left for later. It buys one
 * thing (an org chart expressed in the access model) and costs cycle detection
 * on every write, a recursive CTE on the hot authorization path, and an
 * "effective members" answer that no operator can compute in their head. The
 * question this whole area exists to answer is "why does this identity have
 * production?", and a two-line answer -- "the platform group has it; they are in
 * the platform group" -- is the feature. A seven-level derivation is the thing
 * that made the question worth asking.
 *
 * A group with no grants is a LIST, not a permission. Membership confers exactly
 * nothing on its own; see `group_grants`.
 */
export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    /** URL-safe identifier, unique across the installation. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("groups_slug_uniq").on(t.slug)],
);

// ---------------------------------------------------------------------------
// group_members
// ---------------------------------------------------------------------------

/**
 * Membership. Deliberately just the pair, plus who added it and when.
 *
 * `ON DELETE CASCADE` in BOTH directions: deleting a group removes its
 * memberships, and deleting an identity removes it from every group. Neither
 * cascade is optional -- a membership row pointing at a deleted identity would
 * be a grant attached to nobody, which is the kind of row that survives an
 * access review because it renders as blank.
 *
 * No surrogate id. The pair IS the identity of this row, `added_at`/`added_by`
 * are facts about it, and the API addresses a membership as
 * `(group, identity)` -- which is also what a removal names, so there is no id
 * for a caller to have to look up first.
 */
export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),

    identityId: text("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),

    addedAt: integer("added_at").notNull(),
    /** Actor subject that added the member. Denormalised, like `created_by`. */
    addedBy: text("added_by").notNull(),
  },
  (t) => [
    /**
     * One row per (group, identity). A plain UNIQUE is correct here and a
     * PARTIAL index is not needed, for the reason the `grants` indexes below
     * are partial: NEITHER COLUMN IS NULLABLE, so SQLite's "NULLs are distinct"
     * rule has nothing to bite on.
     */
    uniqueIndex("group_members_group_identity_uniq").on(t.groupId, t.identityId),

    /**
     * The hot direction. Authorization resolves "which groups is THIS identity
     * in" on every request; the unique index above is ordered (group, identity)
     * and cannot serve that lookup.
     */
    index("group_members_identity_idx").on(t.identityId),
  ],
);

// ---------------------------------------------------------------------------
// group_grants
// ---------------------------------------------------------------------------

/**
 * A grant held by a GROUP. Same three scopes, same roles, same expiry as
 * `grants`.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND TABLE RATHER THAN A NULLABLE `group_id` ON `grants`
 * ---------------------------------------------------------------------------
 * The alternative considered was one table: add `group_id` to `grants`, make
 * `identity_id` nullable, and add `CHECK (exactly one of them is set)`. It reads
 * well and it is the wrong trade here, for three reasons in increasing order of
 * seriousness.
 *
 *   1. IT IS NOT AN ADDITIVE MIGRATION. SQLite cannot drop a NOT NULL or add a
 *      CHECK in place; both require the 12-step table rebuild, and drizzle-kit
 *      emits that rebuild wrapped in `PRAGMA foreign_keys=OFF`, which D1 rejects
 *      mid-transaction. The rebuild would be of `grants` -- the table every
 *      authenticated request reads -- during the window between
 *      `migrations apply` and `deploy`, when the OLD code is still live. This
 *      repository's migration rule ("additive only, destructive changes take
 *      three releases") exists to keep exactly that off the table.
 *
 *   2. THE CONSTRAINT GETS WEAKER, NOT STRONGER. In one table, "a grant names an
 *      identity or a group, never both and never neither" is a CHECK plus two
 *      nullable foreign keys. Split, it is two NOT NULL foreign keys the
 *      database enforces without being asked, and "exactly one" is expressed by
 *      which table the row is in -- a property that cannot be violated because
 *      there is nowhere to write the violating row.
 *
 *   3. THE PARTIAL UNIQUE INDEXES WOULD HAVE TO GROW A NULL CASE. `grants_global_uniq`
 *      is `UNIQUE(identity_id) WHERE scope_type = 'global'`. Group rows would
 *      carry `identity_id = NULL`, and SQLite treats NULLs as DISTINCT, so that
 *      index would silently permit unlimited duplicate global GROUP grants --
 *      the precise failure the indexes were made partial to avoid, reintroduced
 *      through the back door. It is fixable (`AND identity_id IS NOT NULL`, plus
 *      three more indexes on `group_id`), but it means the one subtlety in this
 *      schema now has two places to get right instead of one.
 *
 * Split, `grants` is untouched by this feature -- its three partial unique
 * indexes keep working because nothing about their rows changed -- and this
 * table gets the SAME three, keyed on `group_id`, for the same reason.
 *
 * The cost is honest and it is paid on the read side: effective role is now the
 * max over two sources. That is ONE query, not two -- see `loadSnapshot`, which
 * unions the two branches into a single statement -- so the "one authorization
 * query per request" property is preserved rather than traded away.
 */
export const groupGrants = sqliteTable(
  "group_grants",
  {
    id: text("id").primaryKey(),

    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),

    /** 'reader' | 'writer' | 'admin' */
    role: text("role").notNull(),

    /** 'global' | 'project' | 'environment' */
    scopeType: text("scope_type").notNull(),

    /** NULL for a global grant. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),

    /** NULL for a global or project grant. */
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),

    /** Epoch ms, or NULL for a grant that does not expire. */
    expiresAt: integer("expires_at"),

    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    /*
     * PARTIAL, one per scope type, for exactly the reason spelled out on
     * `grants` above: a composite index over (group_id, scope_type, project_id,
     * environment_id) would make two global grants for one group
     * (id, 'global', NULL, NULL) non-colliding, because NULL != NULL. Revoking
     * "the" global grant would then leave its duplicates in place.
     */
    uniqueIndex("group_grants_global_uniq")
      .on(t.groupId)
      .where(sql`scope_type = 'global'`),

    uniqueIndex("group_grants_project_uniq")
      .on(t.groupId, t.projectId)
      .where(sql`scope_type = 'project'`),

    uniqueIndex("group_grants_environment_uniq")
      .on(t.groupId, t.environmentId)
      .where(sql`scope_type = 'environment'`),

    /** The per-request resolution query: all grants for a set of groups. */
    index("group_grants_group_idx").on(t.groupId),

    /**
     * "Does any global admin grant still exist?" has to consider group-derived
     * admins too, or an installation whose only administrator is a group member
     * answers 503 NO_ADMINS_CONFIGURED to every request.
     */
    index("group_grants_scope_role_idx").on(t.scopeType, t.role),
  ],
);

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------

/**
 * Append-only. Never updated, never deleted by application code.
 *
 * The audit INSERT is the LAST statement inside the same D1 batch() as the data
 * it describes. If the audit write fails, the data write fails with it, so an
 * un-audited mutation is not merely discouraged -- it is unrepresentable. That
 * is worth the latency.
 *
 * Deliberately NO foreign key to `identities`: an audit row must outlive the
 * identity it names, and a cascade here would delete exactly the history you
 * need after revoking someone's access. `actor_subject` is denormalised text
 * for the same reason.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    /** UUIDv7 -- also the keyset pagination cursor, which is why v7 matters. */
    id: text("id").primaryKey(),

    ts: integer("ts").notNull(),

    /**
     * The `X-Request-Id` echoed back to the caller.
     *
     * This is the whole point of echoing it: a user pastes the id from an error
     * toast and an admin finds the exact event, rather than correlating by
     * timestamp and hoping.
     */
    requestId: text("request_id"),

    /** 'user' | 'service' */
    actorKind: text("actor_kind").notNull(),

    /** Denormalised: email or common_name, as seen at the time. */
    actorSubject: text("actor_subject").notNull(),

    /** Soft reference only. No FK -- see the note above. */
    identityId: text("identity_id"),

    /** e.g. 'secret.reveal', 'secret.import', 'grant.create', 'admin.rekey'. */
    action: text("action").notNull(),

    /**
     * 'success' | 'denied' | 'error'
     *
     * DENIALS ARE RECORDED. They are what populates "Seen but not granted", and
     * a decrypt failure is recorded as 'error' rather than swallowed -- a
     * tamper attempt must be the loudest thing in the system.
     */
    outcome: text("outcome").notNull(),

    projectId: text("project_id"),
    environmentId: text("environment_id"),

    /** The secret key name, when the action concerns one. Never the value. */
    targetKey: text("target_key"),

    /**
     * JSON. MUST NOT contain a secret value, a ciphertext, or zod's
     * `issue.input`. The error formatter strips `input` before anything reaches
     * here, the response, or a log line.
     */
    detail: text("detail"),
  },
  (t) => [
    index("audit_log_ts_idx").on(t.ts),
    index("audit_log_env_ts_idx").on(t.environmentId, t.ts),
    index("audit_log_actor_ts_idx").on(t.actorSubject, t.ts),
    index("audit_log_request_idx").on(t.requestId),
  ],
);

// ---------------------------------------------------------------------------
// keyring_state
// ---------------------------------------------------------------------------

/**
 * One row per master-key id ever observed, and the reason the settings screen
 * can tell you the truth.
 *
 * Removing `MASTER_KEY_OLD` while rows are still encrypted under the retired
 * kid is the single irreversible mistake available in this design -- those
 * values become permanently undecryptable. So the UI must be what tells you it
 * is safe, and it can only do that if `rows_remaining` is maintained.
 *
 * `rows_remaining` is recomputed by the rekey job, not trusted as a running
 * counter: a "safe to remove" indicator derived from an incrementally
 * maintained number that drifted is worse than no indicator.
 */
export const keyringState = sqliteTable("keyring_state", {
  /** Hex of the first 8 bytes of HKDF(mk, salt, "prick/v1/kid"). */
  kid: text("kid").primaryKey(),

  /** 'active' | 'retiring' | 'retired' */
  status: text("status").notNull(),

  firstSeenAt: integer("first_seen_at").notNull(),
  lastRekeyAt: integer("last_rekey_at"),

  /** Rows still encrypted under this kid. Zero is the green light. */
  rowsRemaining: integer("rows_remaining").notNull().default(0),

  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;

export type SecretVersion = typeof secretVersions.$inferSelect;
export type NewSecretVersion = typeof secretVersions.$inferInsert;

export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;

export type Grant = typeof grants.$inferSelect;
export type NewGrant = typeof grants.$inferInsert;

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;

export type GroupGrant = typeof groupGrants.$inferSelect;
export type NewGroupGrant = typeof groupGrants.$inferInsert;

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;

export type KeyringEntry = typeof keyringState.$inferSelect;
export type NewKeyringEntry = typeof keyringState.$inferInsert;
