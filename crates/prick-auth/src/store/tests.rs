//! Unit tests for [`super`] -- the file format, permissions, and the move out
//! of the roaming profile.
//!
//! In their own file rather than a `mod tests` block at the foot of
//! `store.rs`, because `lint:loc` caps a source file at 1000 lines and the two
//! together are past it.

use super::*;

fn session() -> StoredSession {
    StoredSession {
        api_url: "https://prick.example.com".to_owned(),
        issuer: "https://example.cloudflareaccess.com".to_owned(),
        client_id: "client-123".to_owned(),
        token_endpoint: "https://example.cloudflareaccess.com/token".to_owned(),
        resource: Some("https://prick.example.com".to_owned()),
        revocation_endpoint: Some("https://example.cloudflareaccess.com/revoke".to_owned()),
        tokens: Tokens {
            access_token: SecretString::from("access-abc"),
            refresh_token: Some(SecretString::from("refresh-xyz")),
            expires_at: Some(1_800_000_000),
        },
    }
}

fn store() -> (tempfile::TempDir, TokenStore) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = TokenStore::in_dir(dir.path().join("prick"), StorageBackend::File);
    (dir, store)
}

#[test]
fn the_default_backend_works_without_a_session() {
    assert_eq!(StorageBackend::default(), StorageBackend::File);
    assert!(StorageBackend::default().works_headless());
    assert!(!StorageBackend::Keyring.works_headless());
}

#[test]
fn the_token_file_is_owner_only() {
    assert_eq!(TOKEN_FILE_MODE, 0o600);
    assert_eq!(TOKEN_DIR_MODE, 0o700);
    assert_eq!(TOKEN_FILE_MODE & 0o077, 0, "group and other must have no access");
}

#[test]
fn backend_names_are_stable() {
    assert_eq!(StorageBackend::File.as_str(), "file");
    assert_eq!(StorageBackend::Keyring.as_str(), "keyring");
}

#[test]
fn a_session_round_trips_through_the_file() {
    let (_dir, store) = store();
    assert!(store.load().expect("an absent file is not an error").is_none());

    store.save(&session()).expect("saving must succeed");
    let loaded = store.load().expect("loading must succeed").expect("a session was saved");

    assert_eq!(loaded.api_url, "https://prick.example.com");
    assert_eq!(loaded.client_id, "client-123");
    assert_eq!(loaded.tokens.access_token.expose_secret(), "access-abc");
    assert_eq!(
        loaded.tokens.refresh_token.as_ref().map(SecretString::expose_secret),
        Some("refresh-xyz")
    );
    assert_eq!(loaded.tokens.expires_at, Some(1_800_000_000));
}

#[test]
fn saving_twice_replaces_rather_than_appends() {
    let (_dir, store) = store();
    store.save(&session()).expect("first save");

    let mut second = session();
    second.tokens.access_token = SecretString::from("access-second");
    store.save(&second).expect("second save");

    let loaded = store.load().expect("load").expect("a session");
    assert_eq!(loaded.tokens.access_token.expose_secret(), "access-second");
}

#[test]
fn the_written_file_is_owner_only() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");
    assert!(
        store.is_owner_only().expect("the permissions must be readable"),
        "the credentials file is readable by more than its owner"
    );
}

#[test]
fn a_missing_file_is_reported_as_owner_only_rather_than_as_a_finding() {
    let (_dir, store) = store();
    assert!(store.is_owner_only().expect("no file is not an error"));
}

#[test]
fn no_temporary_file_is_left_behind() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");

    let leftovers: Vec<_> = std::fs::read_dir(store.dir())
        .expect("the directory exists")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "tmp"))
        .collect();

    assert!(leftovers.is_empty(), "a temporary file survived: {leftovers:?}");
}

#[test]
fn a_leftover_temporary_file_does_not_block_a_save() {
    let (_dir, store) = store();
    store.save(&session()).expect("first save");

    // The name a build that used the process id would have chosen. Every
    // temporary name is random now, so a leftover never collides.
    let stale = store.dir().join(format!(".{TOKEN_FILE_NAME}.{}.tmp", std::process::id()));
    std::fs::write(&stale, b"leftover from a crash").expect("write");

    store.save(&session()).expect("a stale temporary file must not wedge the store");
    assert!(store.load().expect("load").is_some());
}

#[test]
fn logging_out_twice_is_not_an_error() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");
    store.clear().expect("first clear");
    store.clear().expect("clearing an absent file is success");
    assert!(store.load().expect("load").is_none());
}

#[test]
fn a_corrupt_file_is_reported_rather_than_treated_as_absent() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");
    std::fs::write(store.path(), b"not json at all").expect("write");

    let err = store.load().expect_err("a corrupt file is not an absent one");
    assert!(matches!(err, AuthError::Store { operation: "parse", .. }));
}

#[test]
fn an_unknown_file_version_is_refused_rather_than_guessed_at() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");
    let raw = std::fs::read_to_string(store.path()).expect("read");
    std::fs::write(store.path(), raw.replace("\"version\": 1", "\"version\": 99")).expect("write");

    let err = store.load().expect_err("an unknown version is not readable");
    assert!(err.to_string().contains("99"), "{err}");
}

#[test]
fn the_file_carries_a_version_so_a_future_shape_is_detectable() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");
    let raw = std::fs::read_to_string(store.path()).expect("read");
    assert!(raw.contains("\"version\": 1"), "{raw}");
}

#[test]
fn a_session_with_no_refresh_token_round_trips() {
    let (_dir, store) = store();
    let mut without = session();
    without.tokens.refresh_token = None;
    without.tokens.expires_at = None;
    store.save(&without).expect("save");

    let loaded = store.load().expect("load").expect("a session");
    assert!(loaded.tokens.refresh_token.is_none());
    assert!(loaded.tokens.expires_at.is_none());
    assert!(!loaded.is_refreshable());
}

#[test]
fn the_revocation_endpoint_survives_a_round_trip() {
    let (_dir, store) = store();
    store.save(&session()).expect("save");

    let loaded = store.load().expect("load").expect("a session");
    assert_eq!(
        loaded.revocation_endpoint.as_deref(),
        Some("https://example.cloudflareaccess.com/revoke")
    );
}

#[test]
fn a_credential_written_before_revocation_existed_still_loads() {
    // The compatibility case that matters: everyone signed in today has a
    // file with no `revocation_endpoint` in it, and a logout that refused to
    // read it would leave them unable to sign out at all.
    let (_dir, store) = store();
    store.save(&session()).expect("save");

    let raw = std::fs::read_to_string(store.path()).expect("read");
    let older: serde_json::Value = serde_json::from_str(&raw).expect("JSON");
    let mut older = older.as_object().expect("an object").clone();
    older.remove("revocation_endpoint");
    std::fs::write(store.path(), serde_json::to_string(&older).expect("JSON"))
        .expect("write the older shape back");

    let loaded = store.load().expect("an older file still loads").expect("a session");
    assert!(loaded.revocation_endpoint.is_none());
    // And the rest of it is intact, so the fallback is the only difference.
    assert_eq!(loaded.client_id, session().client_id);
    assert!(loaded.is_refreshable());
}

#[test]
fn a_session_with_nowhere_to_revoke_writes_no_such_field() {
    // `skip_serializing_if`, so a server that advertises no revocation
    // endpoint does not get a null recorded for one.
    let (_dir, store) = store();
    let mut without = session();
    without.revocation_endpoint = None;
    store.save(&without).expect("save");

    let raw = std::fs::read_to_string(store.path()).expect("read");
    assert!(!raw.contains("revocation_endpoint"), "{raw}");
}

#[test]
fn the_keyring_backend_says_so_rather_than_writing_a_file() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = TokenStore::in_dir(dir.path(), StorageBackend::Keyring);

    let err = store.save(&session()).expect_err("the keyring is not available");
    assert!(matches!(err, AuthError::StorageUnavailable { backend: "keyring" }));
    assert!(!store.path().exists(), "a keyring request silently wrote a file");
}

#[test]
fn availability_is_known_before_anything_is_saved() {
    let dir = tempfile::tempdir().expect("a temporary directory");

    let file = TokenStore::in_dir(dir.path(), StorageBackend::File);
    file.check_available().expect("the file backend is available");

    let keyring = TokenStore::in_dir(dir.path(), StorageBackend::Keyring);
    let err = keyring.check_available().expect_err("the keyring is not available");
    assert!(matches!(err, AuthError::StorageUnavailable { backend: "keyring" }));
}

#[test]
fn a_session_never_renders_its_tokens_through_debug() {
    let rendered = format!("{:?}", session());
    assert!(!rendered.contains("access-abc"), "an access token leaked: {rendered}");
    assert!(!rendered.contains("refresh-xyz"), "a refresh token leaked: {rendered}");
    assert!(rendered.contains("client-123"), "the client id is not secret");
}

#[test]
fn refresh_is_due_only_inside_the_skew_window() {
    let session = session();
    let expires_at = 1_800_000_000u64;

    assert!(!session.needs_refresh(expires_at - 120, 60), "renewed far too early");
    assert!(session.needs_refresh(expires_at - 60, 60), "a token expiring mid-request is stale");
    assert!(session.needs_refresh(expires_at - 30, 60));
    assert!(session.needs_refresh(expires_at + 1, 60));
}

#[test]
fn a_token_with_no_stated_expiry_is_used_until_it_is_refused() {
    let mut session = session();
    session.tokens.expires_at = None;
    assert!(!session.needs_refresh(u64::MAX, 60));
}

#[test]
fn the_config_directory_can_be_overridden_outright() {
    let dir = config_dir_from(|name| (name == CONFIG_DIR_VAR).then(|| "/scratch/prick".to_owned()))
        .expect("the override always resolves");
    assert_eq!(dir, PathBuf::from("/scratch/prick"));
}

#[test]
fn an_empty_override_falls_through_to_the_platform_default() {
    let resolved = config_dir_from(|name| {
        Some(match name {
            CONFIG_DIR_VAR => String::new(),
            "HOME" => "/home/u".to_owned(),
            "LOCALAPPDATA" => r"C:\Users\u\AppData\Local".to_owned(),
            _ => return None,
        })
    })
    .expect("the platform default resolves");
    assert!(resolved.ends_with("prick"), "{resolved:?}");
}

#[test]
fn a_container_with_no_home_reports_why_rather_than_panicking() {
    let err = config_dir_from(|_| None).expect_err("nothing to resolve from");
    assert!(matches!(err, AuthError::Store { operation: "locate", .. }));
}

/// A store with a roaming directory beside its local one, the shape
/// [`TokenStore::new`] builds on Windows.
fn roaming_store() -> (tempfile::TempDir, TokenStore, TokenStore) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let roaming =
        TokenStore::in_dir(dir.path().join("Roaming").join("prick"), StorageBackend::File);
    let store = TokenStore {
        roaming: Some(roaming.dir().to_path_buf()),
        ..TokenStore::in_dir(dir.path().join("Local").join("prick"), StorageBackend::File)
    };
    (dir, store, roaming)
}

#[test]
fn a_roaming_session_is_moved_to_the_local_directory_on_first_read() {
    let (_dir, store, roaming) = roaming_store();
    roaming.save(&session()).expect("a session from before the move");

    let loaded = store.load().expect("load").expect("the roaming session is found");
    assert_eq!(loaded.tokens.access_token.expose_secret(), "access-abc");

    assert!(store.path().exists(), "the session was not written locally");
    assert!(!roaming.path().exists(), "the roaming copy survived the move");
    assert!(store.is_owner_only().expect("readable"), "the moved file is not owner-only");
}

#[test]
fn a_local_session_wins_over_a_roaming_one() {
    let (_dir, store, roaming) = roaming_store();
    roaming.save(&session()).expect("save roaming");

    let mut local = session();
    local.tokens.access_token = SecretString::from("access-local");
    store.save(&local).expect("save local");

    let loaded = store.load().expect("load").expect("a session");
    assert_eq!(loaded.tokens.access_token.expose_secret(), "access-local");
}

#[test]
fn saving_locally_deletes_a_stale_roaming_copy() {
    let (_dir, store, roaming) = roaming_store();
    roaming.save(&session()).expect("save roaming");

    store.save(&session()).expect("save local");
    assert!(!roaming.path().exists(), "a superseded token was left on the roaming profile");
}

#[test]
fn logging_out_removes_the_roaming_copy_too() {
    let (_dir, store, roaming) = roaming_store();
    roaming.save(&session()).expect("save roaming");

    store.clear().expect("clear");
    assert!(!roaming.path().exists(), "logout left a token on the roaming profile");
    assert!(store.load().expect("load").is_none());
}

#[test]
fn a_corrupt_roaming_copy_is_reported_rather_than_treated_as_absent() {
    let (_dir, store, roaming) = roaming_store();
    roaming.save(&session()).expect("save roaming");
    std::fs::write(roaming.path(), b"not json at all").expect("write");

    let err = store.load().expect_err("a corrupt file is not an absent one");
    assert!(matches!(err, AuthError::Store { operation: "parse", .. }));
}

#[test]
fn the_roaming_directory_is_never_consulted_under_an_override() {
    let found = roaming_config_dir_from(|name| match name {
        CONFIG_DIR_VAR => Some("/scratch/prick".to_owned()),
        "APPDATA" => Some(r"C:\Users\u\AppData\Roaming".to_owned()),
        _ => None,
    });
    assert!(found.is_none(), "{found:?}");
}

#[cfg(windows)]
#[test]
fn the_windows_default_is_the_local_profile_with_the_roaming_one_to_migrate_from() {
    let lookup = |name: &str| match name {
        "APPDATA" => Some(r"C:\Users\u\AppData\Roaming".to_owned()),
        "LOCALAPPDATA" => Some(r"C:\Users\u\AppData\Local".to_owned()),
        _ => None,
    };
    assert_eq!(
        config_dir_from(lookup).expect("resolves"),
        PathBuf::from(r"C:\Users\u\AppData\Local\prick")
    );
    assert_eq!(
        roaming_config_dir_from(lookup),
        Some(PathBuf::from(r"C:\Users\u\AppData\Roaming\prick"))
    );
}

#[cfg(not(windows))]
#[test]
fn only_windows_has_a_roaming_directory() {
    let found = roaming_config_dir_from(|name| match name {
        "APPDATA" => Some("/home/u/AppData/Roaming".to_owned()),
        "HOME" => Some("/home/u".to_owned()),
        _ => None,
    });
    assert!(found.is_none(), "{found:?}");
}

#[cfg(unix)]
#[test]
fn the_platform_default_follows_the_xdg_specification() {
    let resolved = config_dir_from(|name| match name {
        "HOME" => Some("/home/u".to_owned()),
        "XDG_CONFIG_HOME" => Some("/home/u/.cfg".to_owned()),
        _ => None,
    })
    .expect("resolves");

    if cfg!(target_os = "macos") {
        assert!(resolved.starts_with("/home/u/Library"), "{resolved:?}");
    } else {
        assert_eq!(resolved, PathBuf::from("/home/u/.cfg/prick"));
    }
}

#[cfg(unix)]
#[test]
fn the_directory_is_created_with_owner_only_permissions() {
    use std::os::unix::fs::PermissionsExt as _;

    let (_dir, store) = store();
    store.save(&session()).expect("save");

    let mode = std::fs::metadata(store.dir()).expect("metadata").permissions().mode();
    assert_eq!(mode & 0o777, TOKEN_DIR_MODE, "the directory is not 0700");

    let mode = std::fs::metadata(store.path()).expect("metadata").permissions().mode();
    assert_eq!(mode & 0o777, TOKEN_FILE_MODE, "the credentials file is not 0600");
}

#[cfg(unix)]
#[test]
fn a_pre_existing_loose_directory_is_tightened() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().expect("a temporary directory");
    let target = dir.path().join("prick");
    std::fs::create_dir(&target).expect("create");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let store = TokenStore::in_dir(&target, StorageBackend::File);
    store.save(&session()).expect("save");

    let mode = std::fs::metadata(&target).expect("metadata").permissions().mode();
    assert_eq!(mode & 0o777, TOKEN_DIR_MODE, "a world-readable directory was left alone");
}

#[cfg(unix)]
#[test]
fn a_loose_file_is_reported_as_a_finding() {
    use std::os::unix::fs::PermissionsExt as _;

    let (_dir, store) = store();
    store.save(&session()).expect("save");
    std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o644)).expect("chmod");

    assert!(!store.is_owner_only().expect("readable"), "0644 was not reported as a finding");
}

#[test]
fn an_operator_named_file_is_owner_only_and_replaces_what_was_there() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let target = dir.path().join("client-secret");
    std::fs::write(&target, b"the previous secret").expect("an existing file");

    write_owner_only_file(&target, b"the new secret").expect("the write succeeds");

    assert_eq!(std::fs::read(&target).expect("readable"), b"the new secret");
    assert!(is_path_owner_only(&target).expect("metadata"), "the secret file is owner-only");
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .expect("listable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "no temporary file is left behind: {leftovers:?}");
}

#[test]
fn an_operator_named_file_leaves_its_directory_alone() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let before = is_path_owner_only(dir.path()).expect("metadata");

    write_owner_only_file(&dir.path().join("secret"), b"x").expect("the write succeeds");

    assert_eq!(
        is_path_owner_only(dir.path()).expect("metadata"),
        before,
        "the directory's permissions are the operator's, not this function's"
    );
}

#[test]
fn an_operator_named_file_in_a_missing_directory_fails_without_creating_it() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let missing = dir.path().join("absent");
    let err = write_owner_only_file(&missing.join("secret"), b"x").expect_err("no directory");
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    assert!(!missing.exists());
}

/// `--secret-file` into a directory whose new files inherit an `Everyone` read
/// entry: the secret file carries the owner's entry alone, protected, and no
/// temporary file is left behind under any name.
#[cfg(windows)]
#[test]
fn an_operator_named_file_ignores_a_directory_that_grants_everyone_read() {
    use prick_exec::winsec::{current_user_sid_string, dacl_sddl};

    let dir = tempfile::tempdir().expect("a temporary directory");
    let granted = std::process::Command::new("icacls")
        .arg(dir.path())
        .args(["/grant", "*S-1-1-0:(OI)(CI)(R)"])
        .output()
        .expect("icacls runs");
    assert!(granted.status.success(), "icacls failed: {granted:?}");

    let control = dir.path().join("control");
    std::fs::write(&control, b"x").expect("write");
    let inherited = dacl_sddl(&control).expect("the control's DACL");
    assert!(inherited.contains("ID;") && inherited.contains(";WD)"), "{inherited}");
    std::fs::remove_file(&control).expect("remove the control");

    let target = dir.path().join("client-secret");
    write_owner_only_file(&target, b"the secret").expect("the write succeeds");

    let sid = current_user_sid_string().expect("the process has a user");
    assert_eq!(dacl_sddl(&target).expect("the secret's DACL"), format!("D:P(A;;FA;;;{sid})"));
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .expect("listable")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["client-secret"], "only the secret file remains");
}

#[test]
fn temporary_names_are_unpredictable() {
    let first = random_suffix().expect("randomness");
    let second = random_suffix().expect("randomness");
    assert_eq!(first.len(), 32);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()), "{first}");
    assert_ne!(first, second);
}
