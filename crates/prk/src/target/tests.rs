//! The server-selection and verification rules, against real files in a
//! temporary configuration directory.
//!
//! The fixture throughout is two organisations running the same application:
//! the same project, environment and key names, possibly the same Access
//! organisation and the same administrator. Only the instance id each server
//! reports tells them apart, which is exactly the case these checks exist for.

use clap::Parser as _;
use secrecy::SecretString;

use prick_auth::{StoredSession, TokenSource, Tokens};
use prick_core::profile::{Config, edit};

use super::*;
use crate::cli::Cli;
use crate::error::CliError;

const ACME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GLOBEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACME_URL: &str = "https://prick.acme.example";
const GLOBEX_URL: &str = "https://prick.globex.example";

fn global(flags: &[&str]) -> GlobalArgs {
    let mut argv = vec!["prk"];
    argv.extend_from_slice(flags);
    argv.push("whoami");
    Cli::try_parse_from(argv).expect("test arguments parse").global
}

fn session(url: &str) -> StoredSession {
    StoredSession {
        api_url: url.to_owned(),
        issuer: "https://shared.cloudflareaccess.com".to_owned(),
        client_id: "client".to_owned(),
        token_endpoint: "https://shared.cloudflareaccess.com/token".to_owned(),
        resource: None,
        revocation_endpoint: None,
        tokens: Tokens {
            access_token: SecretString::from("canary-token-value"),
            refresh_token: None,
            expires_at: None,
        },
    }
}

/// A store holding two profiles for two deployments of the same application.
fn two_orgs(acme_pinned: bool) -> (tempfile::TempDir, ProfileStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store
        .update(|config| -> Result<(), ProfileStoreError> {
            let mut acme = Profile::new(ACME_URL, "0000000000000001");
            acme.instance = acme_pinned.then(|| ACME.to_owned());
            let mut globex = Profile::new(GLOBEX_URL, "0000000000000002");
            globex.instance = Some(GLOBEX.to_owned());
            *config = edit::add(&Config::default(), "acme", acme, true, false).unwrap();
            *config = edit::add(config, "globex", globex, false, false).unwrap();
            Ok(())
        })
        .unwrap();
    (dir, store)
}

fn resolve_with(
    global: &GlobalArgs,
    env: &EnvVars,
    store: &ProfileStore,
) -> Result<Target, TargetError> {
    resolve_in(global, env, None, None, store.clone())
}

fn token(client_id: &str) -> ServiceToken {
    ServiceToken::new(client_id, SecretString::from("shh"), TokenSource::Flag)
}

#[test]
fn an_install_from_before_profiles_works_unchanged_and_nothing_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session(ACME_URL)).unwrap();

    let target = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    assert_eq!(target.api_url, ACME_URL);
    assert_eq!(target.selection.profile(), Some("default"));
    assert_eq!(target.tokens().path(), dir.path().join("credentials.json"));
    // One profile: writes and service tokens behave exactly as before.
    target.check_before_credentials(true, Some(&token("ci.access"))).unwrap();
    assert!(!store.config_path().exists(), "resolving an old install wrote config.toml");
}

#[test]
fn the_first_instance_an_old_install_sees_is_pinned_and_the_legacy_file_stays_put() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session(ACME_URL)).unwrap();
    let legacy = std::fs::read(dir.path().join("credentials.json")).unwrap();

    let mut target = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    target.verify(Some(ACME)).unwrap();
    assert!(target.pinned_now);

    let config = store.load().unwrap();
    assert!(config.persisted);
    assert_eq!(config.config.profiles["default"].instance.as_deref(), Some(ACME));
    assert_eq!(std::fs::read(dir.path().join("credentials.json")).unwrap(), legacy);
}

#[test]
fn a_write_with_two_profiles_must_name_its_server() {
    let (_dir, store) = two_orgs(true);

    let by_default = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    let err = by_default.check_before_credentials(true, None).unwrap_err();
    assert!(matches!(err, TargetError::WriteNeedsProfile { count: 2, .. }), "{err}");
    by_default.check_before_credentials(false, None).expect("reads keep the default");

    let by_flag =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    by_flag.check_before_credentials(true, None).unwrap();

    let by_env = EnvVars { profile: Some("globex".to_owned()), ..EnvVars::default() };
    resolve_with(&global(&[]), &by_env, &store)
        .unwrap()
        .check_before_credentials(true, None)
        .unwrap();
}

#[test]
fn a_service_token_with_two_profiles_pairs_only_with_an_explicit_server() {
    let (_dir, store) = two_orgs(true);

    let by_default = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    assert!(matches!(
        by_default.check_before_credentials(false, Some(&token("ci.access"))),
        Err(TargetError::TokenNeedsSelection { .. })
    ));

    let by_url = EnvVars { api_url: Some(GLOBEX_URL.to_owned()), ..EnvVars::default() };
    resolve_with(&global(&[]), &by_url, &store)
        .unwrap()
        .check_before_credentials(false, Some(&token("ci.access")))
        .unwrap();
}

#[test]
fn a_profile_expecting_one_service_token_refuses_another() {
    let (_dir, store) = two_orgs(true);
    store
        .update(|config| -> Result<(), ProfileStoreError> {
            config.profiles.get_mut("acme").unwrap().service_token_client_id =
                Some("acme-ci.access".to_owned());
            Ok(())
        })
        .unwrap();
    let target =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    assert!(matches!(
        target.check_before_credentials(false, Some(&token("globex-ci.access"))),
        Err(TargetError::ServiceTokenMismatch { .. })
    ));
    target.check_before_credentials(false, Some(&token("acme-ci.access"))).unwrap();
}

#[test]
fn identical_deployments_are_told_apart_by_instance_alone() {
    let (_dir, store) = two_orgs(true);
    // The acme profile, pointed at a server that answers as globex: same
    // application, same names, same Access organisation.
    let mut target =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    let err = target.verify(Some(GLOBEX)).unwrap_err();
    assert!(matches!(err, TargetError::InstanceMismatch { .. }), "{err}");
    assert_eq!(CliError::from(err).exit_code(), 3);

    let mut right =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    right.verify(Some(ACME)).unwrap();
    assert!(!right.pinned_now);
}

#[test]
fn a_pinned_server_that_stops_reporting_its_instance_is_refused() {
    let (_dir, store) = two_orgs(true);
    let mut target =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    assert!(matches!(target.verify(None), Err(TargetError::InstanceUnreported { .. })));
}

#[test]
fn an_unpinned_profile_is_pinned_once_and_then_held_to_it() {
    let (_dir, store) = two_orgs(false);
    let mut first =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    first.verify(Some(ACME)).unwrap();
    assert!(first.pinned_now);

    let mut later =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    assert!(matches!(later.verify(Some(GLOBEX)), Err(TargetError::InstanceMismatch { .. })));
}

#[test]
fn expect_instance_pins_a_script_to_one_deployment() {
    let (_dir, store) = two_orgs(true);
    let mut target = resolve_with(
        &global(&["--profile", "globex", "--expect-instance", ACME]),
        &EnvVars::default(),
        &store,
    )
    .unwrap();
    assert!(
        matches!(
            target.check_before_credentials(false, None),
            Err(TargetError::ExpectMismatch { .. })
        ),
        "a pinned profile that cannot match is refused before any request"
    );
    assert!(matches!(target.verify(Some(GLOBEX)), Err(TargetError::ExpectMismatch { .. })));

    let bare_env = EnvVars {
        api_url: Some("https://other.example".to_owned()),
        expect_instance: Some(ACME.to_owned()),
        ..EnvVars::default()
    };
    let mut bare = resolve_with(&global(&[]), &bare_env, &store).unwrap();
    assert!(bare.needs_verification(), "an expectation always asks the server");
    assert!(matches!(bare.verify(None), Err(TargetError::InstanceUnreported { .. })));
    bare.verify(Some(ACME)).unwrap();

    let malformed =
        resolve_with(&global(&["--expect-instance", "nope"]), &EnvVars::default(), &store);
    assert!(matches!(malformed, Err(TargetError::BadExpectation { .. })));
}

#[test]
fn a_bare_url_with_no_profile_sends_no_extra_request() {
    // The CI shape: PRK_API_URL and a service token in a fresh directory.
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    let env =
        EnvVars { api_url: Some("https://prick.example.com/".to_owned()), ..EnvVars::default() };
    let target = resolve_with(&global(&[]), &env, &store).unwrap();
    assert_eq!(target.api_url, "https://prick.example.com");
    assert!(!target.needs_verification());
    target.check_before_credentials(true, Some(&token("ci.access"))).unwrap();
}

fn write_project(dir: &Path, shared: &str, local: Option<&str>) {
    std::fs::write(dir.join(".prick.toml"), shared).unwrap();
    if let Some(local) = local {
        std::fs::write(dir.join(".prick.local.toml"), local).unwrap();
    }
}

#[test]
fn a_project_file_selects_by_instance_and_refuses_a_deployment_it_does_not_allow() {
    let (_dir, store) = two_orgs(true);
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        &format!("project = \"api\"\n[[allow]]\ninstance = \"{GLOBEX}\"\n"),
        None,
    );

    let target =
        resolve_in(&global(&[]), &EnvVars::default(), Some(project.path()), None, store.clone())
            .unwrap();
    assert_eq!(target.selection.profile(), Some("globex"));
    assert_eq!(target.default_project().as_deref(), Some("api"));
    target.check_before_credentials(false, None).expect("a committed file selects for reads");
    // A cloned repository's file is the author's choice, not the operator's:
    // with two profiles it does not satisfy the write guard.
    assert!(matches!(
        target.check_before_credentials(true, None),
        Err(TargetError::WriteNeedsProfile { .. })
    ));

    // The acme profile is pinned to an instance this project does not list:
    // refused before a credential is even resolved.
    let flagged = resolve_in(
        &global(&["--profile", "acme"]),
        &EnvVars::default(),
        Some(project.path()),
        None,
        store,
    )
    .unwrap();
    assert!(matches!(
        flagged.check_before_credentials(false, None),
        Err(TargetError::NotAllowed { .. })
    ));
}

#[test]
fn a_project_file_cannot_choose_among_several_deployments_but_a_local_file_can() {
    let (_dir, store) = two_orgs(true);
    let project = tempfile::tempdir().unwrap();
    let shared = format!("[[allow]]\ninstance = \"{ACME}\"\n[[allow]]\ninstance = \"{GLOBEX}\"\n");
    write_project(project.path(), &shared, Some(&format!("instance = \"{GLOBEX}\"\n")));

    let target =
        resolve_in(&global(&[]), &EnvVars::default(), Some(project.path()), None, store).unwrap();
    assert_eq!(target.selection.profile(), Some("globex"));
    assert_eq!(target.selection.source(), Source::LocalFile);
    target.check_before_credentials(true, None).expect("this checkout's own choice is deliberate");
}

#[test]
fn a_project_file_naming_a_url_is_refused() {
    let (_dir, store) = two_orgs(true);
    let project = tempfile::tempdir().unwrap();
    write_project(
        project.path(),
        &format!("url = \"https://evil.example\"\n[[allow]]\ninstance = \"{ACME}\"\n"),
        None,
    );
    let err = resolve_in(&global(&[]), &EnvVars::default(), Some(project.path()), None, store)
        .unwrap_err();
    assert!(matches!(err, TargetError::ProjectRead(_)), "{err}");
    assert_eq!(err.code(), "PROJECT_FILE_INVALID");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn an_unknown_or_renamed_profile_never_falls_through_to_another_server() {
    let (_dir, store) = two_orgs(true);
    store
        .update(|config| -> Result<(), ProfileStoreError> {
            *config = edit::rename(config, "acme", "acme-eu").unwrap();
            Ok(())
        })
        .unwrap();
    let err =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap_err();
    assert_eq!(err.code(), "PROFILE_RENAMED");
    assert!(err.to_string().contains("acme-eu"));

    let err =
        resolve_with(&global(&["--profile", "initech"]), &EnvVars::default(), &store).unwrap_err();
    assert_eq!(err.code(), "PROFILE_UNKNOWN");
    assert_eq!(CliError::from(err).exit_code(), 2);
}

#[test]
fn both_forms_at_one_tier_are_a_usage_error() {
    let (_dir, store) = two_orgs(true);
    let err = resolve_with(
        &global(&["--profile", "acme", "--api-url", GLOBEX_URL]),
        &EnvVars::default(),
        &store,
    )
    .unwrap_err();
    assert_eq!(err.code(), "SELECTION_CONFLICT");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn the_destination_names_server_profile_and_instance() {
    let (_dir, store) = two_orgs(true);
    let mut target =
        resolve_with(&global(&["--profile", "acme"]), &EnvVars::default(), &store).unwrap();
    target.verify(Some(ACME)).unwrap();
    let line = target.destination_line();
    assert!(line.contains("prick.acme.example"), "{line}");
    assert!(line.contains("profile acme"), "{line}");
    assert!(line.contains("instance aaaaaaaa"), "{line}");
    let json = target.destination_json();
    assert_eq!(json["server"], "prick.acme.example");
    assert_eq!(json["instance"], ACME);
}

#[test]
fn a_session_an_older_prk_wrote_for_another_server_is_moved_to_its_own_profile() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session(ACME_URL)).unwrap();
    // The newer build has recorded something, so config.toml exists.
    let mut first = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    first.verify(Some(ACME)).unwrap();

    // An older build signs in elsewhere, overwriting the only file it knows.
    store.legacy_tokens().save(&session(GLOBEX_URL)).unwrap();

    let target = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    assert_eq!(target.notes.len(), 1, "{:?}", target.notes);
    let config = store.load().unwrap().config;
    let adopted = config.profiles_for_url(GLOBEX_URL);
    assert_eq!(adopted.len(), 1);
    let adopted = &config.profiles[adopted[0]];
    assert!(store.tokens(adopted).load().unwrap().is_some(), "the session moved with it");
    assert!(
        store.legacy_tokens().load().unwrap().is_none(),
        "the profile that owned the legacy file is signed out, not handed another server's session"
    );
    assert_eq!(config.profiles["default"].api_url, ACME_URL);
}

#[test]
fn a_failed_first_pin_save_warns_and_the_command_carries_on() {
    // An updated install whose stored URL an older prk accepted, in a
    // configuration directory that cannot be written.
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session("http://10.0.0.5:8787")).unwrap();

    let mut target = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    assert_eq!(target.api_url, "http://10.0.0.5:8787", "the legacy URL is kept as it is");
    // A directory where config.toml should be makes the write fail.
    std::fs::create_dir(store.config_path()).unwrap();

    target.verify(Some(ACME)).expect("a pin that cannot be saved does not stop the command");
    assert!(!target.pinned_now);
    assert_eq!(target.warnings.len(), 1, "{:?}", target.warnings);
    assert_eq!(target.verified_instance.as_deref(), Some(ACME));
    // The check made in memory still holds for the rest of the run.
    assert!(matches!(target.verify(Some(GLOBEX)), Err(TargetError::InstanceMismatch { .. })));
}

#[test]
fn a_legacy_url_an_older_prk_accepted_can_still_be_pinned_and_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session("http://10.0.0.5:8787")).unwrap();
    let mut target = resolve_with(&global(&[]), &EnvVars::default(), &store).unwrap();
    target.verify(Some(ACME)).unwrap();
    assert!(target.pinned_now, "{:?}", target.warnings);
    assert_eq!(store.load().unwrap().config.profiles["default"].instance.as_deref(), Some(ACME));
}
