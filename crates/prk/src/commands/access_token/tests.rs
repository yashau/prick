//! Unit tests for `prk access token`: the resolver, the parsers, the
//! capabilities gate, secret delivery and the rendering helpers.

use clap::Parser as _;
use prick_api::models::ServiceToken;
use secrecy::SecretString;

use super::render::{date, expiry, flags, reconcile_row, row, seconds, timestamp, token_json};
use super::*;
use crate::cli::{Cli, Command};
use crate::commands::access::AccessCommand;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// A record built from the server's own JSON shape.
fn token(id: &str, client: &str, name: Option<&str>, status: &str) -> ServiceToken {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "identityId": format!("identity-{id}"),
        "clientId": client,
        "name": name,
        "cloudflareId": format!("cf-{id}"),
        "cloudflareName": format!("prick: {}", name.unwrap_or(id)),
        "status": status,
        "cloudflare": null,
    }))
    .expect("the shape matches the server's record")
}

fn tokens() -> Vec<ServiceToken> {
    vec![
        token("t-1", "aaa.access", Some("deploy"), "revoked"),
        token("t-2", "bbb.access", Some("deploy"), "active"),
        token("t-3", "ccc.access", Some("nightly"), "active"),
        token("t-4", "ddd.access", Some("nightly"), "missing"),
        token("bbb.access", "eee.access", Some("odd"), "active"),
    ]
}

fn capabilities(feature: &serde_json::Value) -> Capabilities {
    serde_json::from_value(serde_json::json!({
        "api": 1,
        "version": "2026.10.31",
        "instance": "3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
        "limits": {"secretMaxBytes": 1, "envMaxSecrets": 2, "bodyMaxBytes": 3},
        "features": {"serviceTokens": feature},
    }))
    .expect("the shape matches")
}

// ---------------------------------------------------------------------------
// Resolving a token
// ---------------------------------------------------------------------------

#[test]
fn a_token_resolves_by_id_client_id_or_name() {
    let tokens = tokens();
    assert_eq!(resolve(&tokens, "t-3").expect("by id").id, "t-3");
    assert_eq!(resolve(&tokens, "ccc.access").expect("by client id").id, "t-3");
    assert_eq!(resolve(&tokens, "ccc").expect("without the suffix").id, "t-3");
    assert_eq!(resolve(&tokens, "odd").expect("by name").id, "bbb.access");
}

#[test]
fn an_id_outranks_a_client_id_that_spells_the_same() {
    // `bbb.access` is one token's id and another's client id. The id wins,
    // because the kinds are tried in a fixed order.
    let tokens = tokens();
    assert_eq!(resolve(&tokens, "bbb.access").expect("by id").id, "bbb.access");
}

#[test]
fn a_name_prefers_the_token_still_in_service() {
    // Revoking and recreating under one name is the normal life of a CI token.
    let tokens = tokens();
    assert_eq!(resolve(&tokens, "deploy").expect("the active one").id, "t-2");
}

#[test]
fn an_ambiguous_name_lists_every_match() {
    let tokens = tokens();
    let err = resolve(&tokens, "nightly").expect_err("two live tokens share the name");
    let message = err.to_string();
    assert!(message.contains("ccc.access") && message.contains("ddd.access"), "{message}");
    assert!(message.contains("client id"), "{message}");
}

#[test]
fn an_unknown_token_points_at_the_listing() {
    let err = resolve(&tokens(), "nope").expect_err("nothing matches");
    assert!(err.to_string().contains("prk access token list --all"), "{err}");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

#[test]
fn grace_takes_a_number_and_a_unit() {
    assert_eq!(parse_grace("45s"), Ok(45));
    assert_eq!(parse_grace("30m"), Ok(1_800));
    assert_eq!(parse_grace("24h"), Ok(86_400));
    assert_eq!(parse_grace("7d"), Ok(604_800));
    assert_eq!(parse_grace("30d"), Ok(GRACE_MAX_SECONDS));
    assert_eq!(parse_grace("0s"), Ok(0));
}

#[test]
fn grace_refuses_a_bare_number_an_unknown_unit_and_too_long() {
    for bad in ["30", "", "h", "-1h", "1.5h", "2w", "1 h", "abc"] {
        assert!(parse_grace(bad).is_err(), "{bad:?} was accepted");
    }
    let err = parse_grace("31d").expect_err("over the ceiling");
    assert!(err.contains("30-day"), "{err}");
    assert!(parse_grace("99999999999999999999d").is_err(), "an overflow is refused");
}

#[test]
fn a_duration_is_whole_hours_or_forever() {
    assert_eq!(parse_duration("8760h").as_deref(), Ok("8760h"));
    assert_eq!(parse_duration("forever").as_deref(), Ok("forever"));
    assert_eq!(parse_duration("87600h").as_deref(), Ok("87600h"));
    for bad in ["0h", "087h", "87601h", "1d", "8760", "h", "1000000h", "Forever"] {
        assert!(parse_duration(bad).is_err(), "{bad:?} was accepted");
    }
}

#[test]
fn a_grant_reuses_the_scope_grammar_of_access_grant() {
    let global = prepare_grant(RoleArg::Writer, None, None).expect("defaults to *:*");
    assert_eq!(global.scope.to_string(), "*:*");
    assert!(global.expires_at.is_none());

    let narrow =
        prepare_grant(RoleArg::Reader, Some("billing:eu-west"), Some(7)).expect("one environment");
    assert_eq!(narrow.scope.to_string(), "billing:eu-west");
    assert!(narrow.expires_at.is_some_and(|at| at > now_ms()));

    assert!(prepare_grant(RoleArg::Reader, Some("*:prod"), None).is_err());
    assert!(prepare_grant(RoleArg::Reader, Some("no-colon"), None).is_err());
}

#[test]
fn the_documented_invocations_parse() {
    let cli = Cli::try_parse_from([
        "prk",
        "access",
        "token",
        "create",
        "staging deploy",
        "--role",
        "writer",
        "--scope",
        "billing:staging",
        "--expires-in",
        "90",
        "--duration",
        "forever",
        "--secret-file",
        "-",
    ])
    .expect("a full create parses");
    let Command::Access(AccessCommand::Token(TokenCommand::Create {
        name,
        role,
        scope,
        expires_in,
        duration,
        secret_file,
    })) = cli.command
    else {
        panic!("`access token create` did not parse as itself");
    };
    assert_eq!(name, "staging deploy");
    assert_eq!(role, Some(RoleArg::Writer));
    assert_eq!(scope.as_deref(), Some("billing:staging"));
    assert_eq!(expires_in, Some(90));
    assert_eq!(duration.as_deref(), Some("forever"));
    assert_eq!(secret_file.as_deref(), Some(Path::new("-")));

    let cli =
        Cli::try_parse_from(["prk", "access", "token", "rotate", "ci", "--grace", "24h", "-y"])
            .expect("a rotation with grace parses");
    let Command::Access(AccessCommand::Token(TokenCommand::Rotate { grace, .. })) = cli.command
    else {
        panic!("`access token rotate` did not parse as itself");
    };
    assert_eq!(grace, Some(86_400));
    assert!(cli.global.yes);

    for argv in [
        vec!["prk", "access", "token", "list", "--all"],
        vec!["prk", "access", "token", "refresh", "ci"],
        vec!["prk", "access", "token", "revoke", "ci", "--yes"],
        vec!["prk", "access", "token", "adopt", "abc.access", "--name", "legacy"],
        vec!["prk", "access", "token", "reconcile", "--apply", "--yes"],
    ] {
        assert!(Cli::try_parse_from(&argv).is_ok(), "{argv:?}");
    }
}

#[test]
fn a_scope_or_an_expiry_without_a_role_is_refused() {
    // A scope with nothing to grant on it would be silently dropped.
    assert!(
        Cli::try_parse_from(["prk", "access", "token", "create", "ci", "--scope", "*:*"]).is_err()
    );
    assert!(
        Cli::try_parse_from(["prk", "access", "token", "create", "ci", "--expires-in", "3"])
            .is_err()
    );
    assert!(
        Cli::try_parse_from(["prk", "access", "token", "rotate", "ci", "--grace", "40d"]).is_err()
    );
}

#[test]
fn every_subcommand_reports_a_distinct_path() {
    let commands = [
        TokenCommand::Create {
            name: "ci".to_owned(),
            role: None,
            scope: None,
            expires_in: None,
            duration: None,
            secret_file: None,
        },
        TokenCommand::List { all: false },
        TokenCommand::Rotate { token: "ci".to_owned(), grace: None, secret_file: None },
        TokenCommand::Refresh { token: "ci".to_owned() },
        TokenCommand::Revoke { token: "ci".to_owned() },
        TokenCommand::Adopt { client_id: "abc.access".to_owned(), name: None },
        TokenCommand::Reconcile { apply: false },
    ];
    let paths: std::collections::BTreeSet<&str> = commands.iter().map(TokenCommand::path).collect();
    assert_eq!(paths.len(), commands.len());
    assert!(paths.iter().all(|path| path.starts_with("access token ")));
}

// ---------------------------------------------------------------------------
// The capabilities gate
// ---------------------------------------------------------------------------

#[test]
fn an_allowed_feature_lets_the_command_proceed() {
    let answer = capabilities(&serde_json::json!({
        "state": "enabled", "allowed": true, "reason": null, "hint": null
    }));
    let capabilities = require_service_tokens(Ok(answer)).expect("allowed");
    assert_eq!(capabilities.instance.as_deref(), Some("3f9c01ab3f9c01ab3f9c01ab3f9c01ab"));
}

#[test]
fn a_worker_without_capabilities_is_told_to_upgrade() {
    let err = require_service_tokens(Err(ApiError::new(ErrorKind::NotFound, "no route")))
        .expect_err("a 404 stops the command");
    assert!(err.to_string().contains("predates"), "{err}");
    assert!(err.hint().is_some_and(|hint| hint.contains("newer release")), "{:?}", err.hint());
}

#[test]
fn a_worker_that_does_not_report_the_feature_is_told_to_upgrade() {
    let answer: Capabilities = serde_json::from_value(serde_json::json!({
        "api": 1, "version": "v", "instance": null, "features": {}
    }))
    .expect("the shape matches");
    let err = require_service_tokens(Ok(answer)).expect_err("no feature, no command");
    assert!(err.to_string().contains("predates"), "{err}");
}

#[test]
fn an_unconfigured_deployment_stops_with_the_servers_hint() {
    let answer = capabilities(&serde_json::json!({
        "state": "unavailable", "allowed": false, "reason": "unconfigured",
        "hint": "Set the CF_API_TOKEN secret and the CF_ACCOUNT_ID var, then redeploy."
    }));
    let err = require_service_tokens(Ok(answer)).expect_err("unconfigured");
    assert!(err.to_string().contains("SERVICE_TOKENS_UNCONFIGURED"), "{err}");
    assert_eq!(err.server_code(), Some("SERVICE_TOKENS_UNCONFIGURED"));
    assert_eq!(err.code(), "SERVICE_UNAVAILABLE");
    assert_eq!(
        err.hint(),
        Some("Set the CF_API_TOKEN secret and the CF_ACCOUNT_ID var, then redeploy.")
    );
    // The same exit code the route's own 503 maps to.
    assert_eq!(err.exit_code(), ErrorKind::ServiceUnavailable.exit_code());
}

#[test]
fn a_caller_without_global_admin_is_refused_as_forbidden() {
    let answer = capabilities(&serde_json::json!({
        "state": "unavailable", "allowed": false, "reason": null, "hint": null
    }));
    let err = require_service_tokens(Ok(answer)).expect_err("not a global admin");
    assert!(err.to_string().contains("global admin"), "{err}");
    assert_eq!(err.exit_code(), ErrorKind::Forbidden.exit_code());
    assert_eq!(err.code(), "FORBIDDEN");
}

#[test]
fn any_other_capabilities_failure_is_reported_as_itself() {
    let err = require_service_tokens(Err(ApiError::new(ErrorKind::Unauthenticated, "expired")))
        .expect_err("passed through");
    assert_eq!(err.code(), "UNAUTHENTICATED");
}

// ---------------------------------------------------------------------------
// Secret delivery
// ---------------------------------------------------------------------------

#[test]
fn the_secret_file_flag_names_three_destinations() {
    assert_eq!(SecretSink::from_flag(None), SecretSink::Show);
    assert_eq!(SecretSink::from_flag(Some(Path::new("-"))), SecretSink::Stdout);
    assert_eq!(
        SecretSink::from_flag(Some(Path::new("ci.secret"))),
        SecretSink::File(PathBuf::from("ci.secret"))
    );
}

#[test]
fn stdout_delivery_is_refused_under_json_before_anything_is_sent() {
    let err = SecretSink::Stdout.check(true).expect_err("stdout is the document's");
    assert!(err.to_string().contains("--json"), "{err}");
    SecretSink::Stdout.check(false).expect("fine without --json");
    SecretSink::Show.check(true).expect("the document carries it");
}

#[test]
fn a_file_destination_is_checked_before_a_secret_exists() {
    let dir = tempfile::tempdir().expect("a temporary directory");

    let missing = SecretSink::File(dir.path().join("absent").join("secret"));
    assert!(missing.check(false).expect_err("no such directory").to_string().contains("absent"));

    let directory = SecretSink::File(dir.path().to_owned());
    assert!(directory.check(false).is_err(), "a directory is not a file");

    SecretSink::File(dir.path().join("secret")).check(false).expect("a writable path");
    SecretSink::File(PathBuf::from("bare-name")).check(false).expect("the working directory");
}

#[test]
fn a_file_delivery_writes_the_secret_alone_and_owner_only() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("client-secret");
    let secret = SecretString::from("s3cr3t-value");
    let out = Output::new(false, true, 0, crate::cli::ColorChoice::Never);

    deliver(&secret, &SecretSink::File(path.clone()), out).expect("written");

    assert_eq!(std::fs::read_to_string(&path).expect("readable"), "s3cr3t-value");
    assert!(prick_auth::store::is_path_owner_only(&path).expect("metadata"));
}

#[test]
fn an_undelivered_secret_says_how_to_get_a_new_one_and_never_carries_it() {
    let err = undelivered(
        &std::io::Error::new(std::io::ErrorKind::StorageFull, "disk full"),
        "rotated",
        "abc.access",
    );
    let message = err.to_string();
    assert!(message.contains("prk access token rotate abc.access"), "{message}");
    assert!(message.contains("disk full"), "{message}");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn with_cloudflare(expires_at: Option<i64>, leak: Option<i64>) -> ServiceToken {
    serde_json::from_value(serde_json::json!({
        "id": "t", "clientId": "abc.access", "name": "ci", "status": "active",
        "cloudflare": {"expiresAt": expires_at, "lastSeenAt": 1_760_000_000_000_i64,
                       "enabled": true, "duration": "8760h", "leakReportedAt": leak}
    }))
    .expect("the shape matches")
}

#[test]
fn a_listing_flags_an_expiry_inside_thirty_days_and_a_leak() {
    let now = 1_760_000_000_000;
    assert_eq!(flags(&with_cloudflare(Some(now + 40 * DAY_MS), None), now), Vec::<&str>::new());
    assert_eq!(flags(&with_cloudflare(Some(now + 10 * DAY_MS), None), now), ["EXPIRES SOON"]);
    assert_eq!(flags(&with_cloudflare(Some(now - 1), None), now), ["EXPIRED"]);
    assert_eq!(flags(&with_cloudflare(None, Some(now)), now), ["LEAK REPORTED"]);

    let line = row(&with_cloudflare(Some(now + DAY_MS), Some(now)), now);
    assert!(line.starts_with("ci\tabc.access\tactive\texpires "), "{line}");
    assert!(line.contains("last seen 2025-10-09"), "{line}");
    assert!(line.ends_with("EXPIRES SOON\tLEAK REPORTED"), "{line}");

    let json = token_json(&with_cloudflare(Some(now + DAY_MS), Some(now)), now);
    assert_eq!(json["expires_soon"], true);
    assert_eq!(json["leak_reported"], true);
    assert_eq!(json["client_id"], "abc.access");
}

#[test]
fn an_unreachable_cloudflare_reads_as_unknown_rather_than_never() {
    let token = token("t", "abc.access", Some("ci"), "active");
    let line = row(&token, 0);
    assert!(line.contains("expires unknown\tlast seen unknown"), "{line}");
}

#[test]
fn dates_are_utc_and_exact() {
    assert_eq!(date(0), "1970-01-01");
    assert_eq!(date(951_782_400_000), "2000-02-29");
    assert_eq!(date(1_760_000_000_000), "2025-10-09");
    assert_eq!(date(-DAY_MS), "1969-12-31");
    assert_eq!(timestamp(1_760_000_000_000), "2025-10-09 08:53 UTC");
}

#[test]
fn a_grace_is_shown_in_its_largest_whole_unit() {
    assert_eq!(seconds(604_800), "7d");
    assert_eq!(seconds(86_400), "1d");
    assert_eq!(seconds(7_200), "2h");
    assert_eq!(seconds(5_400), "90m");
    assert_eq!(seconds(61), "61s");
}

#[test]
fn a_deployment_is_named_by_host_and_short_instance() {
    let deployment = Deployment {
        host: "prick.example.com".to_owned(),
        instance: Some("3f9c01ab3f9c01ab3f9c01ab3f9c01ab".to_owned()),
    };
    assert_eq!(deployment.label(), "prick.example.com (instance 3f9c01ab)");
}

/// A record whose `cloudflare` member is exactly `cloudflare`.
fn with_cloudflare_member(cloudflare: &serde_json::Value) -> ServiceToken {
    serde_json::from_value(serde_json::json!({
        "id": "t", "clientId": "abc.access", "name": "ci", "status": "active",
        "cloudflare": cloudflare,
    }))
    .expect("the shape matches")
}

#[test]
fn an_unreported_last_use_is_unknown_never_never() {
    let token = with_cloudflare_member(&serde_json::json!({
        "expiresAt": 1_790_000_000_000_i64, "lastSeenAt": null, "enabled": true,
        "duration": "8760h", "leakReportedAt": null,
    }));
    let line = row(&token, 0);
    assert!(line.contains("last seen unknown"), "{line}");
    assert!(!line.contains("never"), "{line}");
}

#[test]
fn only_a_forever_token_with_no_expiry_never_expires() {
    let forever = with_cloudflare_member(&serde_json::json!({
        "expiresAt": null, "enabled": true, "duration": "forever",
    }));
    let yearly = with_cloudflare_member(&serde_json::json!({
        "expiresAt": null, "enabled": true, "duration": "8760h",
    }));
    let unstated = with_cloudflare_member(&serde_json::json!({ "enabled": true }));

    assert_eq!(expiry(forever.cloudflare.as_ref().expect("present")), "never");
    assert_eq!(expiry(yearly.cloudflare.as_ref().expect("present")), "unknown");
    assert_eq!(expiry(unstated.cloudflare.as_ref().expect("present")), "unknown");
    assert!(row(&forever, 0).contains("expires never"));
    assert!(row(&yearly, 0).contains("expires unknown"));

    // No `cloudflare` at all, as straight after a create whose follow-up read
    // failed: unknown, not never.
    let absent = with_cloudflare_member(&serde_json::Value::Null);
    assert!(row(&absent, 0).contains("expires unknown\tlast seen unknown"));
}

#[test]
fn revoking_an_adopted_token_warns_that_other_applications_lose_it() {
    let mut adopted: serde_json::Value = serde_json::json!({
        "id": "t", "clientId": "abc.access", "name": "shared", "status": "active",
        "adopted": true,
    });
    let token: ServiceToken = serde_json::from_value(adopted.clone()).expect("shape");
    let warning = adopted_revoke_warning(&token).expect("an adopted token warns");
    assert!(warning.contains("abc.access"), "{warning}");
    assert!(warning.contains("deletes it in Cloudflare"), "{warning}");
    assert!(warning.contains("every application"), "{warning}");

    adopted["adopted"] = false.into();
    let created: ServiceToken = serde_json::from_value(adopted).expect("shape");
    assert_eq!(adopted_revoke_warning(&created), None);
}

#[test]
fn skipped_and_foreign_reconcile_entries_are_not_repairs() {
    let result: prick_api::models::ReconcileResult = serde_json::from_value(serde_json::json!({
        "applied": false,
        "entries": [
            {"kind": "missing", "clientId": "a.access", "skipped": false},
            {"kind": "missing", "clientId": "b.access", "skipped": true,
             "reason": "Created moments ago; too new to judge."},
            {"kind": "foreign", "clientId": "c.access", "skipped": true},
            {"kind": "orphan", "clientId": "d.access"},
        ],
    }))
    .expect("the shape matches");
    assert_eq!(repair_count(&result.entries), 2);

    let only_skipped: prick_api::models::ReconcileResult =
        serde_json::from_value(serde_json::json!({
            "applied": false,
            "entries": [{"kind": "missing", "clientId": "b.access", "skipped": true}],
        }))
        .expect("the shape matches");
    assert_eq!(repair_count(&only_skipped.entries), 0);
}

#[test]
fn a_skipped_reconcile_entry_shows_its_reason_instead_of_a_repair() {
    let entry: prick_api::models::ReconcileEntry = serde_json::from_value(serde_json::json!({
        "kind": "missing", "clientId": "b.access", "name": "ci", "skipped": true,
        "reason": "Created moments ago; too new to judge.",
    }))
    .expect("the shape matches");
    let line = reconcile_row(&entry);
    assert!(line.ends_with("skipped: Created moments ago; too new to judge."), "{line}");
    assert!(!line.contains("apply marks it revoked"), "{line}");
}
