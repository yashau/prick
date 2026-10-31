use super::*;

const ACME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn names_follow_the_slug_grammar() {
    for good in ["default", "acme", "acme-eu-2"] {
        assert!(is_profile_name(good), "{good}");
    }
    for bad in ["", "Acme", "acme_eu", "-acme", "acme-", "a--b", "..", "a/b", "a b"] {
        assert!(!is_profile_name(bad), "{bad}");
    }
}

#[test]
fn instance_ids_and_credential_refs_have_fixed_shapes() {
    assert!(is_instance_id(ACME));
    assert!(!is_instance_id(&ACME.to_uppercase()));
    assert!(!is_instance_id(&ACME[1..]));
    assert!(is_credential_ref(LEGACY_CREDENTIAL));
    assert!(is_credential_ref("0123456789abcdef"));
    for bad in ["../credentials.json", "0123456789ABCDEF", "x.json", ""] {
        assert!(!is_credential_ref(bad), "{bad}");
    }
}

#[test]
fn urls_must_be_https_or_loopback_and_carry_no_userinfo() {
    assert_eq!(validate_url("https://prick.example.com/").unwrap(), "https://prick.example.com");
    for loopback in
        ["http://localhost:8787", "http://127.0.0.1:7788", "http://[::1]:1", "http://app.localhost"]
    {
        assert!(validate_url(loopback).is_ok(), "{loopback}");
    }
    assert!(matches!(validate_url("http://prick.example.com"), Err(UrlError::Insecure { .. })));
    assert!(matches!(
        validate_url("https://u:p@prick.example.com"),
        Err(UrlError::Userinfo { .. })
    ));
    for malformed in ["prick.example.com", "ftp://x", "https://"] {
        assert!(matches!(validate_url(malformed), Err(UrlError::Malformed { .. })), "{malformed}");
    }
}

#[test]
fn the_host_is_what_every_display_shows_beside_a_name() {
    assert_eq!(host_of("https://Prick.Example.com:8443/x"), "prick.example.com");
    assert_eq!(host_of("http://[::1]:1"), "::1");
    assert_eq!(short_instance(ACME), "aaaaaaaa");
}

#[test]
fn a_pre_profiles_install_reads_as_one_default_profile_on_the_legacy_file() {
    let config =
        Config::from_legacy("https://prick.example.com/", "https://t.cloudflareaccess.com");
    assert_eq!(config.default_profile.as_deref(), Some(DEFAULT_NAME));
    let profile = &config.profiles[DEFAULT_NAME];
    assert_eq!(profile.api_url, "https://prick.example.com");
    assert_eq!(profile.credential, LEGACY_CREDENTIAL);
    assert_eq!(profile.issuer.as_deref(), Some("https://t.cloudflareaccess.com"));
    assert_eq!(profile.instance, None);
    config.validate().expect("the legacy shape is a valid configuration");
}

#[test]
fn validation_catches_what_a_hand_edit_gets_wrong() {
    let mut config = Config::from_legacy("https://a.example", "");
    config.version = 2;
    assert_eq!(config.validate(), Err(ConfigError::Version { found: 2 }));

    let mut config = Config::from_legacy("https://a.example", "");
    config.default_profile = Some("nope".to_owned());
    assert!(matches!(config.validate(), Err(ConfigError::MissingDefault { .. })));

    let mut config = Config::from_legacy("https://a.example", "");
    config.profiles.get_mut(DEFAULT_NAME).unwrap().credential = "../../etc/passwd".to_owned();
    assert!(matches!(config.validate(), Err(ConfigError::Field { field: "credential", .. })));

    let mut config = Config::from_legacy("https://a.example", "");
    let copy = config.profiles[DEFAULT_NAME].clone();
    config.profiles.insert("other".to_owned(), copy);
    assert!(matches!(config.validate(), Err(ConfigError::SharedCredential { .. })));

    let mut config = Config::from_legacy("https://a.example", "");
    config.profiles.get_mut(DEFAULT_NAME).unwrap().instance = Some("short".to_owned());
    assert!(matches!(config.validate(), Err(ConfigError::Field { field: "instance", .. })));
}

#[test]
fn an_automatic_name_is_default_first_and_never_a_taken_or_tombstoned_name() {
    let empty = Config::default();
    assert_eq!(empty.auto_name("https://prick.example.com"), DEFAULT_NAME);

    let one = Config::from_legacy("https://prick.example.com", "");
    assert_eq!(one.auto_name("https://prick-staging.example.com"), "prick-staging-example-com");

    let mut taken = one.clone();
    taken.profiles.insert(
        "prick-staging-example-com".to_owned(),
        Profile::new("https://x", "0000000000000001"),
    );
    taken.renamed.insert(
        "prick-staging-example-com-2".to_owned(),
        Tombstone { to: "x".to_owned(), instance: None },
    );
    assert_eq!(taken.auto_name("https://prick-staging.example.com"), "prick-staging-example-com-3");
}

#[test]
fn a_project_file_must_allow_at_least_one_well_formed_instance() {
    let mut context = ProjectContext {
        path: ".prick.toml".to_owned(),
        file: ProjectFile::default(),
        local_path: None,
        local: None,
    };
    assert!(matches!(context.validate(), Err(ProjectFileError::NoAllow { .. })));

    context.file.allow.push(Allow { instance: "nope".to_owned(), issuer: None });
    assert!(matches!(context.validate(), Err(ProjectFileError::Instance { .. })));

    context.file.allow[0].instance = ACME.to_owned();
    context.validate().expect("one well-formed instance is enough");

    context.file.allow.push(Allow { instance: "b".repeat(32), issuer: None });
    context.file.profile = Some("acme".to_owned());
    assert!(matches!(context.validate(), Err(ProjectFileError::ChoiceInSharedFile { .. })));
}

#[test]
fn a_local_file_cannot_select_a_deployment_the_project_does_not_allow() {
    let context = ProjectContext {
        path: ".prick.toml".to_owned(),
        file: ProjectFile {
            allow: vec![Allow { instance: ACME.to_owned(), issuer: None }],
            project: Some("api".to_owned()),
            ..ProjectFile::default()
        },
        local_path: Some(".prick.local.toml".to_owned()),
        local: Some(LocalFile {
            instance: Some("c".repeat(32)),
            env: Some("staging".to_owned()),
            ..LocalFile::default()
        }),
    };
    assert!(matches!(context.validate(), Err(ProjectFileError::LocalNotAllowed { .. })));

    let mut allowed = context.clone();
    allowed.local.as_mut().unwrap().instance = Some(ACME.to_owned());
    allowed.validate().unwrap();
    assert_eq!(allowed.project(), Some("api"));
    assert_eq!(allowed.env(), Some("staging"), "the local file overrides the committed one");
}
