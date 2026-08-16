//! Unit tests for [`super`] -- the request bodies, and the URLs that are easy
//! to get subtly wrong.
//!
//! In their own file rather than a `mod tests` block at the foot of `ops.rs`,
//! because `lint:loc` caps a source file at 1000 lines and the two together are
//! past it. The seam is the obvious one, and it is the only one available:
//! `crates/prick-api/tests/contract.rs` discovers routes by reading `ops.rs`
//! with `include_str!` and scanning for `pub async fn`, so every op has to stay
//! in that one file. What can move is everything that is not a declaration.
//!
//! `contract.rs` is the other half of the proof and answers a different
//! question. It asserts that the requests these bodies travel in reach routes
//! `docs/openapi.json` serves; this file asserts what is *in* them -- and the
//! difference between an absent key and a present `null` is invisible to a
//! round trip that succeeds either way.

use super::*;
use crate::config::Config;
use crate::credential::Credential;

fn client() -> Client {
    Client::new(Config::new("https://prick.example.com"), Credential::Anonymous)
        .expect("building a client must succeed")
}

#[test]
fn a_custom_method_hangs_off_the_collection_not_off_a_key() {
    let client = client();
    assert_eq!(
        custom_method(&client, "billing", "eu-west", ":rollback"),
        "https://prick.example.com/api/v1/projects/billing/environments/eu-west/secrets:rollback"
    );
    assert_eq!(
        custom_method(&client, "billing", "eu-west", ":export"),
        "https://prick.example.com/api/v1/projects/billing/environments/eu-west/secrets:export"
    );
}

#[test]
fn a_uuid_is_the_only_thing_between_identities_and_effective_permissions() {
    // Not `/access/identities/...`, and not a query parameter: the id is a
    // path segment, and the route hangs off `/identities`.
    // `crates/prick-api/tests/contract.rs` checks this shape against
    // `docs/openapi.json`; this pins the spelling the code emits, so a
    // failure says which of the two moved.
    assert_eq!(
        effective_permissions_url(&client(), "abc"),
        "https://prick.example.com/api/v1/identities/abc/effective-permissions"
    );
}

#[test]
fn a_batch_body_carries_a_map_of_set_keys_and_an_array_of_deletes() {
    let value = SecretString::from("postgres://u:p@h/db");
    let body = batch_body(&BatchRequest {
        mode: WriteMode::Merge,
        set: vec![("DATABASE_URL", &value)],
        descriptions: vec![("DATABASE_URL", Some("Primary, rotates quarterly"))],
        delete: vec!["OLD_KEY"],
        expected_rev: Some(4),
        reason: Some("rotation"),
    });

    assert_eq!(body["mode"], "merge");
    assert_eq!(body["set"]["DATABASE_URL"], "postgres://u:p@h/db");
    assert_eq!(body["descriptions"]["DATABASE_URL"], "Primary, rotates quarterly");
    assert_eq!(body["delete"], serde_json::json!(["OLD_KEY"]));
    // `expectedRev` would be accepted by no schema in this API and would
    // leave the write with no concurrency guard at all.
    assert_eq!(body["expected_rev"], 4);
    assert_eq!(body["reason"], "rotation");
}

#[test]
fn a_description_is_omitted_when_unset_and_null_when_cleared() {
    let value = SecretString::from("x");

    // Omitted. The server coalesces, so the stored description survives a
    // write that says nothing about it -- which is what every `prk secrets
    // set` without `--description` must do.
    let silent = batch_body(&BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() });
    assert!(silent.get("descriptions").is_none(), "an empty list is not an empty object");

    // Present and `null`. The server overwrites, so this clears it.
    let cleared = batch_body(&BatchRequest {
        set: vec![("K", &value)],
        descriptions: vec![("K", None)],
        ..BatchRequest::default()
    });
    assert_eq!(cleared["descriptions"]["K"], serde_json::Value::Null);
    assert!(
        cleared["descriptions"].as_object().is_some_and(|map| map.contains_key("K")),
        "a cleared description is a present null, not an absent key"
    );
}

#[test]
fn an_absent_guard_or_reason_is_omitted_rather_than_sent_as_null() {
    let value = SecretString::from("x");
    let body = batch_body(&BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() });

    assert!(body.get("expected_rev").is_none());
    assert!(body.get("reason").is_none());
    assert!(body.get("delete").is_none(), "an empty delete list is not the same as none");
    assert_eq!(body["mode"], "merge", "the default mode is the non-destructive one");
}

#[test]
fn a_batch_request_never_prints_a_value_through_debug() {
    let value = SecretString::from("hunter2");
    let request = BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() };

    let rendered = format!("{request:?}");
    assert!(!rendered.contains("hunter2"), "a value leaked through Debug: {rendered}");
    assert!(rendered.contains('K'), "the key is plaintext and should still be visible");
}

#[test]
fn an_import_body_is_a_blob_rather_than_a_parsed_array() {
    let body = import_body(&ImportRequest {
        format: ImportFormat::Env,
        content: "A=1\nB=2\n",
        mode: WriteMode::Replace,
        dry_run: true,
        expected_rev: Some(7),
        reason: None,
    });

    assert_eq!(body["format"], "env");
    assert_eq!(body["content"], "A=1\nB=2\n");
    assert_eq!(body["mode"], "replace");
    assert_eq!(body["dry_run"], true);
    assert_eq!(body["expected_rev"], 7);
    assert!(body.get("secrets").is_none(), "the server owns the parser");
}

#[test]
fn an_import_request_never_prints_the_blob_through_debug() {
    let request = ImportRequest {
        format: ImportFormat::Env,
        content: "DATABASE_URL=hunter2\n",
        mode: WriteMode::Replace,
        dry_run: false,
        expected_rev: None,
        reason: None,
    };

    let rendered = format!("{request:?}");
    assert!(!rendered.contains("hunter2"), "a blob leaked through Debug: {rendered}");
    assert!(rendered.contains("redacted"), "{rendered}");
}

#[test]
fn a_grant_body_is_discriminated_on_scope_type() {
    let global = grant_body("id-1", "admin", GrantScope::Global, None);
    assert_eq!(global["scope_type"], "global");
    assert!(global.get("project").is_none(), "a global grant names no project");
    assert!(global.get("expires_at").is_none());

    let project = grant_body("id-1", "writer", GrantScope::Project { project: "billing" }, None);
    assert_eq!(project["scope_type"], "project");
    assert_eq!(project["project"], "billing");
    assert!(project.get("environment").is_none());

    let environment = grant_body(
        "id-1",
        "reader",
        GrantScope::Environment { project: "billing", environment: "eu-west" },
        Some(1_760_000_000_000),
    );
    assert_eq!(environment["scope_type"], "environment");
    assert_eq!(environment["environment"], "eu-west");
    assert_eq!(environment["expires_at"], 1_760_000_000_000_i64);
    // Never `subject`, and never a `scope` string: neither exists.
    assert!(environment.get("subject").is_none());
    assert!(environment.get("scope").is_none());
    assert_eq!(environment["identity_id"], "id-1");
}

#[test]
fn an_identity_patch_carries_only_the_fields_it_was_given() {
    // The re-enable hazard, stated as an assertion. `prk access rename`
    // changes a label; a `disabled` key riding along on that request --
    // `false`, because a `bool` field defaulted -- would silently undo a
    // kill switch somebody threw during an incident.
    let renamed = identity_body(&IdentityUpdate {
        display_name: DisplayNameChange::Set("staging deploy job"),
        disabled: None,
    });
    assert_eq!(renamed["display_name"], "staging deploy job");
    assert!(
        renamed.get("disabled").is_none(),
        "a rename must say nothing about the kill switch: {renamed}"
    );
    assert_eq!(renamed.as_object().map(serde_json::Map::len), Some(1));

    // And the mirror: a kill switch says nothing about the label, so
    // disabling an identity cannot erase the one thing that makes an access
    // list readable.
    let disabled = identity_body(&IdentityUpdate {
        display_name: DisplayNameChange::Keep,
        disabled: Some(true),
    });
    assert_eq!(disabled["disabled"], true);
    assert!(disabled.get("display_name").is_none(), "{disabled}");
    assert_eq!(disabled.as_object().map(serde_json::Map::len), Some(1));
}

#[test]
fn a_display_name_is_omitted_when_kept_and_null_when_cleared() {
    // Absent and `null` are different requests. The server coalesces an
    // absent key and overwrites a present one, so collapsing the two would
    // make "leave the label alone" and "erase the label" the same call.
    let kept = identity_body(&IdentityUpdate::default());
    assert!(kept.get("display_name").is_none(), "an omitted field is not a null one: {kept}");
    assert_eq!(kept, serde_json::json!({}), "the default update asks for nothing");

    let cleared = identity_body(&IdentityUpdate {
        display_name: DisplayNameChange::Clear,
        ..IdentityUpdate::default()
    });
    // `cleared["display_name"]` would answer `null` for an absent key too --
    // `serde_json`'s indexing operator does not distinguish the two, which
    // is the very distinction under test. So the key is fetched.
    assert_eq!(
        cleared.get("display_name"),
        Some(&serde_json::Value::Null),
        "a cleared name is a present null, not an absent key"
    );
}

#[test]
fn disabling_and_enabling_are_the_same_field_with_different_values() {
    // `disabled: false` is a real instruction, not the absence of one, so it
    // has to reach the wire when it was actually asked for.
    let enabled = identity_body(&IdentityUpdate {
        display_name: DisplayNameChange::Keep,
        disabled: Some(false),
    });
    assert_eq!(enabled["disabled"], false);
    assert!(
        enabled.as_object().is_some_and(|body| body.contains_key("disabled")),
        "re-enabling must be sent, not inferred from an omitted field"
    );
}

#[test]
fn the_cli_scope_spelling_maps_onto_the_unions_three_arms() {
    let global: Scope = "*:*".parse().expect("a global scope");
    assert_eq!(GrantScope::from_scope(&global).expect("global"), GrantScope::Global);

    let project: Scope = "billing:*".parse().expect("a project scope");
    assert_eq!(
        GrantScope::from_scope(&project).expect("project"),
        GrantScope::Project { project: "billing" }
    );

    let environment: Scope = "billing:eu-west".parse().expect("an environment scope");
    assert_eq!(
        GrantScope::from_scope(&environment).expect("environment"),
        GrantScope::Environment { project: "billing", environment: "eu-west" }
    );
}

#[test]
fn an_environment_without_a_project_is_refused_rather_than_widened() {
    let scope: Scope = "*:production".parse().expect("parses as a scope");
    let err = GrantScope::from_scope(&scope).expect_err("there is no such grant scope");
    assert_eq!(err.kind(), ErrorKind::Validation);
    assert!(err.to_string().contains("production"), "{err}");
}

#[test]
fn the_wire_spellings_are_the_ones_the_schemas_accept() {
    assert_eq!(WriteMode::default().as_str(), "merge");
    assert_eq!(WriteMode::Replace.as_str(), "replace");
    assert_eq!(ImportFormat::default().as_str(), "env");
    assert_eq!(ImportFormat::Json.as_str(), "json");
    for reason in
        [RevealReason::Reveal, RevealReason::Copy, RevealReason::Export, RevealReason::Run]
    {
        assert!(reason.as_str().chars().all(|c| c.is_ascii_lowercase()));
    }
}
