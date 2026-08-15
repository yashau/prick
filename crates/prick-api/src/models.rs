//! Typed request and response bodies.
//!
//! Two rules apply to everything here.
//!
//! 1. A **secret value never appears in a `Debug` output**. Value-carrying
//!    types wrap the value in [`secrecy::SecretString`], which makes a leak
//!    through a format string a compile error rather than a review finding.
//! 2. Every response type is `#[non_exhaustive]`, so the server adding a field
//!    is not a breaking change for an older client.
//!
//! Schemas here stay in step with the zod schemas in `packages/shared`; the
//! OpenAPI freshness check in CI is what enforces it.

use secrecy::SecretString;
use serde::{Deserialize, Serialize};

/// The `/health` response.
///
/// The first thing `prk login` and `prk doctor` fetch. It is deliberately tiny:
/// its job is to answer "is this a prick server" before any credential is sent,
/// so that pointing the CLI at a random URL produces a clear message rather
/// than a failed authentication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Health {
    /// Always `"prick"`. A response missing this is not a prick server.
    pub service: String,
    /// The server's version, in `YYYY.MMDD.N` form.
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
#[non_exhaustive]
pub struct Whoami {
    /// `"user"` or `"service"`.
    pub kind: String,
    /// An email address for a user, a `common_name` for a service token.
    pub subject: String,
    /// The highest role the caller holds anywhere, if any.
    #[serde(default)]
    pub role: Option<String>,
}

/// A project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Project {
    /// UUIDv7, so ids sort by creation time and paginate by cursor.
    pub id: String,
    /// The URL-safe short name used by the slug routes.
    pub slug: String,
    /// The display name.
    pub name: String,
}

/// An environment within a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Environment {
    /// UUIDv7.
    pub id: String,
    /// The owning project's id. Immutable: an environment is never reparented.
    pub project_id: String,
    /// The environment name. May contain colons.
    pub name: String,
    /// The revision counter, used for optimistic concurrency on full replace.
    pub rev: u64,
}

/// A secret's metadata. Never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SecretMeta {
    /// The key name, stored in plaintext by design.
    pub key: String,
    /// The current version number, starting at 1.
    pub version: u32,
    /// Whether the stored value failed to decrypt.
    ///
    /// Surfaced loudly rather than skipped. A tamper attempt must be the most
    /// visible thing in the system: a silently shorter listing is how a deploy
    /// goes out missing `DATABASE_URL`.
    pub unreadable: bool,
}

/// A secret with its value.
///
/// No `Serialize`, deliberately. The client reads these; nothing in the CLI has
/// a reason to write one back out as a whole document, and the derive would be
/// the one route by which a value could reach a stream through the type system
/// rather than around it.
#[derive(Debug, Clone, Deserialize)]
#[non_exhaustive]
pub struct SecretValue {
    /// The key name.
    pub key: String,
    /// The version this value belongs to.
    pub version: u32,
    /// The plaintext.
    pub value: SecretString,
}

/// A list of secrets with their values, as `:export` returns them.
#[derive(Debug, Clone, Deserialize)]
#[non_exhaustive]
pub struct SecretExport {
    /// The environment revision the export was taken at.
    pub rev: u64,
    /// The secrets, in whatever order the server sent them.
    pub secrets: Vec<SecretValue>,
}

/// The server's error body.
///
/// Matches the envelope the API's error hook produces. The zod formatter that
/// builds it drops `issue.input`, so a validation failure names the field and
/// never the rejected value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ErrorEnvelope {
    /// The error object.
    pub error: ErrorBody,
}

/// The inner error object of an [`ErrorEnvelope`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ErrorBody {
    /// A stable machine-readable code.
    pub code: String,
    /// A human-readable message.
    pub message: String,
}

impl ErrorEnvelope {
    /// Renders the envelope as a single message.
    pub fn into_message(self) -> String {
        format!("{} ({})", self.error.message, self.error.code)
    }
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    #[test]
    fn a_health_response_identifies_the_service() {
        let health = Health { service: "prick".to_owned(), version: "2026.815.0".to_owned() };
        assert!(health.is_prick());
    }

    #[test]
    fn some_other_json_service_is_not_accepted() {
        let health = Health { service: "vault".to_owned(), version: "1.0.0".to_owned() };
        assert!(!health.is_prick());
    }

    #[test]
    fn a_secret_listing_can_report_an_unreadable_row() {
        let meta = SecretMeta { key: "DATABASE_URL".to_owned(), version: 3, unreadable: true };
        assert!(meta.unreadable, "an unreadable row must be representable, not dropped");
    }

    #[test]
    fn a_secret_value_deserialises_into_a_redacted_wrapper() {
        let secret: SecretValue = serde_json::from_str(
            r#"{"key":"DATABASE_URL","version":3,"value":"postgres://u:p@h/db"}"#,
        )
        .expect("the shape matches");

        assert_eq!(secret.key, "DATABASE_URL");
        assert_eq!(secret.value.expose_secret(), "postgres://u:p@h/db");
    }

    #[test]
    fn a_secret_value_never_renders_through_debug() {
        let secret: SecretValue =
            serde_json::from_str(r#"{"key":"K","version":1,"value":"hunter2"}"#)
                .expect("the shape matches");

        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("hunter2"), "a value leaked through Debug: {rendered}");
        assert!(rendered.contains('K'), "the key is plaintext and should still be visible");
    }

    #[test]
    fn an_export_never_renders_through_debug_either() {
        let export: SecretExport = serde_json::from_str(
            r#"{"rev":4,"secrets":[{"key":"A","version":1,"value":"hunter2"}]}"#,
        )
        .expect("the shape matches");

        assert_eq!(export.rev, 4);
        assert!(!format!("{export:?}").contains("hunter2"));
    }

    #[test]
    fn an_error_envelope_carries_the_servers_own_code() {
        let envelope: ErrorEnvelope = serde_json::from_str(
            r#"{"error":{"code":"LAST_ADMIN","message":"cannot remove the last administrator"}}"#,
        )
        .expect("the shape matches");

        assert_eq!(envelope.error.code, "LAST_ADMIN");
        assert!(envelope.into_message().contains("LAST_ADMIN"));
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
