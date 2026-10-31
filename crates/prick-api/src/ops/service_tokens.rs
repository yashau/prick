//! `/capabilities` and `/service-tokens`.
//!
//! In their own file because `ops.rs` is at the `lint:loc` ceiling.
//! `tests/contract.rs` reads this file as well as `ops.rs` when it discovers
//! routes, so every `pub async fn` here is checked against `docs/openapi.json`
//! the same way.
//!
//! Every route here is global-admin only and answers `503
//! SERVICE_TOKENS_UNCONFIGURED`, with a `hint`, when the Worker lacks its
//! Cloudflare configuration. [`capabilities`] answers the same question before
//! anything is sent.
//!
//! # Requests sent exactly once
//!
//! Create, rotate and adopt go out through [`Client::request_json_once`]. Each
//! one changes Cloudflare as well as prick, and a create or rotate that is
//! retried after a `502` can mint a second secret while the first one, which
//! only the lost response carried, is gone.

use reqwest::Method;

use super::GrantScope;
use crate::client::{Body, Client};
use crate::error::ApiError;
use crate::models::{
    Capabilities, IssuedServiceToken, ReconcileResult, RotatedServiceToken, ServiceToken,
    ServiceTokenList,
};

/// The grant a new service token is created holding.
///
/// Created in the same transaction as the token, so a token never exists
/// holding less than it was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceTokenGrant<'a> {
    /// `reader`, `writer` or `admin`.
    pub role: &'a str,
    /// Where the role applies.
    pub scope: GrantScope<'a>,
    /// Absolute expiry in epoch milliseconds, or `None` for a grant that does
    /// not expire.
    pub expires_at: Option<i64>,
}

/// A `POST /service-tokens` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewServiceToken<'a> {
    /// The display name, which becomes the identity's display name too.
    pub name: &'a str,
    /// The token's lifetime: whole hours such as `8760h`, or `forever`.
    /// `None` takes the server's default of one year.
    pub duration: Option<&'a str>,
    /// The grant to create with it, or `None` for an ungranted token.
    pub grant: Option<ServiceTokenGrant<'a>>,
}

/// `GET /capabilities`.
///
/// # Errors
///
/// Any transport or response failure, including `404` from a Worker that
/// predates the route.
pub async fn capabilities(client: &Client) -> Result<Capabilities, ApiError> {
    client.get_json(&client.url(&["capabilities"])).await
}

/// `GET /service-tokens`. Every managed token, revoked ones included.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_service_tokens(client: &Client) -> Result<ServiceTokenList, ApiError> {
    client.get_json(&client.url(&["service-tokens"])).await
}

/// `POST /service-tokens`. Creates the token, its identity, and optionally a
/// grant, and answers with the client secret, once.
///
/// # Errors
///
/// Any transport or response failure, including `502 UPSTREAM_FAILED` when
/// Cloudflare refused.
pub async fn create_service_token(
    client: &Client,
    request: &NewServiceToken<'_>,
) -> Result<IssuedServiceToken, ApiError> {
    let body = create_body(request);
    client
        .request_json_once(Method::POST, &client.url(&["service-tokens"]), Body::Json(&body))
        .await
}

/// Builds the `POST /service-tokens` body.
fn create_body(request: &NewServiceToken<'_>) -> serde_json::Value {
    let mut body = serde_json::json!({ "name": request.name });
    if let Some(duration) = request.duration {
        body["duration"] = serde_json::Value::String(duration.to_owned());
    }
    if let Some(grant) = request.grant {
        body["grant"] = grant_body(&grant);
    }
    body
}

/// Builds the `grant` member: the scope union of `POST /grants`, with no
/// `identity_id`, because the identity does not exist until the token does.
fn grant_body(grant: &ServiceTokenGrant<'_>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "scope_type": grant.scope.scope_type(),
        "role": grant.role,
        "expires_at": grant.expires_at,
    });
    match grant.scope {
        GrantScope::Global => {}
        GrantScope::Project { project } => {
            body["project"] = serde_json::Value::String(project.to_owned());
        }
        GrantScope::Environment { project, environment } => {
            body["project"] = serde_json::Value::String(project.to_owned());
            body["environment"] = serde_json::Value::String(environment.to_owned());
        }
    }
    body
}

/// `POST /service-tokens/{id}/rotate`. A new secret for the same client id,
/// identity and grants.
///
/// `grace_seconds` keeps the previous secret valid that long; `None` ends it
/// immediately. A JSON body is always sent, `{}` when there is no grace.
///
/// # Errors
///
/// Any transport or response failure, including a refusal of a grace period
/// for a token Cloudflare reported as leaked, whose message and `hint` the
/// error carries.
pub async fn rotate_service_token(
    client: &Client,
    id: &str,
    grace_seconds: Option<u32>,
) -> Result<RotatedServiceToken, ApiError> {
    let body = rotate_body(grace_seconds);
    let url = client.url(&["service-tokens", id, "rotate"]);
    client.request_json_once(Method::POST, &url, Body::Json(&body)).await
}

/// Builds the rotate body.
fn rotate_body(grace_seconds: Option<u32>) -> serde_json::Value {
    match grace_seconds {
        Some(seconds) => serde_json::json!({ "grace_seconds": seconds }),
        None => serde_json::json!({}),
    }
}

/// `POST /service-tokens/{id}/refresh`. Extends the token's expiry in
/// Cloudflare by its duration, and answers with the record as it then stands.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn refresh_service_token(client: &Client, id: &str) -> Result<ServiceToken, ApiError> {
    let url = client.url(&["service-tokens", id, "refresh"]);
    client.request_json(Method::POST, &url, Body::None).await
}

/// `DELETE /service-tokens/{id}`. Disables the identity, then deletes the token
/// in Cloudflare.
///
/// # Errors
///
/// Any transport or response failure, including `409 LAST_ADMIN` when the
/// token's identity is the last usable global administrator.
pub async fn revoke_service_token(client: &Client, id: &str) -> Result<(), ApiError> {
    client.delete(&client.url(&["service-tokens", id])).await
}

/// `POST /service-tokens/adopt`. Brings a token made elsewhere under
/// management. Its secret stays wherever it already is.
///
/// # Errors
///
/// Any transport or response failure, including `409` for a token already
/// managed.
pub async fn adopt_service_token(
    client: &Client,
    client_id: &str,
    name: Option<&str>,
) -> Result<ServiceToken, ApiError> {
    let mut body = serde_json::json!({ "client_id": client_id });
    if let Some(name) = name {
        body["name"] = serde_json::Value::String(name.to_owned());
    }
    let url = client.url(&["service-tokens", "adopt"]);
    client.request_json_once(Method::POST, &url, Body::Json(&body)).await
}

/// `POST /service-tokens/reconcile`. Compares prick's records with
/// Cloudflare's, and repairs the differences when `apply` is set.
///
/// An apply goes out exactly once. It changes Cloudflare as well as prick, and
/// its `409` -- the server refusing a missing set too large to be anything but
/// a misconfiguration -- is a verdict, not contention, so repeating it would
/// only delay the hint that explains it.
///
/// # Errors
///
/// Any transport or response failure, including `409 CONFLICT` with a `hint`
/// when the server declines to apply.
pub async fn reconcile_service_tokens(
    client: &Client,
    apply: bool,
) -> Result<ReconcileResult, ApiError> {
    let body = serde_json::json!({ "apply": apply });
    let url = client.url(&["service-tokens", "reconcile"]);
    if apply {
        client.request_json_once(Method::POST, &url, Body::Json(&body)).await
    } else {
        client.request_json(Method::POST, &url, Body::Json(&body)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ungranted_token_sends_only_its_name() {
        let body = create_body(&NewServiceToken { name: "ci", duration: None, grant: None });
        assert_eq!(body, serde_json::json!({ "name": "ci" }));
    }

    #[test]
    fn a_granted_token_carries_the_scope_union_without_an_identity() {
        let body = create_body(&NewServiceToken {
            name: "deploy",
            duration: Some("forever"),
            grant: Some(ServiceTokenGrant {
                role: "writer",
                scope: GrantScope::Environment { project: "billing", environment: "eu-west" },
                expires_at: Some(1_760_000_000_000),
            }),
        });
        assert_eq!(body["duration"], "forever");
        assert_eq!(body["grant"]["scope_type"], "environment");
        assert_eq!(body["grant"]["project"], "billing");
        assert_eq!(body["grant"]["environment"], "eu-west");
        assert_eq!(body["grant"]["role"], "writer");
        assert_eq!(body["grant"]["expires_at"], 1_760_000_000_000_i64);
        assert!(body["grant"].get("identity_id").is_none());

        let global = create_body(&NewServiceToken {
            name: "admin",
            duration: None,
            grant: Some(ServiceTokenGrant {
                role: "admin",
                scope: GrantScope::Global,
                expires_at: None,
            }),
        });
        assert_eq!(global["grant"]["scope_type"], "global");
        assert!(global["grant"].get("project").is_none());
        assert_eq!(global["grant"].get("expires_at"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn a_rotation_without_grace_is_an_empty_object_rather_than_no_body() {
        assert_eq!(rotate_body(None), serde_json::json!({}));
        assert_eq!(rotate_body(Some(3600)), serde_json::json!({ "grace_seconds": 3600 }));
    }
}
