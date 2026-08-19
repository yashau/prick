//! Typed request and response bodies.
//!
//! Three rules apply to everything here.
//!
//! 1. A **secret value never appears in a `Debug` output**. Value-carrying
//!    types wrap the value in [`secrecy::SecretString`], which makes a leak
//!    through a format string a compile error rather than a review finding.
//! 2. Every response type is `#[non_exhaustive]`, so the server adding a field
//!    is not a breaking change for an older client.
//! 3. **The wire spelling is the server's, not this crate's.** Responses are
//!    `camelCase` because that is what the zod response schemas emit; request
//!    bodies are `snake_case` because that is what the zod request schemas
//!    accept, and they are `.strict()`, so a client that sends `expectedRev`
//!    instead of `expected_rev` gets a 422 rather than a write with no
//!    concurrency guard.
//!
//! Schemas here are the Rust mirror of `packages/shared/src` and of the
//! response schemas in `packages/app/src/lib/server/http/schemas.ts`;
//! `docs/openapi.json`, which CI keeps fresh from the router, is the artefact
//! that names both.

use std::collections::BTreeMap;

use secrecy::SecretString;
use serde::{Deserialize, Serialize};

/// The `/api/v1/health` response.
///
/// The first thing `prk login` and `prk doctor` fetch. It is deliberately tiny:
/// its job is to answer "is this a prick server" before any credential is sent,
/// so that pointing the CLI at a random URL produces a clear message rather
/// than a failed authentication.
///
/// It lives **under the API prefix**, not at the origin. `hooks.server.ts`
/// routes `/api/*` to the Hono application and everything else to SvelteKit, so
/// a probe of `/health` reaches the admin UI's 404 page instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Health {
    /// Always `"prick"`. A response missing this is not a prick server.
    pub service: String,
    /// Always `"ok"`, and it means something: the fail-closed key ring
    /// middleware runs ahead of the route, so an installation whose master key
    /// will not load answers 500 here rather than 200.
    ///
    /// Optional on this side only so that a response predating the field still
    /// deserialises; the server always sends it.
    #[serde(default)]
    pub status: Option<String>,
    /// The server's version string.
    pub version: String,
}

impl Health {
    /// The value [`Health::service`] must carry.
    pub const SERVICE: &'static str = "prick";

    /// Whether this response actually came from a prick server.
    ///
    /// A 200 with a JSON body is not sufficient evidence; a captive portal or
    /// a misconfigured proxy produces one too.
    pub fn is_prick(&self) -> bool {
        self.service == Self::SERVICE
    }
}

/// The identity the server resolved for the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Whoami {
    /// `"user"` or `"service"`.
    pub kind: String,
    /// An email address for a user, a `common_name` for a service token.
    pub subject: String,
    /// The identity row's id, once one exists for this subject.
    #[serde(default)]
    pub identity_id: Option<String>,
    /// The caller's **global** role, or `None`. Not the maximum over every
    /// scope: a project-scoped admin reports `None` here and is still an
    /// administrator of that project.
    #[serde(default)]
    pub role: Option<String>,
    /// True while this caller is an administrator by `BOOTSTRAP_ADMINS` alone,
    /// before the self-heal has turned that into a real, revocable grant.
    #[serde(default)]
    pub bootstrap: bool,
}

/// A project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Project {
    /// UUIDv7, so ids sort by creation time and paginate by cursor.
    pub id: String,
    /// The URL-safe short name every route addresses this project by.
    pub slug: String,
    /// The display name.
    pub name: String,
    /// Free text, or `None`.
    #[serde(default)]
    pub description: Option<String>,
    /// How many environments this project holds.
    #[serde(default)]
    pub environment_count: u64,
    /// Last modification, in epoch milliseconds.
    #[serde(default)]
    pub updated_at: i64,
}

/// An environment within a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Environment {
    /// UUIDv7.
    pub id: String,
    /// The owning project's id. Immutable: an environment is never reparented,
    /// because `project_id` is excluded from the crypto AAD and a reparent
    /// would leave every row decrypting under the wrong project.
    pub project_id: String,
    /// The URL-safe short name every route addresses this environment by.
    pub slug: String,
    /// The display name.
    pub name: String,
    /// Free text, or `None`.
    #[serde(default)]
    pub description: Option<String>,
    /// The revision counter, used for optimistic concurrency. The same number
    /// the secret collection returns as its `ETag`.
    pub rev: u64,
    /// How many secrets this environment holds.
    #[serde(default)]
    pub secret_count: u64,
    /// Last modification, in epoch milliseconds.
    #[serde(default)]
    pub updated_at: i64,
}

/// A secret's metadata. Never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SecretMeta {
    /// The key name, stored in plaintext by design.
    pub key: String,
    /// Free text, or `None`.
    ///
    /// Read-only from this client's point of view: no route accepts one, and
    /// inventing a field for it would be a 422 rather than a description.
    #[serde(default)]
    pub description: Option<String>,
    /// The current version number, starting at 1.
    pub version: u32,
    /// Last write, in epoch milliseconds.
    #[serde(default)]
    pub updated_at: i64,
    /// The subject that performed the last write.
    #[serde(default)]
    pub updated_by: String,
    /// The master key id the current version is sealed under. Not secret.
    #[serde(default)]
    pub kid: Option<String>,
    /// Whether the stored value failed to decrypt.
    ///
    /// Surfaced loudly rather than skipped. A tamper attempt must be the most
    /// visible thing in the system: a silently shorter listing is how a deploy
    /// goes out missing `DATABASE_URL`.
    pub unreadable: bool,
}

/// One entry of a key's version history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SecretVersion {
    /// The version number.
    pub version: u32,
    /// What produced it -- `set`, `delete`, `rollback`, `rename`.
    pub op: String,
    /// When, in epoch milliseconds.
    #[serde(default)]
    pub created_at: i64,
    /// The subject that produced it.
    #[serde(default)]
    pub created_by: String,
    /// The master key id this version is sealed under.
    #[serde(default)]
    pub kid: Option<String>,
    /// A tombstone: this version records the key ceasing to exist, and occupies
    /// the number, which is what makes delete-then-recreate continue the
    /// sequence rather than collide with its own history.
    pub deleted: bool,
}

/// A single revealed secret.
///
/// No `Serialize`, deliberately. The client reads these; nothing in the CLI has
/// a reason to write one back out as a whole document, and the derive would be
/// the one route by which a value could reach a stream through the type system
/// rather than around it.
///
/// There is **no version field**, and its absence is the server's:
/// `revealSecret` returns the plaintext and nothing else.
#[derive(Debug, Clone, Deserialize)]
#[non_exhaustive]
pub struct SecretValue {
    /// The key name.
    pub key: String,
    /// The plaintext.
    pub value: SecretString,
}

/// Every value in an environment, as `:export` returns them.
///
/// A **flat map** of key to plaintext -- not a document with a revision and a
/// list. Backed by a `BTreeMap`, so iteration order is the key order and
/// `prk secrets download | diff` is meaningful for identical input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
#[non_exhaustive]
pub struct SecretExport {
    values: BTreeMap<String, SecretString>,
}

impl SecretExport {
    /// Builds an export from a map. For tests and for callers that already hold
    /// the values.
    pub fn new(values: BTreeMap<String, SecretString>) -> Self {
        Self { values }
    }

    /// How many secrets the export carries.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Whether the environment holds no secrets at all.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The key names, in order. Names are plaintext metadata by design.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.values.keys().map(String::as_str)
    }

    /// Every key and value, in key order.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &SecretString)> {
        self.values.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// Consumes the export into owned pairs, in key order.
    ///
    /// What `prk run` hands to the launcher: the values move into the child's
    /// environment block and are never copied anywhere else.
    pub fn into_pairs(self) -> Vec<(String, SecretString)> {
        self.values.into_iter().collect()
    }
}

/// The result of an atomic write through `:batch`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct WriteResult {
    /// The environment's revision **after** the write. Send it back as
    /// `expected_rev`, or as `If-Match`.
    pub rev: u64,
    /// Keys that did not exist before.
    #[serde(default)]
    pub added: Vec<String>,
    /// Keys that existed and were rewritten.
    #[serde(default)]
    pub changed: Vec<String>,
    /// Keys that were deleted.
    #[serde(default)]
    pub removed: Vec<String>,
}

/// The result of an `:import`.
///
/// Carries key names and change kinds only. `changed` means "this key already
/// existed and is being rewritten"; it does **not** mean the value differs, and
/// it cannot -- telling those apart would mean decrypting every existing value
/// to compare.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ImportResult {
    /// Keys that did not exist before.
    #[serde(default)]
    pub added: Vec<String>,
    /// Keys that existed and are being rewritten.
    #[serde(default)]
    pub changed: Vec<String>,
    /// Keys that would be, or were, deleted.
    #[serde(default)]
    pub removed: Vec<String>,
    /// `false` for a dry run: the diff was computed and nothing was written.
    pub applied: bool,
    /// Lines the parser accepted with a complaint. Never carries a value.
    #[serde(default)]
    pub warnings: Vec<ImportWarning>,
}

/// One complaint from the import parser.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ImportWarning {
    /// The line number in the submitted blob.
    pub line: i64,
    /// The key the line named, when it named one.
    #[serde(default)]
    pub key: String,
    /// What was wrong with it.
    pub message: String,
}

/// The result of a `:rollback`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct RollbackResult {
    /// The environment's revision after the rollback.
    pub rev: u64,
    /// The **new** version the restored plaintext was written as. A rollback
    /// moves forward: the old envelope is never resurrected, because its AAD
    /// binds it to the version it was sealed at.
    pub version: u32,
}

/// The result of a `:rename`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct RenameResult {
    /// The environment's revision after the rename.
    pub rev: u64,
}

/// An identity the server has seen.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Identity {
    /// UUIDv7. What [`Grant`] is created against.
    pub id: String,
    /// `"user"` or `"service"`.
    pub kind: String,
    /// An email address for a user, a `common_name` for a service token.
    pub subject: String,
    /// An administrator-supplied label, or `None`.
    #[serde(default)]
    pub display_name: Option<String>,
    /// The kill switch. A disabled identity holds nothing, whatever its grants
    /// say.
    #[serde(default)]
    pub disabled: bool,
    /// When this subject last authenticated, in epoch milliseconds.
    #[serde(default)]
    pub last_seen_at: Option<i64>,
}

/// A subject that authenticated, was denied, and holds no grant.
///
/// There is no id here: the list is read out of the **audit log**, which records
/// subjects rather than identity rows. Match `subject` against
/// [`Identity::subject`] to obtain the id a grant needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UnknownIdentity {
    /// `"user"` or `"service"`.
    pub kind: String,
    /// The subject Access presented.
    pub subject: String,
    /// First denial, in epoch milliseconds.
    #[serde(default)]
    pub first_seen_at: i64,
    /// Most recent denial, in epoch milliseconds.
    #[serde(default)]
    pub last_seen_at: i64,
    /// How many times it has been refused.
    #[serde(default)]
    pub attempts: u64,
}

/// A role held by one identity at one scope.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Grant {
    /// UUIDv7. Revocation addresses the grant by this and nothing else.
    pub id: String,
    /// The identity this grant belongs to.
    pub identity_id: String,
    /// That identity's subject, denormalised so a listing is readable.
    #[serde(default)]
    pub subject: String,
    /// `reader`, `writer` or `admin`.
    pub role: String,
    /// `global`, `project` or `environment`.
    pub scope_type: String,
    /// The project slug, for a project- or environment-scoped grant.
    #[serde(default)]
    pub project_slug: Option<String>,
    /// The environment slug, for an environment-scoped grant.
    #[serde(default)]
    pub environment_slug: Option<String>,
    /// Absolute expiry in epoch milliseconds, or `None` for a grant that does
    /// not expire.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

impl Grant {
    /// The scope rendered the way the CLI spells one: `project:environment`,
    /// with `*` for whichever half the grant does not name.
    pub fn scope(&self) -> String {
        let project = self.project_slug.as_deref().unwrap_or("*");
        let environment = self.environment_slug.as_deref().unwrap_or("*");
        format!("{project}:{environment}")
    }
}

/// The state of the master key ring.
///
/// The counts are taken live over `secret_versions` every time this is asked,
/// and they cover **history** as well as current versions -- an earlier version
/// stranded under a retired key id is a rollback that stops working the moment
/// the key goes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct KeyringStatus {
    /// The key id everything is written under today.
    pub active_kid: String,
    /// One entry per key id ever observed, active and retired alike.
    #[serde(default)]
    pub entries: Vec<KeyringEntry>,
    /// Whether this deployment carries a key besides the active one -- that
    /// is, whether `MASTER_KEY_OLD` is set at all.
    ///
    /// `serde(default)` because it is additive: a server predating the field
    /// omits it and this reads `false`, which suppresses the "you may remove
    /// it" branch rather than inventing one. The degradation runs toward
    /// saying less, which is the only safe direction for a field whose other
    /// value authorises an unrecoverable delete.
    #[serde(default)]
    pub old_key_loaded: bool,
    /// Whether `MASTER_KEY_OLD` can be removed.
    ///
    /// True only when every non-active key id reports zero rows. Removing a
    /// retired key while a row still references it is the one irreversible
    /// mistake available in this design, so this is the field to wait on rather
    /// than a judgement about how long a rekey has been running.
    ///
    /// NOT actionable alone. It is a statement about rows, so it is vacuously
    /// true when no old key exists to strand any -- a fresh install reports
    /// `true` here having never rotated anything. Pair it with
    /// `old_key_loaded` before turning it into an instruction.
    pub safe_to_remove_old_key: bool,
}

/// One key id in the ring, and how much still depends on it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct KeyringEntry {
    /// The key id carried in every envelope this key sealed.
    pub kid: String,
    /// `active`, `retiring` or `retired`.
    ///
    /// `retired` means the ring no longer holds the key at all. An entry that is
    /// both `retired` and non-zero is the state to investigate before anything
    /// else: those rows cannot be decrypted until the key is restored in
    /// `MASTER_KEY_OLD`.
    pub status: String,
    /// Rows still sealed under this key id, current versions and history alike.
    #[serde(default)]
    pub rows_remaining: u64,
    /// When a rekey last moved rows off this key, in epoch milliseconds.
    #[serde(default)]
    pub last_rekey_at: Option<i64>,
}

/// What one page of a rekey moved, and what is left.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RekeyProgress {
    /// Rows re-encrypted onto the active key by this call.
    pub rekeyed: u64,
    /// Rows still sealed under some other key id. Zero means the rotation is
    /// finished and the retired key can go.
    pub remaining: u64,
}

/// The server's error body.
///
/// **Flat.** There is no wrapping `error` object: the fields are at the top
/// level, exactly as `ApiErrorBody` in `@prick/shared` declares them. Every
/// non-2xx response in the API uses this one shape.
///
/// `issues` carries `{path, message}` and nothing else. The zod formatter that
/// builds it drops `issue.input`, so a validation failure on a secret write
/// names the field and never the rejected value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ApiErrorBody {
    /// A stable machine-readable code, such as `VALIDATION_FAILED`.
    pub code: String,
    /// A human-readable message.
    pub message: String,
    /// The `X-Request-Id` this failure was recorded under.
    #[serde(default)]
    pub request_id: Option<String>,
    /// The server's own actionable next step, when it has one.
    #[serde(default)]
    pub hint: Option<String>,
    /// Which fields were rejected, for a validation failure.
    #[serde(default)]
    pub issues: Vec<ApiErrorIssue>,
}

/// One rejected field of an [`ApiErrorBody`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ApiErrorIssue {
    /// The dotted path to the field. For a secrets map this is the secret's
    /// **key**, which is plaintext metadata; the value lives on a sibling field
    /// the server never reads.
    pub path: String,
    /// What was wrong with it.
    pub message: String,
}

/// How many rejected fields are named in a rendered message before the rest are
/// summarised as a count.
///
/// A `:batch` of two hundred keys can fail validation on all two hundred, and a
/// terminal full of them buries the first one -- which is the one to fix.
const ISSUES_RENDERED: usize = 3;

impl ApiErrorBody {
    /// Renders the body as a single message.
    ///
    /// The code is appended so an operator can grep for it, and the rejected
    /// fields are named because a `VALIDATION_FAILED` that does not say which
    /// field failed is not actionable.
    pub fn into_message(self) -> String {
        use std::fmt::Write as _;

        let mut message = format!("{} ({})", self.message, self.code);

        if !self.issues.is_empty() {
            let named: Vec<String> = self
                .issues
                .iter()
                .take(ISSUES_RENDERED)
                .map(|issue| format!("{}: {}", issue.path, issue.message))
                .collect();
            let _ = write!(message, " [{}", named.join("; "));
            if let Some(rest) = self.issues.len().checked_sub(ISSUES_RENDERED).filter(|n| *n > 0) {
                let _ = write!(message, "; and {rest} more");
            }
            message.push(']');
        }

        message
    }
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    #[test]
    fn a_health_response_identifies_the_service() {
        // The body `GET /api/v1/health` actually returns.
        let health: Health =
            serde_json::from_str(r#"{"service":"prick","status":"ok","version":"0.0.0-dev"}"#)
                .expect("the shape matches");
        assert!(health.is_prick());
        assert_eq!(health.status.as_deref(), Some("ok"));
        assert_eq!(health.version, "0.0.0-dev");
    }

    #[test]
    fn some_other_json_service_is_not_accepted() {
        let health =
            Health { service: "another".to_owned(), status: None, version: "1.0.0".to_owned() };
        assert!(!health.is_prick());
    }

    #[test]
    fn whoami_reads_the_servers_camel_case_spelling() {
        let whoami: Whoami = serde_json::from_str(
            r#"{"kind":"service","subject":"abc.access",
                "identityId":"0199a0c0-0000-7000-8000-000000000001","role":null,"bootstrap":false}"#,
        )
        .expect("the shape matches");

        assert_eq!(whoami.kind, "service");
        assert_eq!(whoami.identity_id.as_deref(), Some("0199a0c0-0000-7000-8000-000000000001"));
        assert_eq!(whoami.role, None, "a project-scoped admin has no global role");
        assert!(!whoami.bootstrap);
    }

    #[test]
    fn a_project_carries_its_slug_and_environment_count() {
        let project: Project = serde_json::from_str(
            r#"{"id":"0199a0c0-0000-7000-8000-000000000002","slug":"billing","name":"Billing",
                "description":null,"environmentCount":3,"updatedAt":1760000000000}"#,
        )
        .expect("the shape matches");

        assert_eq!(project.slug, "billing");
        assert_eq!(project.environment_count, 3);
        assert_eq!(project.updated_at, 1_760_000_000_000);
    }

    #[test]
    fn an_environment_reads_project_id_as_camel_case_and_carries_a_slug() {
        // The delta that mattered: the server emits `projectId` and `slug`, and
        // a client reading `project_id` and addressing by `name` misses both.
        let environment: Environment = serde_json::from_str(
            r#"{"id":"0199a0c0-0000-7000-8000-000000000003",
                "projectId":"0199a0c0-0000-7000-8000-000000000002","slug":"eu-west",
                "name":"EU West","description":null,"rev":7,"secretCount":12,
                "updatedAt":1760000000000}"#,
        )
        .expect("the shape matches");

        assert_eq!(environment.project_id, "0199a0c0-0000-7000-8000-000000000002");
        assert_eq!(environment.slug, "eu-west");
        assert_eq!(environment.rev, 7);
        assert_eq!(environment.secret_count, 12);
    }

    #[test]
    fn a_secret_listing_can_report_an_unreadable_row() {
        let entry: SecretMeta = serde_json::from_str(
            r#"{"key":"DATABASE_URL","description":null,"version":3,
                "updatedAt":1760000000000,"updatedBy":"ci@example.com","kid":"k1",
                "unreadable":true}"#,
        )
        .expect("the shape matches");

        assert!(entry.unreadable, "an unreadable row must be representable, not dropped");
        assert_eq!(entry.updated_by, "ci@example.com");
        assert_eq!(entry.kid.as_deref(), Some("k1"));
    }

    #[test]
    fn a_revealed_secret_is_a_key_and_a_value_and_nothing_else() {
        // No `version`: `revealSecret` returns the plaintext and nothing more.
        let secret: SecretValue =
            serde_json::from_str(r#"{"key":"DATABASE_URL","value":"postgres://u:p@h/db"}"#)
                .expect("the shape matches");

        assert_eq!(secret.key, "DATABASE_URL");
        assert_eq!(secret.value.expose_secret(), "postgres://u:p@h/db");
    }

    #[test]
    fn a_secret_value_never_renders_through_debug() {
        let secret: SecretValue =
            serde_json::from_str(r#"{"key":"K","value":"hunter2"}"#).expect("the shape matches");

        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("hunter2"), "a value leaked through Debug: {rendered}");
        assert!(rendered.contains('K'), "the key is plaintext and should still be visible");
    }

    #[test]
    fn an_export_is_a_flat_map_in_key_order() {
        let export: SecretExport =
            serde_json::from_str(r#"{"REDIS_URL":"redis://h","DATABASE_URL":"postgres://h"}"#)
                .expect("the shape matches");

        assert_eq!(export.len(), 2);
        assert_eq!(export.keys().collect::<Vec<_>>(), ["DATABASE_URL", "REDIS_URL"]);
        assert_eq!(
            export.entries().next().map(|(key, value)| (key, value.expose_secret())),
            Some(("DATABASE_URL", "postgres://h"))
        );
    }

    #[test]
    fn an_export_never_renders_through_debug_either() {
        let export: SecretExport =
            serde_json::from_str(r#"{"A":"hunter2"}"#).expect("the shape matches");

        assert!(!format!("{export:?}").contains("hunter2"));
        assert_eq!(export.into_pairs().len(), 1);
    }

    #[test]
    fn an_empty_export_is_representable() {
        let export: SecretExport = serde_json::from_str("{}").expect("the shape matches");
        assert!(export.is_empty());
    }

    #[test]
    fn a_batch_result_reports_the_new_revision_and_the_diff() {
        let result: WriteResult = serde_json::from_str(
            r#"{"rev":8,"added":["NEW_KEY"],"changed":[],"removed":["OLD_KEY"]}"#,
        )
        .expect("the shape matches");

        assert_eq!(result.rev, 8);
        assert_eq!(result.added, ["NEW_KEY"]);
        assert_eq!(result.removed, ["OLD_KEY"]);
    }

    #[test]
    fn an_import_result_distinguishes_a_dry_run() {
        let result: ImportResult = serde_json::from_str(
            r#"{"added":["A"],"changed":["B"],"removed":[],"applied":false,
                "warnings":[{"line":4,"key":"C","message":"duplicate key"}]}"#,
        )
        .expect("the shape matches");

        assert!(!result.applied, "a dry run writes nothing");
        assert_eq!(result.warnings[0].line, 4);
        assert_eq!(result.warnings[0].key, "C");
    }

    #[test]
    fn a_rollback_result_names_the_new_version_rather_than_the_old_one() {
        let result: RollbackResult =
            serde_json::from_str(r#"{"rev":9,"version":5}"#).expect("the shape matches");
        assert_eq!(result.rev, 9);
        assert_eq!(result.version, 5, "a rollback moves forward");
    }

    #[test]
    fn a_grant_renders_its_scope_the_way_the_cli_spells_one() {
        let global = Grant {
            id: "g1".to_owned(),
            identity_id: "i1".to_owned(),
            subject: "ci@example.com".to_owned(),
            role: "admin".to_owned(),
            scope_type: "global".to_owned(),
            project_slug: None,
            environment_slug: None,
            expires_at: None,
        };
        assert_eq!(global.scope(), "*:*");

        let environment = Grant {
            scope_type: "environment".to_owned(),
            project_slug: Some("billing".to_owned()),
            environment_slug: Some("eu-west".to_owned()),
            ..global.clone()
        };
        assert_eq!(environment.scope(), "billing:eu-west");

        let project = Grant { environment_slug: None, ..environment };
        assert_eq!(project.scope(), "billing:*");
    }

    #[test]
    fn a_grant_deserialises_from_the_servers_camel_case_row() {
        let grant: Grant = serde_json::from_str(
            r#"{"id":"0199a0c0-0000-7000-8000-000000000004",
                "identityId":"0199a0c0-0000-7000-8000-000000000005","subject":"ci@example.com",
                "role":"writer","scopeType":"environment","projectSlug":"billing",
                "environmentSlug":"eu-west","expiresAt":null}"#,
        )
        .expect("the shape matches");

        assert_eq!(grant.identity_id, "0199a0c0-0000-7000-8000-000000000005");
        assert_eq!(grant.scope(), "billing:eu-west");
        assert_eq!(grant.expires_at, None);
    }

    #[test]
    fn an_identity_and_a_denied_subject_both_deserialise() {
        let identity: Identity = serde_json::from_str(
            r#"{"id":"0199a0c0-0000-7000-8000-000000000006","kind":"service",
                "subject":"abc.access","displayName":null,"disabled":false,
                "lastSeenAt":1760000000000}"#,
        )
        .expect("the shape matches");
        assert_eq!(identity.subject, "abc.access");
        assert_eq!(identity.last_seen_at, Some(1_760_000_000_000));

        let denied: UnknownIdentity = serde_json::from_str(
            r#"{"kind":"service","subject":"abc.access","firstSeenAt":1,"lastSeenAt":2,
                "attempts":9}"#,
        )
        .expect("the shape matches");
        assert_eq!(denied.attempts, 9);
    }

    #[test]
    fn the_key_ring_and_a_page_of_progress_deserialise() {
        let status: KeyringStatus = serde_json::from_str(
            r#"{"activeKid":"9d1c","safeToRemoveOldKey":false,"oldKeyLoaded":true,
                "entries":[{"kid":"9d1c","status":"active","rowsRemaining":0,"lastRekeyAt":null},
                           {"kid":"4f2a","status":"retiring","rowsRemaining":2417,
                            "lastRekeyAt":1760000000000}]}"#,
        )
        .expect("the shape matches");

        assert_eq!(status.active_kid, "9d1c");
        assert!(!status.safe_to_remove_old_key);
        assert!(status.old_key_loaded);
        assert_eq!(status.entries[1].rows_remaining, 2417);
        assert_eq!(status.entries[1].last_rekey_at, Some(1_760_000_000_000));

        let progress: RekeyProgress =
            serde_json::from_str(r#"{"rekeyed":100,"remaining":2317}"#).expect("the shape matches");
        assert_eq!(progress.rekeyed, 100);
        assert_eq!(progress.remaining, 2317);
    }

    #[test]
    fn the_error_body_is_flat_rather_than_wrapped() {
        // The delta: `{"error":{...}}` is not what this API returns.
        let body: ApiErrorBody = serde_json::from_str(
            r#"{"code":"LAST_ADMIN","message":"cannot remove the last administrator",
                "request_id":"01J8Z3K9X0","hint":"Set BOOTSTRAP_ADMINS and redeploy."}"#,
        )
        .expect("the shape matches");

        assert_eq!(body.code, "LAST_ADMIN");
        assert_eq!(body.request_id.as_deref(), Some("01J8Z3K9X0"));
        assert_eq!(body.hint.as_deref(), Some("Set BOOTSTRAP_ADMINS and redeploy."));
        assert!(body.into_message().contains("LAST_ADMIN"));
    }

    #[test]
    fn a_wrapped_envelope_is_no_longer_accepted() {
        // Guards the fix: the old shape must not deserialise into the new type,
        // or a regression would look like a passing test.
        let wrapped = serde_json::from_str::<ApiErrorBody>(
            r#"{"error":{"code":"LAST_ADMIN","message":"nope"}}"#,
        );
        assert!(wrapped.is_err());
    }

    #[test]
    fn a_validation_failure_names_the_fields_that_were_rejected() {
        let body: ApiErrorBody = serde_json::from_str(
            r#"{"code":"VALIDATION_FAILED","message":"The request body is not valid.",
                "issues":[{"path":"set.bad key","message":"must be a POSIX environment variable name"}]}"#,
        )
        .expect("the shape matches");

        let message = body.into_message();
        assert!(message.contains("set.bad key"), "{message}");
        assert!(message.contains("POSIX"), "{message}");
    }

    #[test]
    fn a_long_issue_list_is_summarised_rather_than_printed_whole() {
        let issues: Vec<ApiErrorIssue> = (0..10)
            .map(|index| ApiErrorIssue { path: format!("set.K{index}"), message: "no".to_owned() })
            .collect();
        let body = ApiErrorBody {
            code: "VALIDATION_FAILED".to_owned(),
            message: "The request body is not valid.".to_owned(),
            request_id: None,
            hint: None,
            issues,
        };

        let message = body.into_message();
        assert!(message.contains("set.K0"), "the first failure must survive: {message}");
        assert!(message.contains("and 7 more"), "{message}");
        assert!(!message.contains("set.K9"), "{message}");
    }

    #[test]
    fn an_unknown_field_does_not_break_an_older_client() {
        // The server adds fields; a client that refused them would have to be
        // upgraded in lockstep with every deploy.
        let health: Health =
            serde_json::from_str(r#"{"service":"prick","version":"2026.815.0","extra":true}"#)
                .expect("unknown fields must be ignored");
        assert!(health.is_prick());
    }
}
