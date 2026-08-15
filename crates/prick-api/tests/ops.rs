//! Every route, against a real HTTP server, in the shapes the API actually
//! uses.
//!
//! # What these assert, and why it is not the same as "it compiles"
//!
//! Each test mounts **one** mock with an exact method and an exact path. A call
//! that goes anywhere else gets wiremock's unmatched-request `404` and fails
//! here rather than in production -- so the path and the verb are asserted, not
//! merely exercised.
//!
//! The response bodies are copied from `docs/openapi.json` and from the zod
//! schemas the handlers return, not from what this client would find
//! convenient. A test that asserts a shape the client invented proves only that
//! the client agrees with itself.
//!
//! The request bodies are read back off the mock server and compared field by
//! field, because the request schemas in `@prick/shared` are `.strict()`: a
//! misspelt field is a 422, and a misspelt `expected_rev` is worse than that --
//! it is a write with no concurrency guard at all.

use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};

use prick_api::models::SecretExport;
use prick_api::ops;
use prick_api::{BatchRequest, Client, Config, Credential, ImportFormat, ImportRequest};
use prick_core::classify::ErrorKind;
use prick_core::scope::Scope;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// A client pointed at a mock server, with retries off so a mocked failure is
/// observed rather than smoothed over.
fn client_for(server: &MockServer) -> Client {
    let config = Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        .with_retries(0, Duration::ZERO);
    Client::new(config, Credential::Anonymous).expect("building a client must succeed")
}

/// A JSON response, in the content type the API sends.
fn json(status: u16, body: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(body.as_bytes().to_vec(), "application/json")
}

/// The single request the mock server received, parsed as JSON.
async fn sent_body(server: &MockServer) -> serde_json::Value {
    let requests = server.received_requests().await.expect("requests were recorded");
    assert_eq!(requests.len(), 1, "exactly one request was expected");
    serde_json::from_slice(&requests[0].body).expect("the request body is JSON")
}

/// The single request the mock server received.
async fn sent(server: &MockServer) -> Request {
    let requests = server.received_requests().await.expect("requests were recorded");
    assert_eq!(requests.len(), 1, "exactly one request was expected");
    requests[0].clone()
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

#[tokio::test]
async fn whoami_reads_the_identity_the_server_resolved() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/whoami"))
        .respond_with(json(
            200,
            r#"{"kind":"user","subject":"ada@example.com",
                "identityId":"0199a0c0-0000-7000-8000-000000000001","role":"admin",
                "bootstrap":false}"#,
        ))
        .mount(&server)
        .await;

    let whoami = ops::whoami(&client_for(&server)).await.expect("whoami answers");
    assert_eq!(whoami.subject, "ada@example.com");
    assert_eq!(whoami.role.as_deref(), Some("admin"));
    assert!(!whoami.bootstrap);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn projects_are_listed_from_the_collection_route() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects"))
        .respond_with(json(
            200,
            r#"[{"id":"0199a0c0-0000-7000-8000-000000000002","slug":"billing","name":"Billing",
                 "description":null,"environmentCount":2,"updatedAt":1760000000000}]"#,
        ))
        .mount(&server)
        .await;

    let projects = ops::list_projects(&client_for(&server)).await.expect("a listing");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].slug, "billing");
    assert_eq!(projects[0].environment_count, 2);
}

#[tokio::test]
async fn creating_a_project_sends_the_slug_the_server_requires() {
    // `POST /projects` requires `slug`; a body of `{name}` alone is a 422.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects"))
        .respond_with(json(
            201,
            r#"{"id":"0199a0c0-0000-7000-8000-000000000002","slug":"billing","name":"Billing",
                "description":null,"environmentCount":0,"updatedAt":1760000000000}"#,
        ))
        .mount(&server)
        .await;

    let project = ops::create_project(&client_for(&server), "billing", "Billing", None)
        .await
        .expect("a created project");
    assert_eq!(project.slug, "billing");

    let body = sent_body(&server).await;
    assert_eq!(body["slug"], "billing");
    assert_eq!(body["name"], "Billing");
    assert!(body.get("description").is_none(), "an absent description is omitted, not null");
}

#[tokio::test]
async fn renaming_a_project_patches_the_name_only() {
    let server = MockServer::start().await;
    Mock::given(method("PATCH"))
        .and(path("/api/v1/projects/billing"))
        .respond_with(json(
            200,
            r#"{"id":"0199a0c0-0000-7000-8000-000000000002","slug":"billing","name":"Billing EU",
                "description":null,"environmentCount":2,"updatedAt":1760000000001}"#,
        ))
        .mount(&server)
        .await;

    let project = ops::update_project(&client_for(&server), "billing", Some("Billing EU"), None)
        .await
        .expect("a renamed project");
    assert_eq!(project.name, "Billing EU");

    let body = sent_body(&server).await;
    assert_eq!(body["name"], "Billing EU");
    // The slug is how everyone else addresses this project; renaming must not
    // silently repoint it.
    assert!(body.get("slug").is_none());
}

#[tokio::test]
async fn deleting_a_project_accepts_an_empty_204() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/projects/billing"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    ops::delete_project(&client_for(&server), "billing").await.expect("204 is success");
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

#[tokio::test]
async fn environments_are_listed_with_a_slug_and_a_camel_case_project_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments"))
        .respond_with(json(
            200,
            r#"[{"id":"0199a0c0-0000-7000-8000-000000000003",
                 "projectId":"0199a0c0-0000-7000-8000-000000000002","slug":"eu-west",
                 "name":"EU West","description":null,"rev":4,"secretCount":11,
                 "updatedAt":1760000000000}]"#,
        ))
        .mount(&server)
        .await;

    let environments =
        ops::list_environments(&client_for(&server), "billing").await.expect("a listing");
    assert_eq!(environments[0].slug, "eu-west");
    assert_eq!(environments[0].project_id, "0199a0c0-0000-7000-8000-000000000002");
    assert_eq!(environments[0].rev, 4);
}

#[tokio::test]
async fn creating_an_environment_sends_both_a_slug_and_a_name() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments"))
        .respond_with(json(
            201,
            r#"{"id":"0199a0c0-0000-7000-8000-000000000003",
                "projectId":"0199a0c0-0000-7000-8000-000000000002","slug":"eu-west",
                "name":"EU West","description":null,"rev":0,"secretCount":0,
                "updatedAt":1760000000000}"#,
        ))
        .mount(&server)
        .await;

    let environment =
        ops::create_environment(&client_for(&server), "billing", "eu-west", "EU West", None)
            .await
            .expect("a created environment");
    assert_eq!(environment.slug, "eu-west");

    let body = sent_body(&server).await;
    assert_eq!(body["slug"], "eu-west");
    assert_eq!(body["name"], "EU West");
}

#[tokio::test]
async fn one_environment_is_fetched_for_its_revision() {
    // `rev` is the optimistic-concurrency token, and the same number the secret
    // collection returns as its ETag.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments/eu-west"))
        .respond_with(json(
            200,
            r#"{"id":"0199a0c0-0000-7000-8000-000000000003",
                "projectId":"0199a0c0-0000-7000-8000-000000000002","slug":"eu-west",
                "name":"EU West","description":null,"rev":4,"secretCount":11,
                "updatedAt":1760000000000}"#,
        ))
        .mount(&server)
        .await;

    let environment = ops::get_environment(&client_for(&server), "billing", "eu-west")
        .await
        .expect("an environment");
    assert_eq!(environment.rev, 4);
}

#[tokio::test]
async fn an_environment_is_deleted_by_slug() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/projects/billing/environments/eu-west"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    ops::delete_environment(&client_for(&server), "billing", "eu-west")
        .await
        .expect("204 is success");
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_secret_listing_carries_metadata_and_never_a_value() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets"))
        .respond_with(
            json(
                200,
                r#"[{"key":"DATABASE_URL","description":null,"version":3,
                     "updatedAt":1760000000000,"updatedBy":"ada@example.com","kid":"k1",
                     "unreadable":false},
                    {"key":"BROKEN","description":null,"version":1,
                     "updatedAt":1760000000000,"updatedBy":"ada@example.com","kid":"k0",
                     "unreadable":true}]"#,
            )
            .insert_header("etag", "\"4\""),
        )
        .mount(&server)
        .await;

    let secrets =
        ops::list_secrets(&client_for(&server), "billing", "eu-west").await.expect("a listing");
    assert_eq!(secrets.len(), 2);
    assert_eq!(secrets[0].updated_by, "ada@example.com");
    assert!(secrets[1].unreadable, "an unreadable row comes back marked, never omitted");
}

#[tokio::test]
async fn revealing_one_secret_sends_a_reason_and_reads_a_key_and_value() {
    // The response has NO version field, and the request carries the audit
    // reason that makes the log answer "did anyone take this".
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets/DATABASE_URL"))
        .and(query_param("reason", "copy"))
        .respond_with(json(200, r#"{"key":"DATABASE_URL","value":"postgres://u:p@h/db"}"#))
        .mount(&server)
        .await;

    let secret = ops::reveal_secret(
        &client_for(&server),
        "billing",
        "eu-west",
        "DATABASE_URL",
        prick_api::RevealReason::Copy,
    )
    .await
    .expect("a revealed secret");

    assert_eq!(secret.key, "DATABASE_URL");
    assert_eq!(secret.value.expose_secret(), "postgres://u:p@h/db");
}

#[tokio::test]
async fn an_export_is_a_flat_map_of_key_to_value() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:export"))
        .respond_with(json(
            200,
            r#"{"DATABASE_URL":"postgres://u:p@h/db","REDIS_URL":"redis://h"}"#,
        ))
        .mount(&server)
        .await;

    let export: SecretExport =
        ops::export_secrets(&client_for(&server), "billing", "eu-west").await.expect("an export");

    assert_eq!(export.len(), 2);
    assert_eq!(export.keys().collect::<Vec<_>>(), ["DATABASE_URL", "REDIS_URL"]);
}

#[tokio::test]
async fn setting_one_secret_goes_through_batch_rather_than_a_put_on_the_key() {
    // There is no `PUT …/secrets/{key}`. A single-key write is a one-entry
    // `set` in the batch, which is one D1 transaction with its audit row in it.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:batch"))
        .respond_with(json(200, r#"{"rev":5,"added":["DATABASE_URL"],"changed":[],"removed":[]}"#))
        .mount(&server)
        .await;

    let value = SecretString::from("postgres://u:p@h/db");
    let result = ops::write_secrets(
        &client_for(&server),
        "billing",
        "eu-west",
        &BatchRequest { set: vec![("DATABASE_URL", &value)], ..BatchRequest::default() },
    )
    .await
    .expect("a write");

    assert_eq!(result.rev, 5);
    assert_eq!(result.added, ["DATABASE_URL"]);

    let request = sent(&server).await;
    assert_eq!(request.method.as_str(), "POST");
    let body: serde_json::Value =
        serde_json::from_slice(&request.body).expect("the request body is JSON");
    assert_eq!(body["mode"], "merge");
    assert_eq!(body["set"]["DATABASE_URL"], "postgres://u:p@h/db");
}

#[tokio::test]
async fn deleting_one_secret_goes_through_batch_too() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:batch"))
        .respond_with(json(200, r#"{"rev":6,"added":[],"changed":[],"removed":["OLD_KEY"]}"#))
        .mount(&server)
        .await;

    let result = ops::write_secrets(
        &client_for(&server),
        "billing",
        "eu-west",
        &BatchRequest { delete: vec!["OLD_KEY"], ..BatchRequest::default() },
    )
    .await
    .expect("a write");

    assert_eq!(result.removed, ["OLD_KEY"]);
    assert_eq!(sent_body(&server).await["delete"], serde_json::json!(["OLD_KEY"]));
}

#[tokio::test]
async fn an_import_posts_the_blob_and_reads_back_a_diff() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:import"))
        .respond_with(json(
            200,
            r#"{"added":["A"],"changed":["B"],"removed":["C"],"applied":false,
                "warnings":[{"line":3,"key":"D","message":"duplicate key"}]}"#,
        ))
        .mount(&server)
        .await;

    let result = ops::import_secrets(
        &client_for(&server),
        "billing",
        "eu-west",
        &ImportRequest {
            format: ImportFormat::Env,
            content: "A=1\nB=2\n",
            mode: prick_api::WriteMode::Replace,
            dry_run: true,
            expected_rev: Some(4),
            reason: None,
        },
    )
    .await
    .expect("an import");

    assert!(!result.applied, "a dry run writes nothing");
    assert_eq!(result.warnings[0].line, 3);

    let body = sent_body(&server).await;
    assert_eq!(body["format"], "env");
    assert_eq!(body["content"], "A=1\nB=2\n");
    assert_eq!(body["mode"], "replace");
    assert_eq!(body["dry_run"], true);
    assert_eq!(body["expected_rev"], 4);
    // Not a parsed array: the server owns the parser, so the CLI cannot reject
    // a file the server would accept.
    assert!(body.get("secrets").is_none());
}

#[tokio::test]
async fn a_rollback_is_collection_level_with_the_key_in_the_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:rollback"))
        .respond_with(json(200, r#"{"rev":7,"version":9}"#))
        .mount(&server)
        .await;

    let result =
        ops::rollback_secret(&client_for(&server), "billing", "eu-west", "DATABASE_URL", 3, None)
            .await
            .expect("a rollback");

    assert_eq!(result.rev, 7);
    assert_eq!(result.version, 9, "a rollback writes a new version rather than resurrecting one");

    let body = sent_body(&server).await;
    assert_eq!(body["key"], "DATABASE_URL");
    // `to_version`, not `to`.
    assert_eq!(body["to_version"], 3);
    assert!(body.get("to").is_none());
}

#[tokio::test]
async fn a_version_history_includes_tombstones() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets/DATABASE_URL/versions"))
        .respond_with(json(
            200,
            r#"[{"version":2,"op":"delete","createdAt":1760000000001,"createdBy":"ada@example.com",
                 "kid":null,"deleted":true},
                {"version":1,"op":"set","createdAt":1760000000000,"createdBy":"ada@example.com",
                 "kid":"k1","deleted":false}]"#,
        ))
        .mount(&server)
        .await;

    let versions = ops::secret_versions(&client_for(&server), "billing", "eu-west", "DATABASE_URL")
        .await
        .expect("a history");

    assert_eq!(versions.len(), 2);
    assert!(versions[0].deleted, "a tombstone occupies its version number");
    assert_eq!(versions[1].op, "set");
}

#[tokio::test]
async fn a_precondition_refusal_carries_the_servers_own_hint() {
    // `:rollback` refuses an If-Match rather than ignoring it, and the hint
    // names the route that does evaluate one. That text is the whole answer, so
    // it must survive onto the error.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/projects/billing/environments/eu-west/secrets:rollback"))
        .respond_with(
            json(
                400,
                r#"{"code":"BAD_REQUEST","message":"This operation does not support a revision precondition.",
                    "request_id":"0199a0c0-0000-7000-8000-00000000000c",
                    "hint":"Only `secrets:batch` and `secrets:import` evaluate If-Match."}"#,
            )
            // Set by middleware on every response, and the value an operator
            // quotes to find the audit row.
            .insert_header("x-request-id", "0199a0c0-0000-7000-8000-00000000000c"),
        )
        .mount(&server)
        .await;

    let err =
        ops::rollback_secret(&client_for(&server), "billing", "eu-west", "DATABASE_URL", 3, None)
            .await
            .expect_err("400 is a failure");

    assert_eq!(err.kind(), ErrorKind::Validation);
    assert!(err.server_hint().is_some_and(|hint| hint.contains("secrets:batch")), "{err}");
    assert_eq!(err.request_id(), Some("0199a0c0-0000-7000-8000-00000000000c"));
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

#[tokio::test]
async fn identities_are_listed_from_the_top_level_route() {
    // `/identities`, not `/access/identities`. The wrong one answers 401,
    // because authentication is mounted ahead of routing.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/identities"))
        .respond_with(json(
            200,
            r#"[{"id":"0199a0c0-0000-7000-8000-000000000005","kind":"service",
                 "subject":"abc.access","displayName":null,"disabled":false,
                 "lastSeenAt":1760000000000}]"#,
        ))
        .mount(&server)
        .await;

    let identities = ops::list_identities(&client_for(&server)).await.expect("a listing");
    assert_eq!(identities[0].subject, "abc.access");
}

#[tokio::test]
async fn denied_subjects_come_from_the_one_route_under_access() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/access/unknown-identities"))
        .respond_with(json(
            200,
            r#"[{"kind":"service","subject":"abc.access","firstSeenAt":1760000000000,
                 "lastSeenAt":1760000000900,"attempts":4}]"#,
        ))
        .mount(&server)
        .await;

    let denied = ops::list_unknown_identities(&client_for(&server)).await.expect("a listing");
    assert_eq!(denied[0].attempts, 4);
}

#[tokio::test]
async fn grants_are_listed_with_their_scope_spelled_out() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/grants"))
        .respond_with(json(
            200,
            r#"[{"id":"0199a0c0-0000-7000-8000-000000000006",
                 "identityId":"0199a0c0-0000-7000-8000-000000000005","subject":"abc.access",
                 "role":"reader","scopeType":"environment","projectSlug":"billing",
                 "environmentSlug":"eu-west","expiresAt":null}]"#,
        ))
        .mount(&server)
        .await;

    let grants = ops::list_grants(&client_for(&server)).await.expect("a listing");
    assert_eq!(grants[0].scope(), "billing:eu-west");
    assert_eq!(grants[0].identity_id, "0199a0c0-0000-7000-8000-000000000005");
}

#[tokio::test]
async fn a_grant_is_created_against_an_identity_id_with_a_discriminated_scope() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/grants"))
        .respond_with(json(
            201,
            r#"{"id":"0199a0c0-0000-7000-8000-000000000006",
                "identityId":"0199a0c0-0000-7000-8000-000000000005","subject":"abc.access",
                "role":"writer","scopeType":"project","projectSlug":"billing",
                "environmentSlug":null,"expiresAt":1760000000000}"#,
        ))
        .mount(&server)
        .await;

    let scope: Scope = "billing:*".parse().expect("a project scope");
    let grant = ops::create_grant(
        &client_for(&server),
        "0199a0c0-0000-7000-8000-000000000005",
        "writer",
        prick_api::GrantScope::from_scope(&scope).expect("a grantable scope"),
        Some(1_760_000_000_000),
    )
    .await
    .expect("a created grant");

    assert_eq!(grant.scope(), "billing:*");

    let body = sent_body(&server).await;
    assert_eq!(body["scope_type"], "project");
    assert_eq!(body["project"], "billing");
    assert_eq!(body["identity_id"], "0199a0c0-0000-7000-8000-000000000005");
    assert_eq!(body["role"], "writer");
    assert_eq!(body["expires_at"], 1_760_000_000_000_i64);
    // Neither of these exists on any grant schema.
    assert!(body.get("subject").is_none());
    assert!(body.get("scope").is_none());
}

#[tokio::test]
async fn a_grant_is_revoked_by_its_own_uuid() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/grants/0199a0c0-0000-7000-8000-000000000006"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    ops::revoke_grant(&client_for(&server), "0199a0c0-0000-7000-8000-000000000006")
        .await
        .expect("204 is success");
}

#[tokio::test]
async fn revoking_the_last_administrator_is_refused_with_the_servers_reason() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/v1/grants/0199a0c0-0000-7000-8000-000000000006"))
        .respond_with(json(
            409,
            r#"{"code":"LAST_ADMIN","message":"This is the last usable global administrator.",
                "hint":"Set BOOTSTRAP_ADMINS and redeploy, or grant another global admin first."}"#,
        ))
        .mount(&server)
        .await;

    let err = ops::revoke_grant(&client_for(&server), "0199a0c0-0000-7000-8000-000000000006")
        .await
        .expect_err("409 is a failure");

    assert_eq!(err.kind(), ErrorKind::Conflict);
    assert!(err.to_string().contains("LAST_ADMIN"), "{err}");
    assert!(err.server_hint().is_some_and(|hint| hint.contains("BOOTSTRAP_ADMINS")));
}
