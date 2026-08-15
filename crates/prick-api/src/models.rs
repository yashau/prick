//! Typed request and response bodies.
//!
//! # Status
//!
//! Skeleton. Only the shapes the CLI already needs to name are present.
//!
//! TODO: fill in as the API lands, in the order the server builds it --
//! projects and environments, then secrets (including `:batch`, `:import` with
//! `dry_run`, and `:export`), then versions and rollback, then identities,
//! grants and audit. Schemas here must stay in step with the zod schemas in
//! `packages/shared`; the OpenAPI freshness check in CI is what enforces it.
//!
//! Two rules apply to everything added here.
//!
//! 1. A **secret value never appears in a `Debug` output**. Value-carrying
//!    types wrap the value in `secrecy::SecretString`, which makes a leak
//!    through a format string a compile error rather than a review finding.
//! 2. Every response type is `#[non_exhaustive]`, so the server adding a field
//!    is not a breaking change for an older client.

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

#[cfg(test)]
mod tests {
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
}
