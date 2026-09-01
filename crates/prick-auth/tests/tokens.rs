//! Token lifecycle: renewal, revocation, and resolving a stored session.
//!
//! Split from `login.rs`, which covers the interactive handshake. These tests
//! start where that one ends: a session already exists, and what matters is
//! that it is renewed before the request that needs it, revoked when asked, and
//! reported as expired -- rather than as a server error -- when it cannot be.

use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};
use serde_json::Value;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use prick_auth::AuthError;
use prick_auth::store::{StorageBackend, StoredSession, TokenStore, Tokens};

fn client_for(server: &MockServer) -> prick_api::Client {
    let config = prick_api::Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        .with_retries(0, Duration::ZERO);
    prick_api::Client::new(config, prick_api::Credential::Anonymous)
        .expect("building a client must succeed")
}

fn json(body: &Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(body.to_string().into_bytes(), "application/json")
}

async fn mount_token(server: &MockServer, response: ResponseTemplate) {
    Mock::given(method("POST")).and(path("/token")).respond_with(response).mount(server).await;
}

fn store() -> (tempfile::TempDir, TokenStore) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = TokenStore::in_dir(dir.path().join("prick"), StorageBackend::File);
    (dir, store)
}

#[tokio::test]
async fn a_refresh_renews_the_access_token() {
    let server = MockServer::start().await;
    mount_token(
        &server,
        json(&serde_json::json!({
            "access_token": "access-2",
            "refresh_token": "refresh-2",
            "token_type": "Bearer",
            "expires_in": 900,
        })),
    )
    .await;

    let tokens = prick_auth::oauth::refresh(
        &client_for(&server),
        &format!("{}/token", server.uri()),
        "registered-client-1",
        &SecretString::from("refresh-1"),
        Some("https://prick.example.com"),
    )
    .await
    .expect("the refresh must succeed");

    assert_eq!(tokens.access_token.expose_secret(), "access-2");
    assert_eq!(tokens.refresh_token.as_ref().map(SecretString::expose_secret), Some("refresh-2"));

    let requests = server.received_requests().await.expect("recorded");
    let form = String::from_utf8_lossy(&requests[0].body);
    assert!(form.contains("grant_type=refresh_token"), "{form}");
    assert!(form.contains("refresh_token=refresh-1"), "{form}");
    // RFC 8707 section 2.2: the renewal names the same resource the first
    // exchange did, or it is asking for a different token than the one it
    // replaces.
    assert!(form.contains("resource=https%3A%2F%2Fprick.example.com"), "{form}");
}

#[tokio::test]
async fn a_refresh_that_returns_no_new_refresh_token_keeps_the_old_one() {
    // Dropping it would make every renewal the last one, and the failure would
    // only surface at the *next* renewal, long after the cause.
    let server = MockServer::start().await;
    mount_token(
        &server,
        json(&serde_json::json!({
            "access_token": "access-2",
            "token_type": "Bearer",
            "expires_in": 900,
        })),
    )
    .await;

    let tokens = prick_auth::oauth::refresh(
        &client_for(&server),
        &format!("{}/token", server.uri()),
        "client-1",
        &SecretString::from("refresh-1"),
        None,
    )
    .await
    .expect("refresh");

    assert_eq!(
        tokens.refresh_token.as_ref().map(SecretString::expose_secret),
        Some("refresh-1"),
        "the existing refresh token was dropped"
    );
}

#[tokio::test]
async fn invalid_grant_becomes_a_typed_expired_session() {
    let server = MockServer::start().await;
    mount_token(
        &server,
        ResponseTemplate::new(400).set_body_raw(
            br#"{"error":"invalid_grant","error_description":"token is expired or revoked"}"#
                .to_vec(),
            "application/json",
        ),
    )
    .await;

    let err = prick_auth::oauth::refresh(
        &client_for(&server),
        &format!("{}/token", server.uri()),
        "client-1",
        &SecretString::from("revoked"),
        None,
    )
    .await
    .expect_err("a revoked refresh token cannot renew");

    assert!(matches!(err, AuthError::AuthExpired), "{err}");
    assert_eq!(err.code(), "AUTH_EXPIRED");
    // Not the usage code: a script must be able to tell "log in again" from
    // "you typed that wrong".
    assert_eq!(err.exit_code(), 3);
    assert_ne!(err.exit_code(), 2);
}

#[tokio::test]
async fn another_oauth_error_is_reported_as_itself_rather_than_as_an_expiry() {
    let server = MockServer::start().await;
    mount_token(
        &server,
        ResponseTemplate::new(400)
            .set_body_raw(br#"{"error":"invalid_client"}"#.to_vec(), "application/json"),
    )
    .await;

    let err = prick_auth::oauth::refresh(
        &client_for(&server),
        &format!("{}/token", server.uri()),
        "client-1",
        &SecretString::from("r"),
        None,
    )
    .await
    .expect_err("an unknown client is a failure");

    match err {
        AuthError::Denied { error } => assert_eq!(error, "invalid_client"),
        other => panic!("expected a denial, got {other}"),
    }
}

#[tokio::test]
async fn a_stale_session_is_renewed_before_the_request_that_needs_it() {
    let server = MockServer::start().await;
    mount_token(
        &server,
        json(&serde_json::json!({
            "access_token": "access-renewed",
            "refresh_token": "refresh-2",
            "token_type": "Bearer",
            "expires_in": 900,
        })),
    )
    .await;

    let (_dir, store) = store();
    store
        .save(&StoredSession {
            api_url: server.uri().trim_end_matches('/').to_owned(),
            issuer: server.uri(),
            client_id: "client-1".to_owned(),
            token_endpoint: format!("{}/token", server.uri()),
            resource: Some(server.uri()),
            revocation_endpoint: Some(format!("{}/revoke", server.uri())),
            tokens: Tokens {
                access_token: SecretString::from("access-stale"),
                refresh_token: Some(SecretString::from("refresh-1")),
                // Thirty seconds left, which is inside the sixty-second skew.
                expires_at: Some(now() + 30),
            },
        })
        .expect("save");

    let resolved = prick_auth::resolve(&client_for(&server), &store, &server.uri(), None)
        .await
        .expect("the session must be renewed transparently");

    assert!(resolved.refreshed, "a token expiring mid-request was used as-is");
    match &resolved.credential {
        prick_api::Credential::Bearer(token) => {
            assert_eq!(token.expose_secret(), "access-renewed");
        }
        other => panic!("expected a bearer token, got {other:?}"),
    }

    // The renewal was written back, so the next invocation does not repeat it.
    let reloaded = store.load().expect("load").expect("a session");
    assert_eq!(reloaded.tokens.access_token.expose_secret(), "access-renewed");
    assert_eq!(reloaded.resource, Some(server.uri()), "the resource indicator was not kept");

    // And the renewal named the resource the stored session was minted for,
    // rather than dropping it and asking for a token for something else.
    let requests = server.received_requests().await.expect("recorded");
    let form = String::from_utf8_lossy(&requests[0].body);
    let sent: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(form.as_bytes()).into_owned().collect();
    assert_eq!(sent.get("resource").map(String::as_str), Some(server.uri().as_str()), "{form}");
}

#[tokio::test]
async fn a_revoked_session_surfaces_as_expired_rather_than_as_a_server_error() {
    let server = MockServer::start().await;
    mount_token(
        &server,
        ResponseTemplate::new(400)
            .set_body_raw(br#"{"error":"invalid_grant"}"#.to_vec(), "application/json"),
    )
    .await;

    let (_dir, store) = store();
    store
        .save(&StoredSession {
            api_url: server.uri().trim_end_matches('/').to_owned(),
            issuer: server.uri(),
            client_id: "client-1".to_owned(),
            token_endpoint: format!("{}/token", server.uri()),
            resource: None,
            revocation_endpoint: None,
            tokens: Tokens {
                access_token: SecretString::from("stale"),
                refresh_token: Some(SecretString::from("revoked")),
                expires_at: Some(now().saturating_sub(10)),
            },
        })
        .expect("save");

    let err = prick_auth::resolve(&client_for(&server), &store, &server.uri(), None)
        .await
        .expect_err("a revoked session cannot be renewed");

    assert!(matches!(err, AuthError::AuthExpired), "{err}");
    assert_eq!(err.exit_code(), 3);
}

#[tokio::test]
async fn a_revocation_hands_back_the_refresh_token_as_a_form_post() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/revoke"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    prick_auth::oauth::revoke(
        &client_for(&server),
        &format!("{}/revoke", server.uri()),
        "client-1",
        &SecretString::from("refresh-xyz"),
        prick_auth::oauth::HINT_REFRESH_TOKEN,
    )
    .await
    .expect("a 200 means the server has forgotten it");

    let requests = server.received_requests().await.expect("the server recorded requests");
    let revocation = requests
        .iter()
        .find(|request| request.url.path() == "/revoke")
        .expect("the revocation was sent");

    let body = String::from_utf8_lossy(&revocation.body);
    let sent: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(body.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();

    assert_eq!(sent.get("token").map(String::as_str), Some("refresh-xyz"));
    assert_eq!(sent.get("token_type_hint").map(String::as_str), Some("refresh_token"));
    // A public client authenticates with its identity alone, so the id has to be
    // in the body -- without it the server cannot tell whose token this is.
    assert_eq!(sent.get("client_id").map(String::as_str), Some("client-1"));

    let content_type = revocation
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(content_type.starts_with("application/x-www-form-urlencoded"), "{content_type}");
}

#[tokio::test]
async fn a_token_the_server_never_knew_is_not_a_failure() {
    // RFC 7009 section 2.2: a `200` covers both "revoked" and "that was not a
    // token I recognise", because distinguishing them would make this endpoint
    // an oracle for whether a token is live. The desired state already holds.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/revoke"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    prick_auth::oauth::revoke(
        &client_for(&server),
        &format!("{}/revoke", server.uri()),
        "client-1",
        &SecretString::from("never-existed"),
        prick_auth::oauth::HINT_ACCESS_TOKEN,
    )
    .await
    .expect("an unknown token leaves nothing to do");
}

#[tokio::test]
async fn a_refused_revocation_reports_the_servers_own_reason() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/revoke"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "error": "unsupported_token_type"
        })))
        .mount(&server)
        .await;

    let err = prick_auth::oauth::revoke(
        &client_for(&server),
        &format!("{}/revoke", server.uri()),
        "client-1",
        &SecretString::from("refresh-xyz"),
        prick_auth::oauth::HINT_REFRESH_TOKEN,
    )
    .await
    .expect_err("a 400 is a refusal");

    match err {
        AuthError::Denied { error } => assert_eq!(error, "unsupported_token_type"),
        other => panic!("expected the server's own error code, got {other:?}"),
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}
