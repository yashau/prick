//! Proof that this client only calls routes the API actually serves.
//!
//! # Recorded, not declared
//!
//! The obvious shape for this test is a table of `(method, path)` pairs checked
//! against the spec. That table would be a second description of the HTTP
//! surface, written by hand, free to drift from [`prick_api::ops`] with nothing
//! noticing -- which is the failure this file exists to prevent, not a way to
//! prevent it.
//!
//! So nothing here declares a route. Every `pub async fn` in `ops` is called
//! against a wiremock server that answers everything, the requests that arrive
//! are read back off it, and *those* are compared with `docs/openapi.json`. The
//! only way into this test's input is to be a call the code really makes.
//!
//! `docs/openapi.json` is generated from the Hono router and `mise run
//! openapi:check` fails if it is stale, so it is the server's own account of
//! itself rather than a second hand-written one.
//!
//! The [`Result`] of every call is discarded on purpose. These responses are a
//! single `{}` and most of them fail to deserialise; the request went out
//! before that mattered, and the request is the entire subject of this file.
//!
//! # Normalisation
//!
//! Parameter *names* are not part of the contract: the spec writes `{env}`
//! where the client sends a slug, and the client is not wrong for disagreeing
//! about the word. Both sides are reduced to `{}` -- the spec by emptying its
//! braces, the client by replacing whole path segments that equal a sentinel --
//! before they are compared. A method and a shape of path is the assertion.
//!
//! # Sentinels
//!
//! The values standing in for a project, an environment, a key and a uuid are
//! chosen to satisfy the grammars the API validates against -- slugs are
//! `^[a-z0-9]+(?:-[a-z0-9]+)*$`, keys are POSIX environment variable names, ids
//! are UUIDv7 -- so a body carrying them is a body the server would accept. The
//! `zz` prefix is what makes substitution safe: no literal segment of any route
//! begins with it, so replacing a sentinel cannot corrupt a real path segment.
//! Substitution matches whole segments rather than substrings, so it could not
//! anyway.
//!
//! # What is asserted and what is only reported
//!
//! A route the spec does not serve is a failure. A route the spec serves and
//! the CLI does not call is printed: `/audit`, `/admin/*` and `/groups/**` are
//! deliberately unwired, and asserting on that list would turn "the API grew a
//! route" into "the CLI is broken". The list is written straight to the process
//! stderr handle -- `print_stderr` is denied workspace-wide and a test does not
//! get an exception, the same reasoning as `prick-exec`'s child fixture. Under
//! `cargo nextest` a passing test's output is captured; `--success-output
//! immediate` shows it.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use secrecy::SecretString;
use serde_json::Value;

use prick_api::ops;
use prick_api::{
    BatchRequest, Client, Config, Credential, GrantScope, ImportFormat, ImportRequest,
    RevealReason, WriteMode,
};
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A project slug. Matches the slug grammar; no route has a literal segment
/// that could collide with it.
const PROJECT: &str = "zzproject";
/// An environment slug.
const ENVIRONMENT: &str = "zzenvironment";
/// A secret key. A valid POSIX environment variable name, and not one of the
/// loader-controlling names `prick_core::keyname` refuses.
const KEY: &str = "ZZKEY";
/// A second key, so a batch can both set and delete without naming one key
/// twice. Body-only; it never reaches a path.
const OTHER_KEY: &str = "ZZOLDKEY";
/// An identity or grant id. A syntactically valid UUIDv7.
const UUID: &str = "00000000-0000-7000-8000-000000000000";

/// The sentinels that can appear as a whole path segment.
const PATH_SENTINELS: [&str; 3] = [PROJECT, ENVIRONMENT, KEY];

/// The number of `pub async fn` in `ops` when this test was last reviewed.
///
/// The set comparison in
/// [`every_op_the_module_declares_is_exercised_by_this_test`] is the real
/// guard and it names the op that is missing. This number is here so that
/// growing the API surface cannot be done without someone reading this file:
/// when it fails, add the call, then bump it.
const OPS_AT_LAST_REVIEW: usize = 22;

/// The module under test, read at compile time so the list of ops comes from
/// the code rather than from anybody's memory of it.
const OPS_SOURCE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/ops.rs"));

/// The methods a path item can carry. Anything else in there (`parameters`,
/// `summary`) is not an operation.
const METHODS: [&str; 7] = ["get", "put", "post", "delete", "options", "head", "patch"];

/// One request an op was observed to make.
#[derive(Debug, Clone)]
struct Observed {
    /// The `ops` function that made it.
    op: &'static str,
    /// The HTTP method, upper case.
    method: String,
    /// The path with sentinels replaced by `{}`.
    path: String,
    /// The path as it went out, for a failure message that names something a
    /// reader can search the source for.
    raw_path: String,
    /// The request body, when there was one and it parsed as JSON.
    body: Option<Value>,
}

/// One operation the spec declares.
#[derive(Debug, Clone, Copy)]
struct SpecRoute<'a> {
    /// The path as the spec writes it, parameter names intact.
    template: &'a str,
    /// The OpenAPI operation object.
    operation: &'a Value,
}

// ---------------------------------------------------------------------------
// Driving every op
// ---------------------------------------------------------------------------

/// Calls every op against a server that answers everything, and reports what
/// went out.
async fn observe() -> Vec<Observed> {
    let server = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"{}".to_vec(), "application/json"))
        .mount(&server)
        .await;

    let config = Config::new(server.uri())
        .with_timeout(Duration::from_secs(5))
        // Off, so one call is one request and the two lists below line up.
        .with_retries(0, Duration::ZERO);
    let client =
        Client::new(config, Credential::Anonymous).expect("building a client must succeed");

    let called = call_every_op(&client).await;

    let requests = server.received_requests().await.expect("requests were recorded");
    assert_eq!(
        requests.len(),
        called.len(),
        "one op is one request; retries are off, so a mismatch means an op sent something extra"
    );

    requests
        .iter()
        .zip(called)
        .map(|(request, op)| {
            let raw_path = request.url.path().to_owned();
            Observed {
                op,
                method: request.method.as_str().to_ascii_uppercase(),
                path: normalise_observed(&raw_path),
                raw_path,
                body: (!request.body.is_empty())
                    .then(|| serde_json::from_slice(&request.body).expect("a JSON request body")),
            }
        })
        .collect()
}

/// Every `pub async fn` in `ops`, called once, in the order it is declared.
///
/// The name recorded for a call is `stringify!` of the function that was
/// called, so the label on a failure cannot disagree with what ran.
async fn call_every_op(client: &Client) -> Vec<&'static str> {
    /// Calls one op and records its name.
    macro_rules! exercise {
        ($called:ident, $op:ident($($argument:expr),* $(,)?)) => {{
            let _ = ops::$op($($argument),*).await;
            $called.push(stringify!($op));
        }};
    }

    let mut called: Vec<&'static str> = Vec::new();
    let value = SecretString::from("zz-value");
    let batch = BatchRequest {
        mode: WriteMode::Replace,
        set: vec![(KEY, &value)],
        delete: vec![OTHER_KEY],
        expected_rev: Some(1),
        reason: Some("contract test"),
    };
    let import = ImportRequest {
        format: ImportFormat::Env,
        content: "ZZKEY=zz-value\n",
        mode: WriteMode::Merge,
        dry_run: true,
        expected_rev: Some(1),
        reason: Some("contract test"),
    };
    let scope = GrantScope::Environment { project: PROJECT, environment: ENVIRONMENT };

    exercise!(called, health(client));
    exercise!(called, whoami(client));

    exercise!(called, list_projects(client));
    exercise!(called, create_project(client, PROJECT, "Zz", Some("contract test")));
    exercise!(called, update_project(client, PROJECT, Some("Zz"), Some("contract test")));
    exercise!(called, delete_project(client, PROJECT));

    exercise!(called, list_environments(client, PROJECT));
    exercise!(called, get_environment(client, PROJECT, ENVIRONMENT));
    exercise!(
        called,
        create_environment(client, PROJECT, ENVIRONMENT, "Zz", Some("contract test"))
    );
    exercise!(called, delete_environment(client, PROJECT, ENVIRONMENT));

    exercise!(called, list_secrets(client, PROJECT, ENVIRONMENT));
    exercise!(called, reveal_secret(client, PROJECT, ENVIRONMENT, KEY, RevealReason::Run));
    exercise!(called, export_secrets(client, PROJECT, ENVIRONMENT));
    exercise!(called, secret_versions(client, PROJECT, ENVIRONMENT, KEY));
    exercise!(called, write_secrets(client, PROJECT, ENVIRONMENT, &batch));
    exercise!(called, import_secrets(client, PROJECT, ENVIRONMENT, &import));
    exercise!(called, rollback_secret(client, PROJECT, ENVIRONMENT, KEY, 1, Some("contract test")));

    exercise!(called, list_identities(client));
    exercise!(called, list_unknown_identities(client));
    exercise!(called, list_grants(client));
    exercise!(called, create_grant(client, UUID, "reader", scope, Some(1_760_000_000_000)));
    exercise!(called, revoke_grant(client, UUID));

    called
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

/// `docs/openapi.json`, read from the repository rather than from a copy.
fn spec() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/openapi.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("{} must be readable: {err}", path.display()))
        .expect("the generated spec is what this test compares against");
    serde_json::from_str(&text).expect("docs/openapi.json is JSON")
}

/// Every operation the spec declares, keyed by method and normalised path.
fn spec_routes(spec: &Value) -> BTreeMap<(String, String), SpecRoute<'_>> {
    let paths = spec.get("paths").and_then(Value::as_object).expect("the spec has paths");

    let mut routes = BTreeMap::new();
    for (template, item) in paths {
        let normalised = normalise_template(template);
        for method in METHODS {
            let Some(operation) = item.get(method) else { continue };
            let key = (method.to_ascii_uppercase(), normalised.clone());
            let route = SpecRoute { template, operation };
            assert!(
                routes.insert(key, route).is_none(),
                "two spec paths normalise to `{normalised}`, so this comparison would be \
                 ambiguous"
            );
        }
    }
    routes
}

/// Empties every `{parameter}` in a spec path, leaving `{}`.
fn normalise_template(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut inside = false;
    for character in path.chars() {
        match character {
            '{' => {
                inside = true;
                out.push('{');
            }
            '}' => {
                inside = false;
                out.push('}');
            }
            _ if inside => {}
            _ => out.push(character),
        }
    }
    out
}

/// Replaces whole path segments that are a sentinel with `{}`.
///
/// A uuid is matched by shape rather than by value so that a second id-bearing
/// route cannot be smuggled past this by using a different sentinel.
fn normalise_observed(path: &str) -> String {
    path.split('/')
        .map(
            |segment| {
                if PATH_SENTINELS.contains(&segment) || is_uuid(segment) { "{}" } else { segment }
            },
        )
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether a segment has the shape `8-4-4-4-12` hex.
fn is_uuid(segment: &str) -> bool {
    let groups: Vec<&str> = segment.split('-').collect();
    groups.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&groups).all(|(len, group)| group.len() == *len)
        && groups.iter().all(|group| group.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Every `pub async fn` declared at the top level of `ops`.
fn declared_ops() -> BTreeSet<&'static str> {
    OPS_SOURCE
        .lines()
        .filter_map(|line| line.strip_prefix("pub async fn "))
        .map(|rest| &rest[..rest.find(['(', '<']).unwrap_or(rest.len())])
        .collect()
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_route_the_client_calls_is_one_the_api_serves() {
    let spec = spec();
    let routes = spec_routes(&spec);

    let mut wrong = Vec::new();
    for call in observe().await {
        if !routes.contains_key(&(call.method.clone(), call.path.clone())) {
            let shape = if call.path == call.raw_path {
                String::new()
            } else {
                format!(", i.e. {}", call.path)
            };
            wrong
                .push(format!("  ops::{} sends {} {}{shape}", call.op, call.method, call.raw_path));
        }
    }

    assert!(
        wrong.is_empty(),
        "{} call(s) go somewhere docs/openapi.json does not serve:\n{}\n\nEither the route is \
         wrong, or the router grew one and `mise run openapi` has not been run.",
        wrong.len(),
        wrong.join("\n")
    );
}

#[tokio::test]
async fn every_op_the_module_declares_is_exercised_by_this_test() {
    let declared = declared_ops();
    let exercised: BTreeSet<&str> = observe().await.iter().map(|call| call.op).collect();

    let uncovered: Vec<&&str> = declared.difference(&exercised).collect();
    assert!(
        uncovered.is_empty(),
        "these ops exist and this test never calls them, so nothing checks their routes: \
         {uncovered:?}\nAdd them to `call_every_op` and bump OPS_AT_LAST_REVIEW."
    );

    let stale: Vec<&&str> = exercised.difference(&declared).collect();
    assert!(stale.is_empty(), "this test calls something `ops` no longer declares: {stale:?}");

    assert_eq!(
        declared.len(),
        OPS_AT_LAST_REVIEW,
        "the number of ops changed; that is fine, but read this file before bumping the constant"
    );
}

#[tokio::test]
async fn every_request_body_uses_the_field_names_the_spec_declares() {
    let spec = spec();
    let routes = spec_routes(&spec);
    let observed = observe().await;
    let with_bodies = observed.iter().filter(|call| call.body.is_some()).count();
    let mutations =
        observed.iter().filter(|call| matches!(call.method.as_str(), "POST" | "PATCH")).count();
    assert_eq!(
        with_bodies, mutations,
        "every POST and PATCH carries a JSON body; if this drops to zero the checks below \
         become vacuous rather than false"
    );

    let mut checked = 0usize;
    let mut complaints = Vec::new();
    for call in &observed {
        let Some(body) = call.body.as_ref() else { continue };
        // A route the spec does not have is the other test's failure, not this
        // one's; reporting it twice would only make that one harder to read.
        let Some(route) = routes.get(&(call.method.clone(), call.path.clone())) else {
            checked += 1;
            continue;
        };

        let Some(schema) = route.operation.pointer("/requestBody/content/application~1json/schema")
        else {
            complaints.push(format!(
                "  ops::{} posts a JSON body to {} {}, which declares no request body",
                call.op, call.method, route.template
            ));
            checked += 1;
            continue;
        };

        checked += 1;
        for complaint in check_body(schema, body) {
            complaints.push(format!("  ops::{}: {complaint}", call.op));
        }
    }

    assert_eq!(checked, with_bodies, "a body was skipped rather than checked");
    assert!(
        complaints.is_empty(),
        "{} request body problem(s). Every request schema in `@prick/shared` is `.strict()`, so \
         a field the schema does not name is a 422 rather than a partially applied \
         write:\n{}",
        complaints.len(),
        complaints.join("\n")
    );
}

#[tokio::test]
async fn the_routes_the_cli_does_not_call_are_reported_rather_than_asserted() {
    let spec = spec();
    let routes = spec_routes(&spec);
    let used: BTreeSet<(String, String)> =
        observe().await.into_iter().map(|call| (call.method, call.path)).collect();

    let unused: Vec<String> = routes
        .iter()
        .filter(|(key, _)| !used.contains(*key))
        .map(|((method, _), route)| format!("  {method} {}", route.template))
        .collect();

    // Not an assertion. `/audit`, `/admin/*` and `/groups/**` have no CLI
    // surface on purpose, and a new server route must not fail the client's
    // build.
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(
        stderr,
        "\nthe CLI calls {} of the {} routes docs/openapi.json serves; unused:\n{}\n",
        used.len(),
        routes.len(),
        unused.join("\n")
    );

    assert!(used.len() <= routes.len(), "the client cannot use more routes than the spec has");
}

// ---------------------------------------------------------------------------
// A subset of JSON Schema, hand-rolled
// ---------------------------------------------------------------------------
//
// Enough of draft 2020-12 to answer the question these bodies actually get
// wrong: are the field names right, is everything required present, and is
// each value the right kind of thing. Not lengths, not patterns, not formats.
//
// A validator crate would cover those too, at the cost of a regex engine, an
// IDNA table and an email parser in the dev-dependency tree of a crate whose
// entire point is a small, auditable dependency graph. The field names are
// where the drift was, and they are free.

/// Complaints about `body` under `schema`. Empty means it fits.
fn check_body(schema: &Value, body: &Value) -> Vec<String> {
    let Some(branches) = schema.get("oneOf").and_then(Value::as_array) else {
        return check_object(schema, body);
    };

    // A discriminated union. Fitting any branch is fitting; when none fits, the
    // nearest one is the one worth reporting -- for a `scope_type` union that
    // is always the branch the discriminator selected.
    let mut nearest: Option<Vec<String>> = None;
    for branch in branches {
        let complaints = check_object(branch, body);
        if complaints.is_empty() {
            return Vec::new();
        }
        if nearest.as_ref().is_none_or(|best| complaints.len() < best.len()) {
            nearest = Some(complaints);
        }
    }
    nearest.unwrap_or_default()
}

/// Complaints about one object against one object schema.
fn check_object(schema: &Value, body: &Value) -> Vec<String> {
    let Some(fields) = body.as_object() else {
        return vec!["the request body is not a JSON object".to_owned()];
    };

    let properties = schema.get("properties").and_then(Value::as_object);
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    let mut complaints = Vec::new();

    for (name, value) in fields {
        match properties.and_then(|properties| properties.get(name)) {
            Some(property) => {
                if !fits(property, value) {
                    complaints.push(format!(
                        "sends `{name}` as {}, but the schema declares {}",
                        kind(value),
                        describe(property)
                    ));
                }
            }
            // `additionalProperties: false` is what turns an unrecognised field
            // name into a 422 rather than a field the server quietly ignores.
            None if closed => {
                complaints.push(format!("sends `{name}`, which this schema does not accept"));
            }
            None => {}
        }
    }

    let required = schema.get("required").and_then(Value::as_array);
    for name in required.into_iter().flatten().filter_map(Value::as_str) {
        if !fields.contains_key(name) {
            complaints.push(format!("omits `{name}`, which the schema requires"));
        }
    }

    complaints
}

/// Whether a value satisfies a property schema's `const`, `enum`, `anyOf` or
/// `type`. Everything else in the schema is deliberately not read.
fn fits(schema: &Value, value: &Value) -> bool {
    if let Some(expected) = schema.get("const") {
        return value == expected;
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        return allowed.contains(value);
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        return branches.iter().any(|branch| fits(branch, value));
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("number") => value.is_number(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("null") => value.is_null(),
        _ => true,
    }
}

/// The JSON kind of a value, for a failure message.
fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// The constraint a property schema imposes, in the terms the spec used.
fn describe(schema: &Value) -> String {
    for key in ["const", "enum", "type", "anyOf"] {
        if let Some(value) = schema.get(key) {
            return format!("{key} {value}");
        }
    }
    "no constraint".to_owned()
}
