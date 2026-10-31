//! `/capabilities` and the service-token routes.
//!
//! The server holds the Cloudflare API token as a Worker secret and creates,
//! rotates and deletes Access service tokens on an administrator's behalf, so
//! nothing here ever carries a Cloudflare credential. What does arrive is a
//! **client secret**, exactly once, in the answer to a create or a rotate. It
//! deserialises straight into a [`SecretString`], so the only way to read it is
//! an explicit `expose_secret()`, and `Debug` prints it redacted.
//!
//! Every field a newer Worker might add is tolerated: none of these types
//! denies unknown fields, and every field that is not the record's identity
//! carries a serde default.

use std::collections::BTreeMap;

use secrecy::SecretString;
use serde::Deserialize;

use super::Grant;

/// `GET /capabilities`: what this deployment can do, and what the caller may
/// do with it.
///
/// Advisory. Every route enforces its own authorization; this exists so a
/// client can stop before sending anything, with the server's own explanation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Capabilities {
    /// The HTTP API's major version. Raised only by a breaking change.
    #[serde(default)]
    pub api: u32,
    /// The Worker's release, as on `/health`.
    #[serde(default)]
    pub version: String,
    /// The deployment's instance id, the same value `/whoami` reports.
    #[serde(default)]
    pub instance: Option<String>,
    /// Size limits the server enforces.
    #[serde(default)]
    pub limits: Option<Limits>,
    /// Every feature the server reports, keyed by its wire name.
    ///
    /// A map rather than a struct, so `prk doctor` can show a feature added by
    /// a later Worker by name.
    #[serde(default)]
    pub features: BTreeMap<String, FeatureCapability>,
}

impl Capabilities {
    /// The wire name of the service-token feature.
    pub const SERVICE_TOKENS: &'static str = "serviceTokens";

    /// The service-token feature, when the server reports it.
    pub fn service_tokens(&self) -> Option<&FeatureCapability> {
        self.features.get(Self::SERVICE_TOKENS)
    }
}

/// The size limits a deployment enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Limits {
    /// The largest value one secret may hold, in bytes.
    #[serde(default)]
    pub secret_max_bytes: u64,
    /// The most secrets one environment may hold.
    #[serde(default)]
    pub env_max_secrets: u64,
    /// The largest request body the API reads, in bytes.
    #[serde(default)]
    pub body_max_bytes: u64,
}

/// One feature's availability.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct FeatureCapability {
    /// `enabled` or `unavailable`. A string, so a state a later Worker adds
    /// reads as "not enabled" rather than as a parse failure.
    #[serde(default)]
    pub state: String,
    /// Whether **this caller** may use the feature.
    #[serde(default)]
    pub allowed: bool,
    /// Why the feature is unavailable. Reported to global administrators only.
    #[serde(default)]
    pub reason: Option<String>,
    /// What to configure to enable it. Reported to global administrators only.
    #[serde(default)]
    pub hint: Option<String>,
}

impl FeatureCapability {
    /// Whether the deployment has the feature switched on.
    pub fn is_enabled(&self) -> bool {
        self.state == "enabled"
    }
}

/// A service token prick manages.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ServiceToken {
    /// prick's own id for the token. UUIDv7.
    pub id: String,
    /// The identity the token authenticates as.
    #[serde(default)]
    pub identity_id: String,
    /// The Access client id, `<hex>.access`. Also the identity's subject.
    pub client_id: String,
    /// The display name, when one is set.
    #[serde(default)]
    pub name: Option<String>,
    /// Cloudflare's id for the token.
    #[serde(default)]
    pub cloudflare_id: String,
    /// The name Cloudflare holds for the token.
    #[serde(default)]
    pub cloudflare_name: String,
    /// Whether the token was made elsewhere and brought under management.
    #[serde(default)]
    pub adopted: bool,
    /// Whether the identity's kill switch is on.
    #[serde(default)]
    pub disabled: bool,
    /// `active`, `revoked` or `missing`.
    #[serde(default)]
    pub status: String,
    /// Creation time, epoch milliseconds.
    #[serde(default)]
    pub created_at: i64,
    /// Who created it.
    #[serde(default)]
    pub created_by: String,
    /// The last rotation, epoch milliseconds.
    #[serde(default)]
    pub rotated_at: Option<i64>,
    /// The revocation, epoch milliseconds.
    #[serde(default)]
    pub revoked_at: Option<i64>,
    /// Who revoked it.
    #[serde(default)]
    pub revoked_by: Option<String>,
    /// What Cloudflare says about the token, when Cloudflare answered. `None`
    /// when it could not be asked -- including straight after a create or a
    /// rotate whose follow-up read failed -- so expiry and last use are
    /// unknown, not absent.
    #[serde(default)]
    pub cloudflare: Option<ServiceTokenCloudflare>,
}

impl ServiceToken {
    /// Whether the token has been revoked.
    pub fn is_revoked(&self) -> bool {
        self.status == "revoked"
    }

    /// The name to show a person: the display name, else Cloudflare's.
    pub fn label(&self) -> &str {
        self.name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&self.cloudflare_name)
    }
}

/// Cloudflare's view of one service token.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ServiceTokenCloudflare {
    /// When the token stops authenticating, epoch milliseconds. `None` with
    /// a [`duration`](Self::duration) of `forever` means it never does; with
    /// any other duration, the expiry is unknown.
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// When Access last saw the token used, epoch milliseconds. `None` means
    /// unknown: Cloudflare reports this field without documenting it, so its
    /// absence says nothing about whether the token was ever used.
    #[serde(default)]
    pub last_seen_at: Option<i64>,
    /// Whether Cloudflare will accept the token.
    #[serde(default)]
    pub enabled: bool,
    /// The lifetime it was created with, such as `8760h`.
    #[serde(default)]
    pub duration: Option<String>,
    /// When Cloudflare reported the secret as leaked, epoch milliseconds.
    #[serde(default)]
    pub leak_reported_at: Option<i64>,
}

/// `GET /service-tokens`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ServiceTokenList {
    /// Every token prick manages, revoked ones included.
    #[serde(default)]
    pub tokens: Vec<ServiceToken>,
    /// `ok`, or `unavailable` when Cloudflare could not be asked, in which case
    /// every token's `cloudflare` is `None`.
    #[serde(default)]
    pub cloudflare: String,
}

/// `POST /service-tokens`: a new token, its grant, and its secret.
///
/// No `Serialize`, and no `PartialEq`: the secret leaves this type only through
/// an explicit `expose_secret()`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct IssuedServiceToken {
    /// The token's record.
    pub token: ServiceToken,
    /// The grant created with it, when one was asked for.
    #[serde(default)]
    pub grant: Option<Grant>,
    /// The Access client id.
    pub client_id: String,
    /// The Access client secret. Delivered once; the server keeps no copy.
    pub client_secret: SecretString,
}

/// `POST /service-tokens/{id}/rotate`: the same token with a new secret.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RotatedServiceToken {
    /// The token's record.
    pub token: ServiceToken,
    /// The Access client id, unchanged by a rotation.
    pub client_id: String,
    /// The new Access client secret. Delivered once.
    pub client_secret: SecretString,
    /// When the previous secret stops working, epoch milliseconds. `None`
    /// means it already has.
    #[serde(default)]
    pub previous_secret_expires_at: Option<i64>,
    /// Something the rotation did not finish, such as Cloudflare declining to
    /// re-enable the token, so it still cannot authenticate.
    #[serde(default)]
    pub warning: Option<String>,
}

/// `POST /service-tokens/reconcile`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReconcileResult {
    /// Whether the server was asked to repair what it found.
    #[serde(default)]
    pub applied: bool,
    /// Each difference between prick's records and Cloudflare's.
    #[serde(default)]
    pub entries: Vec<ReconcileEntry>,
}

/// One difference between prick's records and Cloudflare's.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReconcileEntry {
    /// `orphan`, `missing`, `revoke_incomplete` or `foreign`.
    #[serde(default)]
    pub kind: String,
    /// Cloudflare's id for the token.
    #[serde(default)]
    pub cloudflare_id: String,
    /// The Access client id.
    #[serde(default)]
    pub client_id: String,
    /// The token's name, when one is known.
    #[serde(default)]
    pub name: Option<String>,
    /// Whether this entry was repaired by this call.
    #[serde(default)]
    pub applied: bool,
    /// Whether the entry is reported and deliberately left alone: too recent
    /// to judge safely, no longer eligible when an apply re-checked it, or
    /// another deployment's. A skipped entry is never a repair.
    #[serde(default)]
    pub skipped: bool,
    /// Why it was skipped.
    #[serde(default)]
    pub reason: Option<String>,
    /// Why the repair failed, when it did.
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    const RECORD: &str = r#"{
        "id": "0199a0c0-0000-7000-8000-000000000010",
        "identityId": "0199a0c0-0000-7000-8000-000000000011",
        "clientId": "e367826f93b8d71185e03fe518aff3b4.access",
        "name": "staging deploy",
        "cloudflareId": "cf-1",
        "cloudflareName": "prick: staging deploy",
        "adopted": false,
        "disabled": false,
        "status": "active",
        "createdAt": 1760000000000,
        "createdBy": "ada@example.com",
        "rotatedAt": null,
        "revokedAt": null,
        "revokedBy": null,
        "cloudflare": {"expiresAt": 1790000000000, "lastSeenAt": null, "enabled": true,
                       "duration": "8760h", "leakReportedAt": null}
    }"#;

    #[test]
    fn a_record_reads_the_servers_camel_case_spelling() {
        let token: ServiceToken = serde_json::from_str(RECORD).expect("the shape matches");
        assert_eq!(token.client_id, "e367826f93b8d71185e03fe518aff3b4.access");
        assert_eq!(token.label(), "staging deploy");
        assert!(!token.is_revoked());
        let cloudflare = token.cloudflare.expect("Cloudflare answered");
        assert_eq!(cloudflare.expires_at, Some(1_790_000_000_000));
        assert_eq!(cloudflare.duration.as_deref(), Some("8760h"));
    }

    #[test]
    fn a_newer_server_adding_fields_does_not_break_this_client() {
        let mut value: serde_json::Value = serde_json::from_str(RECORD).expect("JSON");
        value["somethingNew"] = serde_json::json!({"nested": true});
        value["cloudflare"]["alsoNew"] = serde_json::json!(1);
        let token: ServiceToken =
            serde_json::from_value(value).expect("unknown fields are ignored");
        assert_eq!(token.status, "active");

        let capabilities: Capabilities = serde_json::from_str(
            r#"{"api":1,"version":"2026.10.31","instance":null,"brandNew":[],
                "limits":{"secretMaxBytes":1,"envMaxSecrets":2,"bodyMaxBytes":3,"more":4},
                "features":{"serviceTokens":{"state":"enabled","allowed":true,"reason":null,
                            "hint":null,"extra":"x"},
                            "laterFeature":{"state":"preview","allowed":false}}}"#,
        )
        .expect("unknown fields and features are tolerated");
        assert!(capabilities.service_tokens().is_some_and(FeatureCapability::is_enabled));
        let later = capabilities.features.get("laterFeature").expect("kept by name");
        assert!(!later.is_enabled(), "an unknown state is not `enabled`");
    }

    #[test]
    fn a_sparse_record_falls_back_to_defaults() {
        let token: ServiceToken =
            serde_json::from_str(r#"{"id":"t","clientId":"abc.access"}"#).expect("defaults");
        assert_eq!(token.label(), "");
        assert!(token.cloudflare.is_none());
    }

    #[test]
    fn an_unconfigured_feature_carries_its_hint() {
        let capabilities: Capabilities = serde_json::from_str(
            r#"{"api":1,"version":"v","instance":"3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
                "limits":{"secretMaxBytes":1,"envMaxSecrets":2,"bodyMaxBytes":3},
                "features":{"serviceTokens":{"state":"unavailable","allowed":false,
                            "reason":"unconfigured","hint":"set CF_API_TOKEN"}}}"#,
        )
        .expect("the shape matches");
        let feature = capabilities.service_tokens().expect("reported");
        assert!(!feature.allowed);
        assert_eq!(feature.reason.as_deref(), Some("unconfigured"));
        assert_eq!(feature.hint.as_deref(), Some("set CF_API_TOKEN"));
    }

    #[test]
    fn an_issued_secret_is_readable_and_never_printed_through_debug() {
        let body = format!(
            r#"{{"token":{RECORD},"grant":null,"clientId":"abc.access",
                 "clientSecret":"hunter2-secret-value","newField":1}}"#
        );
        let issued: IssuedServiceToken = serde_json::from_str(&body).expect("the shape matches");
        assert_eq!(issued.client_secret.expose_secret(), "hunter2-secret-value");

        let rendered = format!("{issued:?}");
        assert!(!rendered.contains("hunter2"), "a secret leaked through Debug: {rendered}");
        assert!(rendered.contains("abc.access"), "the client id is not secret");

        let rotated: RotatedServiceToken = serde_json::from_str(&format!(
            r#"{{"token":{RECORD},"clientId":"abc.access","clientSecret":"hunter2-rotated",
                 "previousSecretExpiresAt":1760000000000}}"#
        ))
        .expect("the shape matches");
        assert!(!format!("{rotated:?}").contains("hunter2"));
        assert_eq!(rotated.previous_secret_expires_at, Some(1_760_000_000_000));
    }

    #[test]
    fn a_reconcile_result_lists_its_entries() {
        let result: ReconcileResult = serde_json::from_str(
            r#"{"applied":false,"entries":[{"kind":"orphan","cloudflareId":"cf-9",
                "clientId":"abc.access","name":null,"applied":false,"error":null}]}"#,
        )
        .expect("the shape matches");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].kind, "orphan");
        assert!(!result.entries[0].skipped, "an older server's entry is not skipped");
    }

    #[test]
    fn a_skipped_reconcile_entry_carries_its_reason() {
        let result: ReconcileResult = serde_json::from_str(
            r#"{"applied":true,"entries":[{"kind":"missing","cloudflareId":"cf-9",
                "clientId":"abc.access","name":"ci","applied":false,"skipped":true,
                "reason":"Created moments ago; too new to judge.","error":null}]}"#,
        )
        .expect("the shape matches");
        assert!(result.entries[0].skipped);
        assert_eq!(
            result.entries[0].reason.as_deref(),
            Some("Created moments ago; too new to judge.")
        );
    }

    #[test]
    fn a_rotation_carries_a_warning_and_a_record_without_cloudflare() {
        let mut record: serde_json::Value = serde_json::from_str(RECORD).expect("JSON");
        record["cloudflare"] = serde_json::Value::Null;
        let rotated: RotatedServiceToken = serde_json::from_value(serde_json::json!({
            "token": record, "clientId": "abc.access", "clientSecret": "s",
            "previousSecretExpiresAt": null, "warning": "not re-enabled",
        }))
        .expect("the shape matches");
        assert_eq!(rotated.warning.as_deref(), Some("not re-enabled"));
        assert!(rotated.token.cloudflare.is_none());
    }
}
