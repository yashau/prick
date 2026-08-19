//! The error matrix, against a real HTTP server.
//!
//! Every case here is something that actually happens to a Worker behind
//! Cloudflare Access, and every one of them used to produce
//! `SyntaxError: Unexpected token '<'` -- a message that names nothing, points
//! nowhere, and looks identical whether the server is down, the URL is wrong,
//! or the session expired.
//!
//! The assertions are therefore about *which* failure was reported and what it
//! said, not merely that something failed.

use std::time::Duration;

use prick_api::response::ResponseFacts;
use prick_api::{ApiError, Client, Config, Credential};
use prick_core::classify::ErrorKind;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Where the liveness probe actually lives.
///
/// Under the API prefix, because the Worker routes `/api/*` to the API and
/// everything else to the admin UI. A probe of the origin's `/health` reads
/// SvelteKit's 404 page.
const HEALTH: &str = "/api/v1/health";

/// `{"service":"prick","version":"2026.815.0"}`, gzip-compressed.
///
/// Precomputed rather than produced by a compression crate: the point is to
/// prove the client decompresses, and a dependency that both produced and
/// consumed the bytes would prove considerably less.
const GZIPPED_HEALTH: [u8; 61] = [
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xab, 0x56, 0x2a, 0x4e, 0x2d, 0x2a,
    0xcb, 0x4c, 0x4e, 0x55, 0xb2, 0x52, 0x2a, 0x28, 0xca, 0x4c, 0xce, 0x56, 0xd2, 0x51, 0x2a, 0x4b,
    0x2d, 0x2a, 0xce, 0xcc, 0xcf, 0x03, 0x8a, 0x18, 0x19, 0x18, 0x99, 0xe9, 0x59, 0x18, 0x9a, 0xea,
    0x19, 0x28, 0xd5, 0x02, 0x00, 0x00, 0xdc, 0xb1, 0xad, 0x2a, 0x00, 0x00, 0x00,
];

/// A Cloudflare edge error page, in the shape Cloudflare actually serves.
fn cloudflare_error_page(code: u16, summary: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\" />\n\
         <title>prick.example.com | {code}: {summary}</title>\n</head>\n\
         <body><h1>Error {code}</h1><p>{summary}</p></body></html>\n"
    )
}

/// A client pointed at a mock server, with retries off so a mocked failure is
/// observed rather than smoothed over.
fn client_for(server: &MockServer) -> Client {
    let config = Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        .with_retries(0, Duration::ZERO);
    Client::new(config, Credential::Anonymous).expect("building a client must succeed")
}

async fn mount(server: &MockServer, route: &str, response: ResponseTemplate) {
    Mock::given(method("GET")).and(path(route)).respond_with(response).mount(server).await;
}

#[tokio::test]
async fn a_healthy_server_is_recognised() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200).set_body_raw(
            br#"{"service":"prick","version":"2026.815.0"}"#.to_vec(),
            "application/json",
        ),
    )
    .await;

    let health = client_for(&server).health().await.expect("a healthy server must be accepted");
    assert_eq!(health.version, "2026.815.0");
}

#[tokio::test]
async fn a_gzipped_response_is_decompressed() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200)
            .set_body_raw(GZIPPED_HEALTH.to_vec(), "application/json")
            .insert_header("content-encoding", "gzip"),
    )
    .await;

    let health = client_for(&server).health().await.expect("gzip must be transparent");
    assert_eq!(health.version, "2026.815.0");
}

#[tokio::test]
async fn an_html_two_hundred_says_the_url_is_not_a_prick_server() {
    // The case the ordering exists for: a 200 whose body is a login page.
    // Parsing first produces "Unexpected token '<'"; checking first produces a
    // message naming the URL and what is wrong with it.
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200).set_body_raw(
            b"<!DOCTYPE html><html><head><title>Sign in to continue</title></head></html>".to_vec(),
            "text/html; charset=utf-8",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("HTML is not an API response");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert_eq!(err.exit_code(), 7);
    assert!(err.to_string().contains("text/html"), "{err}");
    assert!(err.to_string().contains("Sign in to continue"), "{err}");
    assert!(err.hint().is_some_and(|hint| hint.contains("--api-url")));
}

#[tokio::test]
async fn a_json_body_of_the_wrong_shape_is_reported_as_a_shape_problem() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200)
            .set_body_raw(br#"{"status":"ok","uptime":41}"#.to_vec(), "application/json"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("the shape does not match");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert!(err.to_string().contains("does not match"), "{err}");
    // The mismatch is located, but nothing from the body is quoted back.
    assert!(!err.to_string().contains("uptime"), "the error echoed the body: {err}");
}

#[tokio::test]
async fn a_json_response_from_some_other_service_is_refused() {
    // A 200 with well-formed JSON is not evidence of anything on its own.
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200).set_body_raw(
            br#"{"service":"vault","version":"1.15.0"}"#.to_vec(),
            "application/json",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("another service is not this one");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert!(err.to_string().contains("vault"), "{err}");
}

#[tokio::test]
async fn a_redirect_to_access_is_reported_as_a_missing_credential() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(302).insert_header(
            "location",
            "https://example.cloudflareaccess.com/cdn-cgi/access/login/prick.example.com",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("a redirect is not an API response");
    assert_eq!(err.kind(), ErrorKind::Unauthenticated);
    assert_eq!(err.exit_code(), 3);
    assert!(err.to_string().contains("Access"), "{err}");
    assert!(err.hint().is_some_and(|hint| hint.contains("prk login")));
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    // Following it would replace the diagnosis above with an HTML 200 from
    // somewhere else entirely.
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(302).insert_header("location", "https://example.com/elsewhere"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("a redirect is not an API response");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert!(err.to_string().contains("example.com"), "{err}");
}

#[tokio::test]
async fn a_401_carries_its_discovery_pointer_through_rather_than_swallowing_it() {
    // `prk login` starts here. If the transport turned a 401 into an error and
    // dropped the header, the whole managed-OAuth flow would have to be built
    // around the transport rather than on it.
    const CHALLENGE: &str = r#"Bearer resource_metadata="https://prick.example.com/.well-known/oauth-protected-resource""#;

    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(401)
            .insert_header("www-authenticate", CHALLENGE)
            .set_body_raw(b"unauthorized".to_vec(), "text/plain"),
    )
    .await;

    let client = client_for(&server);
    let received = client
        .fetch(reqwest::Method::GET, &client.url(&["health"]), prick_api::Body::None)
        .await
        .expect("a 401 is not a transport failure");

    assert_eq!(received.facts.status, 401);
    assert_eq!(received.facts.www_authenticate.as_deref(), Some(CHALLENGE));

    // The typed path still reports it as a failure, with the right kind.
    let err = client.health().await.expect_err("a 401 is a failure for a typed call");
    assert_eq!(err.kind(), ErrorKind::Unauthenticated);
    assert!(err.to_string().contains("authorization server"), "{err}");
}

#[tokio::test]
async fn an_access_denial_page_is_distinguished_from_an_api_forbidden() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(403).insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR").set_body_raw(
            b"<html><head><title>Access denied | prick.example.com</title></head></html>".to_vec(),
            "text/html",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("a denial page is a failure");
    assert_eq!(err.kind(), ErrorKind::Forbidden);
    assert_eq!(err.exit_code(), 4);
    assert!(err.to_string().contains("Access"), "{err}");
}

#[tokio::test]
async fn a_managed_challenge_is_named_as_such() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(403)
            .insert_header("cf-mitigated", "challenge")
            .insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR")
            .set_body_raw(b"<html><title>Just a moment...</title></html>".to_vec(), "text/html"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("a challenge is a failure");
    assert_eq!(err.kind(), ErrorKind::Forbidden);
    assert!(err.to_string().contains("challenge"), "{err}");
}

#[tokio::test]
async fn a_cloudflare_1033_page_names_the_tunnel() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(530).insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR").set_body_raw(
            cloudflare_error_page(1033, "Argo Tunnel error").into_bytes(),
            "text/html",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("an edge error is a failure");
    assert_eq!(err.kind(), ErrorKind::Unreachable);
    assert_eq!(err.exit_code(), 7);
    assert!(err.to_string().contains("1033"), "{err}");
    assert!(err.to_string().contains("tunnel"), "{err}");
}

#[tokio::test]
async fn a_bare_530_still_says_the_worker_could_not_be_reached() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(530)
            .insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR")
            .set_body_raw(b"<html><title>prick.example.com</title></html>".to_vec(), "text/html"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("530 is a failure");
    assert_eq!(err.kind(), ErrorKind::Unreachable);
    assert!(err.to_string().contains("Worker"), "{err}");
}

#[tokio::test]
async fn a_worker_exception_page_is_read_out_of_the_title() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(500).insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR").set_body_raw(
            cloudflare_error_page(1101, "Worker threw exception").into_bytes(),
            "text/html",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("1101 is a failure");
    assert_eq!(err.kind(), ErrorKind::Unreachable);
    assert!(err.to_string().contains("1101"), "{err}");
}

#[tokio::test]
async fn an_export_of_secrets_at_the_servers_own_limit_is_read_rather_than_refused() {
    // The reported failure. The server takes a secret of up to
    // SERVER_SECRET_VALUE_CAP bytes and an environment holds many of them, so
    // two accepted writes already exceed anything sized for one response. A cap
    // below what the server accepts leaves an environment that cannot be
    // exported or run while writes to it keep succeeding, and the operator is
    // told to check --api-url.
    let server = MockServer::start().await;
    let blob = "x".repeat(prick_api::response::SERVER_SECRET_VALUE_CAP);
    let export = format!(r#"{{"BLOB_ONE":"{blob}","BLOB_TWO":"{blob}"}}"#);
    assert!(export.len() > 2 * prick_api::response::NON_JSON_BODY_CAP);

    Mock::given(method("GET"))
        .and(path("/api/v1/projects/api/environments/production/secrets:export"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(export.into_bytes(), "application/json"),
        )
        .mount(&server)
        .await;

    let values = prick_api::ops::export_secrets(&client_for(&server), "api", "production")
        .await
        .expect("an export the server accepted must be readable");
    assert_eq!(values.len(), 2);
    assert_eq!(values.keys().collect::<Vec<_>>(), ["BLOB_ONE", "BLOB_TWO"]);
}

#[tokio::test]
async fn a_page_that_is_not_json_is_still_read_only_as_far_as_its_title() {
    // The tight cap is the one that guards an unknown body, and a megabyte of
    // HTML must not become a megabyte in memory. Everything past the `<head>`
    // is discarded, and the diagnosis is unchanged by the discarding.
    let server = MockServer::start().await;
    let page = format!(
        "<html><head><title>Sign in to continue</title></head><body>{}</body></html>",
        "padding ".repeat(200 * 1024)
    );
    assert!(page.len() > prick_api::response::NON_JSON_BODY_CAP);
    mount(&server, HEALTH, ResponseTemplate::new(200).set_body_raw(page.into_bytes(), "text/html"))
        .await;

    let err = client_for(&server).health().await.expect_err("HTML is not an API response");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert!(err.to_string().contains("Sign in to continue"), "{err}");
    assert!(err.facts().is_some_and(|facts| facts.truncated), "the page was read whole: {err}");
}

#[tokio::test]
async fn a_json_body_with_the_wrong_content_type_is_not_parsed() {
    // The content type is the server's own claim about what it sent. Parsing a
    // `text/plain` body as JSON because it happens to start with `{` is how a
    // proxy's debug page becomes a successful API call.
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200)
            .set_body_raw(br#"{"service":"prick","version":"2026.815.0"}"#.to_vec(), "text/plain"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("the content type disagrees");
    assert_eq!(err.kind(), ErrorKind::NotPrick);
    assert!(err.to_string().contains("text/plain"), "{err}");
}

#[tokio::test]
async fn a_slow_response_hits_the_deadline_rather_than_hanging() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200)
            .set_delay(Duration::from_secs(3))
            .set_body_raw(br#"{"service":"prick","version":"1"}"#.to_vec(), "application/json"),
    )
    .await;

    let config = Config::new(server.uri())
        .with_timeout(Duration::from_millis(150))
        .with_retries(0, Duration::ZERO);
    let client = Client::new(config, Credential::Anonymous).expect("building a client");

    let err = client.health().await.expect_err("the deadline must be enforced");
    assert_eq!(err.kind(), ErrorKind::Timeout);
    assert_eq!(err.exit_code(), 7);
    assert!(err.hint().is_some_and(|hint| hint.contains("--timeout")));
}

#[tokio::test]
async fn nothing_listening_is_reported_as_unreachable_not_as_a_parse_failure() {
    // A name that cannot resolve, rather than a port that is not listening.
    // `.invalid` is reserved by RFC 6761 precisely so that it never resolves,
    // and a DNS failure is reported identically everywhere -- whereas a refused
    // connection to a closed port is refused instantly on Linux and silently
    // dropped by the host firewall on Windows, where it surfaces as a timeout.
    let config = Config::new("http://prick-does-not-exist.invalid")
        .with_timeout(Duration::from_secs(10))
        .with_retries(0, Duration::ZERO);
    let client = Client::new(config, Credential::Anonymous).expect("building a client");

    let err = client.health().await.expect_err("nothing is listening");
    assert_eq!(err.kind(), ErrorKind::Unreachable);
    assert!(err.hint().is_some_and(|hint| hint.contains("prk doctor")));
}

#[tokio::test]
async fn a_server_error_envelope_keeps_the_servers_own_code_and_message() {
    // The envelope is FLAT. `{"error":{…}}` is not a shape this API produces,
    // and a client expecting one falls back to "the server returned HTTP 409",
    // discarding the only part of the response worth reading.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects"))
        .respond_with(
            ResponseTemplate::new(409).set_body_raw(
                br#"{"code":"LAST_ADMIN","message":"cannot remove the last administrator",
                 "request_id":"0199a0c0-0000-7000-8000-00000000000a",
                 "hint":"Set BOOTSTRAP_ADMINS and redeploy."}"#
                    .to_vec(),
                "application/json",
            ),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err: ApiError = client
        .get_json::<serde_json::Value>(&client.url(&["projects"]))
        .await
        .expect_err("409 is a failure");

    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert!(err.to_string().contains("LAST_ADMIN"), "{err}");
    assert!(err.to_string().contains("last administrator"), "{err}");
    assert_eq!(err.server_hint(), Some("Set BOOTSTRAP_ADMINS and redeploy."));
}

#[tokio::test]
async fn a_validation_failure_names_the_field_the_server_rejected() {
    // The shape `http/validate.ts` produces: a flat body whose `issues` carry
    // `{path, message}` and never the rejected input.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects"))
        .respond_with(ResponseTemplate::new(422).set_body_raw(
            br#"{"code":"VALIDATION_FAILED","message":"The request body is not valid.",
                 "request_id":"0199a0c0-0000-7000-8000-00000000000b",
                 "issues":[{"path":"slug","message":"must be lowercase alphanumeric with single interior hyphens"}]}"#
                .to_vec(),
            "application/json",
        ))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = client
        .post_json::<serde_json::Value>(
            &client.url(&["projects"]),
            &serde_json::json!({ "slug": "Not A Slug", "name": "x" }),
        )
        .await
        .expect_err("422 is a failure");

    assert_eq!(err.kind(), ErrorKind::Validation);
    assert_eq!(err.exit_code(), 11);
    assert!(err.to_string().contains("slug"), "the rejected field must be named: {err}");
    assert!(err.to_string().contains("lowercase alphanumeric"), "{err}");
    // The rejected value is not echoed, because the server never sends it.
    assert!(!err.to_string().contains("Not A Slug"), "{err}");
}

#[tokio::test]
async fn an_unknown_api_path_answers_401_and_is_reported_as_such() {
    // Authentication is mounted ahead of routing, so a typo in a route is a
    // 401 rather than a 404. Reporting it as "not found" would send an
    // operator looking for a missing project.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/access/identities"))
        .respond_with(
            ResponseTemplate::new(401).set_body_raw(
                br#"{"code":"UNAUTHENTICATED","message":"No Access assertion was presented."}"#
                    .to_vec(),
                "application/json",
            ),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = client
        .get_json::<serde_json::Value>(&client.url(&["access", "identities"]))
        .await
        .expect_err("401 is a failure");

    assert_eq!(err.kind(), ErrorKind::Unauthenticated);
    assert_eq!(err.exit_code(), 3);
}

#[tokio::test]
async fn a_request_id_is_sent_and_the_servers_own_one_is_preferred_on_the_way_back() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(500)
            .insert_header("x-request-id", "01J8Z3K9X0000000000000000")
            .set_body_raw(b"<html><title>oops</title></html>".to_vec(), "text/html"),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("500 is a failure");
    assert_eq!(err.request_id(), Some("01J8Z3K9X0000000000000000"));

    let sent = &server.received_requests().await.expect("requests were recorded")[0];
    assert!(sent.headers.contains_key("x-request-id"), "no request id was sent");
}

#[tokio::test]
async fn a_service_token_is_sent_as_the_header_pair_cloudflared_uses() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(200)
            .set_body_raw(br#"{"service":"prick","version":"1"}"#.to_vec(), "application/json"),
    )
    .await;

    let config = Config::new(server.uri()).with_retries(0, Duration::ZERO);
    let client = Client::new(
        config,
        Credential::ServiceToken {
            client_id: "abc.access".to_owned(),
            client_secret: secrecy::SecretString::from("shh"),
        },
    )
    .expect("building a client");

    client.health().await.expect("a healthy server");

    let sent = &server.received_requests().await.expect("requests were recorded")[0];
    assert_eq!(sent.headers["cf-access-client-id"], "abc.access");
    assert_eq!(sent.headers["cf-access-client-secret"], "shh");
    assert!(!sent.headers.contains_key("authorization"), "both credential kinds were sent");
}

#[tokio::test]
async fn a_retryable_failure_is_retried_and_a_permanent_one_is_not() {
    let server = MockServer::start().await;

    // wiremock matches mocks in the order they were mounted, so the limited
    // 503 answers first and the 200 takes over once its budget is spent.
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(ResponseTemplate::new(503).set_body_raw(
            br#"{"code":"NOT_READY","message":"starting"}"#.to_vec(),
            "application/json",
        ))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(HEALTH))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            br#"{"service":"prick","version":"2026.815.0"}"#.to_vec(),
            "application/json",
        ))
        .mount(&server)
        .await;

    let config = Config::new(server.uri()).with_retries(2, Duration::from_millis(1));
    let client = Client::new(config, Credential::Anonymous).expect("building a client");

    let health = client.health().await.expect("the retry must succeed");
    assert_eq!(health.version, "2026.815.0");
    assert_eq!(server.received_requests().await.expect("recorded").len(), 2);
}

#[tokio::test]
async fn a_permanent_failure_is_not_retried() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(403).set_body_raw(
            br#"{"code":"FORBIDDEN","message":"no grant"}"#.to_vec(),
            "application/json",
        ),
    )
    .await;

    let config = Config::new(server.uri()).with_retries(3, Duration::from_millis(1));
    let client = Client::new(config, Credential::Anonymous).expect("building a client");

    let err = client.health().await.expect_err("403 is a failure");
    assert_eq!(err.kind(), ErrorKind::Forbidden);
    assert_eq!(
        server.received_requests().await.expect("recorded").len(),
        1,
        "an authorization failure was retried, which cannot help and wastes the deadline"
    );
}

#[tokio::test]
async fn the_facts_of_a_failure_survive_onto_the_error() {
    let server = MockServer::start().await;
    mount(
        &server,
        HEALTH,
        ResponseTemplate::new(530).insert_header("cf-ray", "8f0c0e0a0b0c0d0e-LHR").set_body_raw(
            cloudflare_error_page(1016, "Origin DNS error").into_bytes(),
            "text/html",
        ),
    )
    .await;

    let err = client_for(&server).health().await.expect_err("530 is a failure");
    let facts: &ResponseFacts = err.facts().expect("a classified response carries its facts");

    assert_eq!(facts.status, 530);
    assert_eq!(facts.cf_ray.as_deref(), Some("8f0c0e0a0b0c0d0e-LHR"));
    assert!(facts.from_cloudflare());
    assert_eq!(facts.cloudflare_error_code(), Some(1016));
}
