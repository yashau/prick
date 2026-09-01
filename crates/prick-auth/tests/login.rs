//! The managed OAuth handshake, end to end against a real HTTP server.
//!
//! The browser is the only thing stubbed: `login` takes the opener as a
//! parameter, and these tests pass a closure that reads the authorization URL
//! and answers the loopback listener the way a browser would. Everything else
//! -- the probe, RFC 9728 and RFC 8414 discovery, dynamic client registration,
//! the PKCE challenge, the constant-time `state` comparison, the token
//! exchange -- runs for real.
//!
//! What happens to a session *after* it exists -- renewal, revocation,
//! resolving one from the store -- lives in `tokens.rs`.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};
use serde_json::Value;
use url::Url;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use prick_core::classify::ErrorKind;

use prick_auth::discovery::{self, Probe};
use prick_auth::store::{StorageBackend, TokenStore};
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
            "revocation_endpoint": format!("{}/revoke", server.uri()),
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
    browser_answering_each(move |authorize| vec![query(authorize)])
}

/// [`browser_answering`] with more than one request to deliver, in order.
///
/// The listener is single-shot, so "a stray redirect does not consume it" needs
/// two requests on the same port: the stray one, then the real one.
fn browser_answering_each(
    queries: impl Fn(&Url) -> Vec<String> + Send + 'static,
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

        let requests: Vec<String> = queries(&parsed)
            .into_iter()
            .map(|query| format!("GET /callback?{query} HTTP/1.1\r\nHost: localhost\r\n\r\n"))
            .collect();

        std::thread::spawn(move || {
            // Sequentially, each answered before the next is sent: a browser
            // following a redirect does not race itself, and neither does the
            // operator with a stale tab.
            for request in requests {
                let mut stream =
                    TcpStream::connect(("127.0.0.1", port)).expect("the listener is already bound");
                stream.write_all(request.as_bytes()).expect("write");
                let mut discarded = String::new();
                let _ = stream.read_to_string(&mut discarded);
            }
        });

        Ok(())
    }
}

/// The `state` the authorization request sent.
fn state_of(authorize: &Url) -> String {
    authorize
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .expect("state is always sent")
}

/// The query a successful redirect carries: the code, and the state echoed back.
fn successful_redirect(authorize: &Url) -> String {
    format!("code=the-authorization-code&state={}", state_of(authorize))
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
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
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
    // Recorded at login so that logout can revoke without repeating discovery,
    // on the one command most likely to run somewhere with a worse network than
    // the login had.
    assert_eq!(
        outcome.session.revocation_endpoint.as_deref(),
        Some(format!("{}/revoke", server.uri()).as_str())
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
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
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
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
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
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
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
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
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

/// A redirect that is not this login's does not end this login.
///
/// The listener is single-shot, so ending the wait on a redirect the flow is
/// about to discard would leave the browser's genuine one arriving at a closed
/// port. The second shape is also why `state` is compared before `error` is
/// read: acting on the `error` first would let anything that can reach loopback
/// choose the sentence the operator is shown. More shapes, including a redirect
/// carrying two `state` values, are covered by the unit tests in `callback`.
#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_that_is_not_this_logins_is_ignored_rather_than_ending_it() {
    for stray in ["code=forged&state=not-the-one-we-sent", "error=server_error&state=not-ours"] {
        let server = MockServer::start().await;
        mount_discovery(&server).await;
        mount_token(
            &server,
            json(&serde_json::json!({ "access_token": "a", "token_type": "Bearer" })),
        )
        .await;

        let outcome = prick_auth::login(
            &client_for(&server),
            &server.uri(),
            &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
            browser_answering_each(move |authorize| {
                vec![stray.to_owned(), successful_redirect(authorize)]
            }),
        )
        .await
        .unwrap_or_else(|err| panic!("`{stray}` ended a login it does not belong to: {err}"));

        assert_eq!(outcome.session.tokens.access_token.expose_secret(), "a");

        let requests = server.received_requests().await.expect("recorded");
        let exchanges = requests.iter().filter(|request| request.url.path() == "/token").count();
        assert_eq!(exchanges, 1, "`{stray}`");
        assert!(
            !requests
                .iter()
                .any(|request| String::from_utf8_lossy(&request.body).contains("code=forged")),
            "a forged code reached the token endpoint for `{stray}`"
        );
    }
}

/// Nothing belonging to this login arrives, and its own deadline ends the wait.
///
/// The counterpart to the test above: strays no longer end a login, so the
/// deadline has to -- and it used to be extensible by an accepted connection
/// that dribbled, so the elapsed time is asserted and not just the error.
#[tokio::test(flavor = "multi_thread")]
async fn a_login_only_stray_redirects_reach_ends_on_its_own_deadline() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let started = std::time::Instant::now();
    let err = prick_auth::login(
        &client_for(&server),
        &server.uri(),
        &LoginOptions { timeout: Duration::from_millis(500), accept_pasted_redirect: false },
        browser_answering(|_| "code=forged&state=not-the-one-we-sent".to_owned()),
    )
    .await
    .expect_err("nothing belonging to this login ever arrived");

    assert!(matches!(err, AuthError::LoginTimeout { .. }), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());

    let requests = server.received_requests().await.expect("recorded");
    let exchanged = requests.iter().any(|request| request.url.path() == "/token");
    assert!(!exchanged, "a forged redirect reached the token endpoint");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denial_redirect_is_reported_as_a_denial() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let err = prick_auth::login(
        &client_for(&server),
        &server.uri(),
        &LoginOptions { timeout: Duration::from_secs(20), accept_pasted_redirect: false },
        browser_answering(|authorize| format!("error=access_denied&state={}", state_of(authorize))),
    )
    .await
    .expect_err("a denial is a failure");

    // The server's own refusal, carrying the state it was sent: this one has
    // been proven to be this login's, so its reason is reported.
    match err {
        AuthError::Denied { error } => assert_eq!(error, "access_denied"),
        other => panic!("expected a denial, got {other}"),
    }
}

#[tokio::test]
async fn an_authorization_endpoint_the_os_would_hand_to_a_local_program_is_refused() {
    // The endpoint is opened by the operating system, which invokes registered
    // handlers rather than opening pages -- so a discovery document naming a
    // custom scheme picks which local program this process starts.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/.well-known/oauth-authorization-server"))
        .respond_with(json(&serde_json::json!({
            "issuer": server.uri(),
            "authorization_endpoint": "someapp://open?payload=whatever",
            "token_endpoint": format!("{}/token", server.uri()),
            "code_challenge_methods_supported": ["S256"],
        })))
        .mount(&server)
        .await;

    let err = discovery::fetch_authorization_server(&client_for(&server), &server.uri())
        .await
        .expect_err("a non-HTTPS endpoint must not survive discovery");

    assert!(matches!(err, AuthError::Discovery { .. }), "{err}");
    assert!(err.to_string().contains("authorization_endpoint"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_that_never_answers_times_out_rather_than_hanging() {
    let server = MockServer::start().await;
    mount_discovery(&server).await;

    let client = client_for(&server);
    let err = prick_auth::login(
        &client,
        &server.uri(),
        &LoginOptions { timeout: Duration::from_millis(250), accept_pasted_redirect: false },
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

/// The exact shape of a real deployment behind Cloudflare's bot products: a WAF
/// exception covering `/api` and not `/.well-known`, so the probe gets through
/// and every discovery candidate is challenged.
///
/// The failure this pins is a diagnosis, not a crash. Before, each challenged
/// candidate was filed under "this spelling does not exist", the loop ran out,
/// and the reader was told the URL is not a prick server and to check
/// `--api-url` -- which was correct all along.
#[tokio::test]
async fn a_challenged_metadata_probe_reports_the_mitigation_rather_than_a_missing_document() {
    let server = MockServer::start().await;

    // No path matcher: every candidate spelling is stopped at the edge, which is
    // what a bot rule that does not know about `/.well-known` does.
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(403).insert_header("cf-mitigated", "challenge").set_body_raw(
                b"<html><title>Just a moment...</title></html>".to_vec(),
                "text/html",
            ),
        )
        .mount(&server)
        .await;

    let health = format!("{}{HEALTH}", server.uri());
    let err = discovery::resolve_protected_resource(&client_for(&server), None, &health)
        .await
        .expect_err("a challenged probe cannot yield metadata");

    assert!(
        matches!(&err, AuthError::Api(api) if api.kind() == ErrorKind::Mitigated),
        "a challenge must stay classified as one, got: {err}"
    );
    assert!(
        !err.to_string().contains("no protected resource metadata"),
        "the summary naming every URL tried describes the deployment, not the edge: {err}"
    );
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
