//! The managed OAuth handshake, end to end against a real HTTP server.
//!
//! The browser is the only thing stubbed: `login` takes the opener as a
//! parameter, and these tests pass a closure that reads the authorization URL
//! and answers the loopback listener the way a browser would. Everything else
//! -- the probe, RFC 9728 and RFC 8414 discovery, dynamic client registration,
//! the PKCE challenge, the constant-time `state` comparison, the token
//! exchange -- runs for real.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};
use serde_json::Value;
use url::Url;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use prick_auth::discovery::{self, Probe};
use prick_auth::store::{StorageBackend, StoredSession, TokenStore, Tokens};
use prick_auth::{AuthError, LoginOptions};

/// Where the liveness probe actually lives.
///
/// Under the API prefix, not at the origin. The Worker routes `/api/*` to the
/// API and everything else to the SvelteKit admin UI, so a probe of the
/// origin's `/health` reads an HTML 404. These mocks previously answered
/// `/health`, which meant they agreed with a bug rather than with the server.
const HEALTH: &str = "/api/v1/health";

/// The `WWW-Authenticate` challenge a managed-OAuth application returns.
fn challenge(server: &MockServer) -> String {
    format!(
        r#"Bearer realm="prick", resource_metadata="{}/.well-known/oauth-protected-resource""#,
        server.uri()
    )
}

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

/// Mounts everything an Access application with managed OAuth serves.
async fn mount_discovery(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("www-authenticate", challenge(server).as_str())
                .set_body_raw(b"unauthorized".to_vec(), "text/plain"),
        )
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/.well-known/oauth-protected-resource"))
        .respond_with(json(&serde_json::json!({
            "resource": server.uri(),
            "authorization_servers": [server.uri()],
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/.well-known/oauth-authorization-server"))
        .respond_with(json(&serde_json::json!({
            "issuer": server.uri(),
            "authorization_endpoint": format!("{}/authorize", server.uri()),
            "token_endpoint": format!("{}/token", server.uri()),
            "registration_endpoint": format!("{}/register", server.uri()),
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["openid", "email", "profile", "offline_access"],
        })))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/register"))
        .respond_with(json(&serde_json::json!({ "client_id": "registered-client-1" })))
        .mount(server)
        .await;
}

async fn mount_token(server: &MockServer, response: ResponseTemplate) {
    Mock::given(method("POST")).and(path("/token")).respond_with(response).mount(server).await;
}

/// Answers the loopback listener the way a browser would.
///
/// Spawns a thread because the listener is not accepting yet: `login` calls the
/// opener and only then waits. The connection sits in the accept backlog until
/// it does, which is exactly what happens with a real browser.
fn browser_answering(
    query: impl Fn(&Url) -> String + Send + 'static,
) -> impl FnOnce(&str) -> Result<(), AuthError> {
    move |authorize_url: &str| {
        let parsed = Url::parse(authorize_url).expect("login must produce a URL");
        let port: u16 = parsed
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| {
                Url::parse(&value).expect("a redirect URI").port().expect("an explicit port")
            })
            .expect("a redirect URI is always sent");

        let request =
            format!("GET /callback?{} HTTP/1.1\r\nHost: localhost\r\n\r\n", query(&parsed));

        std::thread::spawn(move || {
            let mut stream =
                TcpStream::connect(("127.0.0.1", port)).expect("the listener is already bound");
            stream.write_all(request.as_bytes()).expect("write");
            let mut discarded = String::new();
            let _ = stream.read_to_string(&mut discarded);
        });

        Ok(())
    }
}

/// The query a successful redirect carries: the code, and the state echoed back.
fn successful_redirect(authorize: &Url) -> String {
    let state = authorize
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .expect("state is always sent");
    format!("code=the-authorization-code&state={state}")
}

fn store() -> (tempfile::TempDir, TokenStore) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = TokenStore::in_dir(dir.path().join("prick"), StorageBackend::File);
    (dir, store)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_login_produces_a_storable_session() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(
        &server,
        json(&serde_json::json!({
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "token_type": "Bearer",
            "expires_in": 900,
        })),
    )
    .await;

    let client = client_for(&server);
    let outcome = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(successful_redirect),
    )
    .await
    .expect("the whole handshake must succeed");

    assert_eq!(outcome.session.client_id, "registered-client-1");
    assert_eq!(outcome.session.api_url, server.uri().trim_end_matches('/'));
    assert_eq!(outcome.session.tokens.access_token.expose_secret(), "access-1");
    assert_eq!(
        outcome.session.tokens.refresh_token.as_ref().map(SecretString::expose_secret),
        Some("refresh-1")
    );
    assert!(
        outcome.session.tokens.expires_at.is_some(),
        "expires_in was not turned into a deadline"
    );
    assert!(matches!(outcome.probe, Probe::ManagedOAuth { .. }));

    // And it survives a round trip through the store.
    let (_dir, store) = store();
    store.save(&outcome.session).expect("save");
    let loaded = store.load().expect("load").expect("a session");
    assert_eq!(loaded.tokens.access_token.expose_secret(), "access-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_client_is_registered_for_the_loopback_port_that_was_just_bound() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(&server, json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })))
        .await;

    let client = client_for(&server);
    prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(successful_redirect),
    )
    .await
    .expect("login");

    let requests = server.received_requests().await.expect("recorded");
    let registration = requests
        .iter()
        .find(|request| request.url.path() == "/register")
        .expect("a registration was sent");
    let body: Value = serde_json::from_slice(&registration.body).expect("JSON");

    let redirect = body["redirect_uris"][0].as_str().expect("one redirect URI");
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    assert!(redirect.ends_with("/callback"), "{redirect}");
    // Never `localhost`: on a dual-stack host it may resolve to ::1, and the
    // registered URI is matched as a literal string.
    assert!(!redirect.contains("localhost"), "{redirect}");

    // A public client on a user's laptop cannot keep a secret; PKCE replaces it.
    assert_eq!(body["token_endpoint_auth_method"], "none");
    assert_eq!(body["application_type"], "native");
    assert!(
        body["grant_types"].as_array().expect("grant types").iter().any(|g| g == "refresh_token"),
        "without refresh_token every expiry would need another browser round trip"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_token_request_carries_the_verifier_and_never_the_challenge() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(&server, json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })))
        .await;

    let client = client_for(&server);
    prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(successful_redirect),
    )
    .await
    .expect("login");

    let requests = server.received_requests().await.expect("recorded");
    let exchange = requests
        .iter()
        .find(|request| request.url.path() == "/token")
        .expect("a token request was sent");

    let form = String::from_utf8_lossy(&exchange.body);
    assert!(form.contains("grant_type=authorization_code"), "{form}");
    assert!(form.contains("code=the-authorization-code"), "{form}");
    assert!(form.contains("code_verifier="), "the PKCE verifier was not sent: {form}");
    assert!(form.contains("client_id=registered-client-1"), "{form}");
    assert!(
        !form.contains("code_challenge"),
        "the challenge belongs in the authorization request, not the exchange: {form}"
    );
}

/// THE RESOURCE INDICATOR IS NOT OPTIONAL.
///
/// Cloudflare Access refuses an authorization request that carries no
/// `resource` with `invalid_target` and `No resource parameter found`, and it
/// delivers that refusal to the loopback callback -- so the login reads as
/// "the authorization server refused the login", with nothing naming the
/// parameter that was missing.
#[tokio::test(flavor = "multi_thread")]
async fn every_request_names_the_resource_the_metadata_declared() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(&server, json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })))
        .await;

    let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let recorder = std::sync::Arc::clone(&seen);

    let client = client_for(&server);
    let outcome = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(move |authorize| {
            recorder.lock().expect("not poisoned").clone_from(&authorize.to_string());
            successful_redirect(authorize)
        }),
    )
    .await
    .expect("login");

    // What the browser was sent. The value is the one the protected resource
    // metadata declared, not one this client made up.
    let url = Url::parse(&seen.lock().expect("not poisoned").clone()).expect("a URL");
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("resource").map(String::as_str),
        Some(server.uri().as_str()),
        "the authorization request named no resource: {url}"
    );

    // And the exchange repeats it, per RFC 8707 section 2.2.
    let requests = server.received_requests().await.expect("recorded");
    let exchange = requests
        .iter()
        .find(|request| request.url.path() == "/token")
        .expect("a token request was sent");
    let sent: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(&exchange.body).into_owned().collect();
    assert_eq!(sent.get("resource").map(String::as_str), Some(server.uri().as_str()));

    // Kept, so a renewal can name the same one without repeating discovery.
    assert_eq!(outcome.session.resource.as_deref(), Some(server.uri().as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_authorization_request_uses_s256_with_an_acceptable_challenge() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(&server, json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })))
        .await;

    let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let recorder = std::sync::Arc::clone(&seen);

    let client = client_for(&server);
    prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(move |authorize| {
            recorder.lock().expect("not poisoned").clone_from(&authorize.to_string());
            successful_redirect(authorize)
        }),
    )
    .await
    .expect("login");

    let url = Url::parse(&seen.lock().expect("not poisoned").clone()).expect("a URL");
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    assert_eq!(params["code_challenge_method"], "S256");
    // The Cloudflare quirk: a challenge starting with `-` or `_` is rejected by
    // the authorization endpoint, which is a ~3% intermittent login failure for
    // anyone who does not resample.
    assert!(
        prick_core::pkce::is_acceptable_challenge(&params["code_challenge"]),
        "Cloudflare would reject the challenge `{}`",
        params["code_challenge"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_carrying_the_wrong_state_is_discarded() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;
    mount_token(&server, json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })))
        .await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(|_| "code=forged&state=not-the-one-we-sent".to_owned()),
    )
    .await
    .expect_err("a mismatched state must be refused");

    assert!(matches!(err, AuthError::StateMismatch), "{err}");

    // And no exchange was attempted with the forged code.
    let requests = server.received_requests().await.expect("recorded");
    assert!(
        !requests.iter().any(|request| request.url.path() == "/token"),
        "a forged redirect reached the token endpoint"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_with_no_state_at_all_is_discarded() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(|_| "code=forged".to_owned()),
    )
    .await
    .expect_err("a redirect with no state must be refused");

    assert!(matches!(err, AuthError::StateMismatch), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_repeated_twice_is_discarded_rather_than_disambiguated() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(|authorize| {
            let real = successful_redirect(authorize);
            // The real state plus an attacker-chosen one. Picking whichever
            // matches would defeat the check entirely.
            format!("{real}&state=attacker-chosen")
        }),
    )
    .await
    .expect_err("two state values must be refused");

    assert!(matches!(err, AuthError::StateMismatch), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denial_redirect_is_reported_as_a_denial() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20) },
        browser_answering(|authorize| {
            let state = authorize
                .query_pairs()
                .find(|(key, _)| key == "state")
                .map(|(_, value)| value.into_owned())
                .expect("state");
            format!("error=access_denied&state={state}")
        }),
    )
    .await
    .expect_err("a denial is a failure");

    match err {
        AuthError::Denied { error } => assert_eq!(error, "access_denied"),
        other => panic!("expected a denial, got {other}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_that_never_answers_times_out_rather_than_hanging() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_millis(250) },
        |_url: &str| Ok(()),
    )
    .await
    .expect_err("nothing will answer");

    assert!(matches!(err, AuthError::LoginTimeout { .. }), "{err}");
    assert!(err.hint().is_some_and(|hint| hint.contains("prk login")));
}

#[tokio::test(flavor = "multi_thread")]
async fn managed_oauth_being_off_names_the_dashboard_setting() {
    let server = MockServer::start().await;
    // Access is in front -- it answered 401 -- but advertised no authorization
    // server, so there is no machine-readable way in.
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(
            ResponseTemplate::new(401).set_body_raw(b"unauthorized".to_vec(), "text/plain"),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err =
        prick_auth::login(&client, &server.uri(), &LoginOptions::default(), |_url: &str| Ok(()))
            .await
            .expect_err("there is no authorization server to use");

    assert!(matches!(err, AuthError::ManagedOAuthDisabled), "{err}");
    let hint = err.hint().expect("actionable");
    assert!(hint.contains("Zero Trust"), "{hint}");
    assert!(hint.contains("Applications"), "{hint}");
}

#[tokio::test]
async fn a_browser_only_access_redirect_is_also_reported_as_managed_oauth_being_off() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(ResponseTemplate::new(302).insert_header(
            "location",
            "https://example.cloudflareaccess.com/cdn-cgi/access/login/x",
        ))
        .mount(&server)
        .await;

    let probe = discovery::probe(&client_for(&server)).await.expect("the probe succeeds");
    assert_eq!(probe, Probe::ManagedOAuthDisabled);
}

#[tokio::test]
async fn an_unprotected_server_is_detected_and_has_a_warning_to_show() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(json(&serde_json::json!({ "service": "prick", "version": "2026.815.0" })))
        .mount(&server)
        .await;

    let probe = discovery::probe(&client_for(&server)).await.expect("the probe succeeds");
    assert_eq!(probe, Probe::Unprotected);
    assert!(probe.is_unprotected());

    // The wording is the point: this is the most important thing the tool will
    // ever tell this operator.
    assert!(discovery::UNPROTECTED_WARNING.contains("NOT protected"));
    assert!(discovery::UNPROTECTED_WARNING.contains("read every secret"));
}

#[tokio::test]
async fn something_that_is_not_this_service_is_refused_before_any_credential_is_sent() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(json(&serde_json::json!({ "service": "vault", "version": "1.15.0" })))
        .mount(&server)
        .await;

    let err = discovery::probe(&client_for(&server)).await.expect_err("not this service");
    assert!(err.to_string().contains("vault"), "{err}");
}

#[tokio::test]
async fn a_server_offering_only_plain_pkce_is_refused() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/.well-known/oauth-authorization-server"))
        .respond_with(json(&serde_json::json!({
            "issuer": server.uri(),
            "authorization_endpoint": format!("{}/authorize", server.uri()),
            "token_endpoint": format!("{}/token", server.uri()),
            "code_challenge_methods_supported": ["plain"],
        })))
        .mount(&server)
        .await;

    let err = discovery::fetch_authorization_server(&client_for(&server), &server.uri())
        .await
        .expect_err("`plain` puts the verifier on the wire");

    assert!(matches!(err, AuthError::Discovery { .. }));
    assert!(err.to_string().contains("S256"), "{err}");
}

#[tokio::test]
async fn a_server_with_no_registration_endpoint_reads_as_managed_oauth_being_off() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/.well-known/oauth-authorization-server"))
        .respond_with(json(&serde_json::json!({
            "issuer": server.uri(),
            "authorization_endpoint": format!("{}/authorize", server.uri()),
            "token_endpoint": format!("{}/token", server.uri()),
            "code_challenge_methods_supported": ["S256"],
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let metadata = discovery::fetch_authorization_server(&client, &server.uri())
        .await
        .expect("the metadata is well formed");
    assert!(metadata.registration_endpoint.is_none());

    let err = discovery::register_client(&client, &metadata, "http://127.0.0.1:1234/callback")
        .await
        .expect_err("nothing to register against");

    assert!(matches!(err, AuthError::ManagedOAuthDisabled), "{err}");
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

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}
