use secrecy::SecretString;

use super::*;
use crate::store::{StoredSession, Tokens};
use prick_core::profile::{DEFAULT_NAME, LEGACY_CREDENTIAL, edit};

fn session(url: &str, token: &str) -> StoredSession {
    StoredSession {
        api_url: url.to_owned(),
        issuer: "https://acme.cloudflareaccess.com".to_owned(),
        client_id: "client-1".to_owned(),
        token_endpoint: "https://acme.cloudflareaccess.com/token".to_owned(),
        resource: None,
        revocation_endpoint: None,
        tokens: Tokens {
            access_token: SecretString::from(token.to_owned()),
            refresh_token: None,
            expires_at: None,
        },
    }
}

/// Every file under a directory with its bytes, for "nothing changed" checks.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push((path.clone(), std::fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

#[test]
fn a_fresh_machine_has_no_profiles_and_reading_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path().join("prick"));
    let loaded = store.load().unwrap();
    assert!(loaded.config.profiles.is_empty());
    assert!(!loaded.persisted);
    assert!(!dir.path().join("prick").exists(), "a read created the configuration directory");
}

#[test]
fn a_pre_profiles_install_reads_as_the_default_profile_and_nothing_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session("https://prick.example.com", "legacy-token")).unwrap();
    let before = snapshot(dir.path());

    let loaded = store.load().unwrap();
    assert!(!loaded.persisted);
    let profile = &loaded.config.profiles[DEFAULT_NAME];
    assert_eq!(profile.api_url, "https://prick.example.com");
    assert_eq!(profile.credential, LEGACY_CREDENTIAL);
    assert_eq!(profile.issuer.as_deref(), Some("https://acme.cloudflareaccess.com"));

    // The profile's store is the legacy file itself.
    let tokens = store.tokens(profile);
    assert_eq!(tokens.path(), dir.path().join(LEGACY_CREDENTIAL));
    assert!(tokens.load().unwrap().is_some());

    assert_eq!(snapshot(dir.path()), before, "reading an old install changed it");
}

#[test]
fn recording_something_new_writes_config_and_keeps_the_legacy_file_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    store.legacy_tokens().save(&session("https://prick.example.com", "legacy-token")).unwrap();
    let legacy_bytes = std::fs::read(dir.path().join(LEGACY_CREDENTIAL)).unwrap();

    store
        .update(|config| -> Result<(), ProfileStoreError> {
            config.profiles.get_mut(DEFAULT_NAME).unwrap().instance = Some("a".repeat(32));
            Ok(())
        })
        .unwrap();

    let loaded = store.load().unwrap();
    assert!(loaded.persisted);
    assert_eq!(loaded.config.profiles[DEFAULT_NAME].credential, LEGACY_CREDENTIAL);
    assert_eq!(
        std::fs::read(dir.path().join(LEGACY_CREDENTIAL)).unwrap(),
        legacy_bytes,
        "the legacy file must stay byte-identical so an older build keeps reading it"
    );
}

#[test]
fn each_profile_has_its_own_file_and_writing_one_leaves_the_other_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    let a = Profile::new("https://a.example", new_credential_id().unwrap());
    let b = Profile::new("https://b.example", new_credential_id().unwrap());
    store.tokens(&a).save(&session("https://a.example", "token-a")).unwrap();
    store.tokens(&b).save(&session("https://b.example", "token-b")).unwrap();
    let b_bytes = std::fs::read(store.tokens(&b).path()).unwrap();

    store.tokens(&a).save(&session("https://a.example", "token-a-renewed")).unwrap();

    assert_eq!(std::fs::read(store.tokens(&b).path()).unwrap(), b_bytes);
    assert!(store.tokens(&a).path().starts_with(dir.path().join("credentials")));
    assert_ne!(store.tokens(&a).path(), store.tokens(&b).path());
    assert!(store.tokens(&a).is_owner_only().unwrap());
}

#[test]
fn credential_ids_are_random_and_well_formed() {
    let first = new_credential_id().unwrap();
    let second = new_credential_id().unwrap();
    assert_ne!(first, second);
    assert!(prick_core::profile::is_credential_ref(&first));
}

#[test]
fn a_rename_is_one_config_write_and_moves_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    let profile = Profile::new("https://a.example", new_credential_id().unwrap());
    store.tokens(&profile).save(&session("https://a.example", "token-a")).unwrap();
    store
        .update(|config| -> Result<(), ProfileStoreError> {
            *config = edit::add(config, "prod", profile.clone(), false, false).unwrap();
            Ok(())
        })
        .unwrap();
    let credential_bytes = std::fs::read(store.tokens(&profile).path()).unwrap();

    store
        .update(|config| -> Result<(), ProfileStoreError> {
            *config = edit::rename(config, "prod", "acme").unwrap();
            Ok(())
        })
        .unwrap();

    let config = store.load().unwrap().config;
    let renamed = &config.profiles["acme"];
    assert_eq!(std::fs::read(store.tokens(renamed).path()).unwrap(), credential_bytes);
    assert_eq!(config.renamed["prod"].to, "acme");
}

#[test]
fn concurrent_changes_under_the_lock_all_persist() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    let handles: Vec<_> = (0..8)
        .map(|n| {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .update(|config| -> Result<(), ProfileStoreError> {
                        let profile = Profile::new(
                            format!("https://s{n}.example"),
                            new_credential_id().unwrap(),
                        );
                        *config =
                            edit::add(config, &format!("s{n}"), profile, false, false).unwrap();
                        Ok(())
                    })
                    .unwrap();
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(store.load().unwrap().config.profiles.len(), 8, "a concurrent change was lost");
    assert!(!dir.path().join("config.toml.lock").exists(), "the lock outlived the change");
}

#[test]
fn a_config_from_a_newer_build_is_refused_as_that() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(CONFIG_FILE_NAME),
        "version = 9\n[profiles.x]\nshape = \"new\"\n",
    )
    .unwrap();
    let err = ProfileStore::in_dir(dir.path()).load().unwrap_err();
    assert!(err.to_string().contains("newer prk"), "{err}");
}

#[test]
fn unknown_keys_in_config_are_tolerated_but_a_bad_value_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CONFIG_FILE_NAME);
    std::fs::write(
        &path,
        "version = 1\nfuture = true\n[profiles.a]\napi_url = \"https://a.example\"\ncredential = \"0000000000000001\"\n",
    )
    .unwrap();
    ProfileStore::in_dir(dir.path()).load().expect("an unknown key from a slightly newer build");

    std::fs::write(
        &path,
        "version = 1\n[profiles.a]\napi_url = \"https://a.example\"\ncredential = \"../../x\"\n",
    )
    .unwrap();
    assert!(matches!(
        ProfileStore::in_dir(dir.path()).load(),
        Err(ProfileStoreError::Invalid { .. })
    ));
}

#[test]
fn the_written_config_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::in_dir(dir.path());
    let mut profile = Profile::new("https://a.example", "0000000000000001");
    profile.instance = Some("a".repeat(32));
    profile.project = Some("api".to_owned());
    store
        .update(|config| -> Result<(), ProfileStoreError> {
            *config = edit::add(config, "acme", profile.clone(), true, false).unwrap();
            Ok(())
        })
        .unwrap();
    let text = std::fs::read_to_string(store.config_path()).unwrap();
    assert!(text.starts_with("# prick CLI profiles"), "{text}");
    assert_eq!(store.load().unwrap().config.profiles["acme"], profile);
}

#[test]
fn the_project_search_stops_at_the_repository_root() {
    let dir = tempfile::tempdir().unwrap();
    let outer = dir.path();
    std::fs::write(
        outer.join(PROJECT_FILE_NAME),
        "[[allow]]\ninstance = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\n",
    )
    .unwrap();
    let repo = outer.join("repo");
    let nested = repo.join("src").join("deep");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir(repo.join(".git")).unwrap();

    assert!(
        find_project(&nested, None).unwrap().is_none(),
        "a file above the repository root selected a server for it"
    );

    std::fs::write(
        repo.join(PROJECT_FILE_NAME),
        "[[allow]]\ninstance = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"\n",
    )
    .unwrap();
    std::fs::write(repo.join(LOCAL_FILE_NAME), "env = \"staging\"\n").unwrap();
    let found = find_project(&nested, None).unwrap().expect("the repository's own file");
    assert_eq!(found.dir, repo);
    assert_eq!(found.context.file.allow[0].instance, "b".repeat(32));
    assert_eq!(found.context.local.unwrap().env.as_deref(), Some("staging"));
}

#[test]
fn the_project_search_stops_at_home() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let work = home.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        dir.path().join(PROJECT_FILE_NAME),
        "[[allow]]\ninstance = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\n",
    )
    .unwrap();
    assert!(find_project(&work, Some(&home)).unwrap().is_none());
}

#[test]
fn a_project_file_cannot_carry_a_url() {
    let err = parse_project_file(
        "url = \"https://evil.example\"\n[[allow]]\ninstance = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\n",
        Path::new(".prick.toml"),
    )
    .unwrap_err();
    assert!(err.to_string().contains("url"), "{err}");
    assert!(parse_project_file("api_url = \"x\"\n", Path::new(".prick.toml")).is_err());
}
