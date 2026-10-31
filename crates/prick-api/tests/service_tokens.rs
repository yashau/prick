//! `/capabilities` and `/service-tokens`, against a real HTTP server.
//!
//! The same discipline as `tests/ops.rs`: one mock per test with an exact
//! method and path, response bodies in the server's own shapes, and request
//! bodies read back and compared field by field. What is specific to these
//! routes is asserted here too: the server's `hint` reaching the caller on a
//! `503`, and a credential-minting request going out exactly once.

use std::time::Duration;

use secrecy::ExposeSecret as _;

use prick_api::ops;
use prick_api::{Client, Config, Credential, GrantScope, NewServiceToken, ServiceTokenGrant};
use prick_core::classify::ErrorKind;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A client with retries off, so one mocked failure is one observed failure.
fn client_for(server: &MockServer) -> Client {
    let config = Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        .with_retries(0, Duration::ZERO);
    Client::new(config, Credential::Anonymous).expect("building a client must succeed")
}

/// A client that WOULD retry a 5xx, to prove the minting routes do not.
fn retrying_client_for(server: &MockServer) -> Client {
    let config = Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        .with_retries(3, Duration::ZERO);
    Client::new(config, Credential::Anonymous).expect("building a client must succeed")
}

fn json(status: u16, body: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(body.as_bytes().to_vec(), "application/json")
}

const RECORD: &str = r#"{"id":"0199a0c0-0000-7000-8000-000000000010",
    "identityId":"0199a0c0-0000-7000-8000-000000000011",
    "clientId":"e367826f93b8d71185e03fe518aff3b4.access","name":"ci",
    "cloudflareId":"cf-1","cloudflareName":"prick:3f9c01ab:ci","adopted":false,
    "disabled":false,"status":"active","createdAt":1760000000000,
    "createdBy":"ada@example.com","rotatedAt":null,"revokedAt":null,"revokedBy":null,
    "cloudflare":null}"#;

async fn bodies(server: &MockServer) -> Vec<serde_json::Value> {
    server
        .received_requests()
        .await
        .expect("requests were recorded")
        .iter()
        .map(|request| serde_json::from_slice(&request.body).unwrap_or(serde_json::Value::Null))
        .collect()
}

#[tokio::test]
async fn capabilities_are_read_from_their_own_route() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/capabilities"))
        .respond_with(json(
            200,
            r#"{"api":1,"version":"2026.10.31","instance":"3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
                "limits":{"secretMaxBytes":65536,"envMaxSecrets":500,"bodyMaxBytes":1048576},
                "features":{"serviceTokens":{"state":"enabled","allowed":true,
                            "reason":null,"hint":null}}}"#,
        ))
        .mount(&server)
        .await;

    let capabilities = ops::capabilities(&client_for(&server)).await.expect("an answer");
    assert_eq!(capabilities.api, 1);
    assert!(capabilities.service_tokens().is_some_and(|feature| feature.allowed));
    assert_eq!(capabilities.limits.map(|limits| limits.env_max_secrets), Some(500));
}

#[tokio::test]
async fn a_worker_without_capabilities_answers_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/capabilities"))
        .respond_with(json(404, r#"{"code":"NOT_FOUND","message":"No such route."}"#))
        .mount(&server)
        .await;

    let err = ops::capabilities(&client_for(&server)).await.expect_err("an older Worker");
    assert_eq!(err.kind(), ErrorKind::NotFound);
}

#[tokio::test]
async fn an_unconfigured_deployment_carries_the_servers_hint_and_exits_eight() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/service-tokens"))
        .respond_with(json(
            503,
            r#"{"code":"SERVICE_TOKENS_UNCONFIGURED",
                "message":"Service-token management is not configured.",
                "hint":"Set the CF_API_TOKEN secret and the CF_ACCOUNT_ID var."}"#,
        ))
        .mount(&server)
        .await;

    let err = ops::list_service_tokens(&client_for(&server)).await.expect_err("unconfigured");
    assert_eq!(err.kind(), ErrorKind::ServiceUnavailable);
    assert_eq!(err.exit_code(), 8);
    assert!(err.to_string().contains("SERVICE_TOKENS_UNCONFIGURED"), "{err}");
    assert_eq!(err.server_hint(), Some("Set the CF_API_TOKEN secret and the CF_ACCOUNT_ID var."));
    assert_eq!(err.server_code(), Some("SERVICE_TOKENS_UNCONFIGURED"));
}

#[tokio::test]
async fn a_cloudflare_failure_is_a_server_error_with_its_code() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens"))
        .respond_with(json(502, r#"{"code":"UPSTREAM_FAILED","message":"Cloudflare refused."}"#))
        .mount(&server)
        .await;

    let request = NewServiceToken { name: "ci", duration: None, grant: None };
    let err = ops::create_service_token(&retrying_client_for(&server), &request)
        .await
        .expect_err("Cloudflare refused");
    assert_eq!(err.kind(), ErrorKind::ServerError);
    assert!(err.to_string().contains("UPSTREAM_FAILED"), "{err}");
    assert_eq!(err.server_code(), Some("UPSTREAM_FAILED"));

    // Sent once, although this client retries a 5xx: a repeat could mint a
    // second token whose secret only the lost response carried.
    let sent = server.received_requests().await.expect("requests were recorded");
    assert_eq!(sent.len(), 1, "a create is never retried");
}

#[tokio::test]
async fn a_created_token_delivers_its_secret_into_a_secret_string() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens"))
        .respond_with(json(
            201,
            &format!(
                r#"{{"token":{RECORD},
                    "grant":{{"id":"g-1","identityId":"0199a0c0-0000-7000-8000-000000000011",
                              "subject":"e367826f93b8d71185e03fe518aff3b4.access",
                              "role":"writer","scopeType":"project","projectSlug":"billing",
                              "environmentSlug":null,"expiresAt":null}},
                    "clientId":"e367826f93b8d71185e03fe518aff3b4.access",
                    "clientSecret":"0123456789abcdef-secret"}}"#
            ),
        ))
        .mount(&server)
        .await;

    let request = NewServiceToken {
        name: "ci",
        duration: Some("8760h"),
        grant: Some(ServiceTokenGrant {
            role: "writer",
            scope: GrantScope::Project { project: "billing" },
            expires_at: None,
        }),
    };
    let issued = ops::create_service_token(&client_for(&server), &request).await.expect("created");
    assert_eq!(issued.client_secret.expose_secret(), "0123456789abcdef-secret");
    assert_eq!(issued.grant.map(|grant| grant.scope()), Some("billing:*".to_owned()));
    assert!(!format!("{:?}", issued.client_secret).contains("0123456789abcdef"));

    let sent = &bodies(&server).await[0];
    assert_eq!(sent["name"], "ci");
    assert_eq!(sent["duration"], "8760h");
    assert_eq!(sent["grant"]["scope_type"], "project");
    assert_eq!(sent["grant"]["project"], "billing");
    assert_eq!(sent["grant"]["role"], "writer");
}

#[tokio::test]
async fn a_rotation_without_grace_still_sends_a_json_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens/0199a0c0-0000-7000-8000-000000000010/rotate"))
        .respond_with(json(
            200,
            &format!(
                r#"{{"token":{RECORD},"clientId":"e367826f93b8d71185e03fe518aff3b4.access",
                    "clientSecret":"rotated-secret","previousSecretExpiresAt":null}}"#
            ),
        ))
        .mount(&server)
        .await;

    let rotated = ops::rotate_service_token(
        &client_for(&server),
        "0199a0c0-0000-7000-8000-000000000010",
        None,
    )
    .await
    .expect("rotated");
    assert_eq!(rotated.client_secret.expose_secret(), "rotated-secret");
    assert_eq!(rotated.previous_secret_expires_at, None);
    assert_eq!(bodies(&server).await[0], serde_json::json!({}));
}

#[tokio::test]
async fn the_remaining_routes_use_their_documented_verbs() {
    let server = MockServer::start().await;
    let id = "0199a0c0-0000-7000-8000-000000000010";
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/service-tokens/{id}/refresh")))
        .respond_with(json(200, RECORD))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!("/api/v1/service-tokens/{id}")))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens/adopt"))
        .respond_with(json(201, RECORD))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens/reconcile"))
        .respond_with(json(
            200,
            r#"{"applied":false,"entries":[{"kind":"foreign","cloudflareId":"cf-2",
                "clientId":"abc.access","name":"prick:aaaa:other","applied":false,"error":null}]}"#,
        ))
        .mount(&server)
        .await;
    let client = client_for(&server);

    assert_eq!(ops::refresh_service_token(&client, id).await.expect("refreshed").id, id);
    ops::revoke_service_token(&client, id).await.expect("revoked");
    let adopted = ops::adopt_service_token(&client, "abc.access", None).await.expect("adopted");
    assert_eq!(adopted.label(), "ci");
    let result = ops::reconcile_service_tokens(&client, false).await.expect("compared");
    assert_eq!(result.entries[0].kind, "foreign");

    let sent = bodies(&server).await;
    assert_eq!(sent[2], serde_json::json!({ "client_id": "abc.access" }));
    assert_eq!(sent[3], serde_json::json!({ "apply": false }));
}

#[tokio::test]
async fn a_grace_refused_for_a_leaked_token_carries_the_servers_message_and_hint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens/0199a0c0-0000-7000-8000-000000000010/rotate"))
        .respond_with(json(
            409,
            r#"{"code":"CONFLICT",
                "message":"Cloudflare reported this token's secret as leaked, so the previous secret cannot be kept.",
                "hint":"Rotate without a grace period."}"#,
        ))
        .expect(1)
        .mount(&server)
        .await;

    let err = ops::rotate_service_token(
        &retrying_client_for(&server),
        "0199a0c0-0000-7000-8000-000000000010",
        Some(3600),
    )
    .await
    .expect_err("refused");
    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert!(err.to_string().contains("reported this token's secret as leaked"), "{err}");
    assert_eq!(err.server_hint(), Some("Rotate without a grace period."));
}

#[tokio::test]
async fn a_refused_reconcile_apply_is_sent_once_and_carries_its_hint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/service-tokens/reconcile"))
        .respond_with(json(
            409,
            r#"{"code":"CONFLICT",
                "message":"Cloudflare reports 5 of the 5 live service tokens missing. Nothing was changed.",
                "hint":"Check the account id."}"#,
        ))
        .expect(1)
        .mount(&server)
        .await;

    let err = ops::reconcile_service_tokens(&retrying_client_for(&server), true)
        .await
        .expect_err("refused");
    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert!(err.to_string().contains("Nothing was changed"), "{err}");
    assert_eq!(err.server_hint(), Some("Check the account id."));
}
