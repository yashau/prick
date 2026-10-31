use super::*;
use crate::profile::edit;
use crate::profile::project::{Allow, LocalFile, ProjectFile};
use crate::profile::{Config, Profile};

const ACME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GLOBEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn profile(url: &str, credential: &str, instance: Option<&str>) -> Profile {
    Profile { instance: instance.map(str::to_owned), ..Profile::new(url, credential) }
}

/// Two organisations running the same application: identical in everything a
/// request carries except the instance each server reports.
fn config() -> Config {
    let config = edit::add(
        &Config::default(),
        "acme",
        profile("https://prick.acme.example", "0000000000000001", Some(ACME)),
        true,
        false,
    )
    .unwrap();
    edit::add(
        &config,
        "globex",
        profile("https://prick.globex.example", "0000000000000002", Some(GLOBEX)),
        false,
        false,
    )
    .unwrap()
}

fn inputs(config: &Config) -> SelectInputs<'_> {
    SelectInputs {
        flag_profile: None,
        flag_url: None,
        env_profile: None,
        env_url: None,
        project: None,
        config,
    }
}

fn project(allow: &[&str], profile: Option<&str>, local: Option<LocalFile>) -> ProjectContext {
    ProjectContext {
        path: "/src/app/.prick.toml".to_owned(),
        file: ProjectFile {
            profile: profile.map(str::to_owned),
            allow: allow
                .iter()
                .map(|instance| Allow { instance: (*instance).to_owned(), issuer: None })
                .collect(),
            ..ProjectFile::default()
        },
        local_path: local.as_ref().map(|_| "/src/app/.prick.local.toml".to_owned()),
        local,
    }
}

fn named(selection: &Selection) -> (&str, Source) {
    match selection {
        Selection::Profile { name, source } => (name, *source),
        other @ Selection::Url { .. } => panic!("expected a profile, got {other:?}"),
    }
}

#[test]
fn with_nothing_else_the_default_is_used() {
    let config = config();
    let selection = select(&inputs(&config)).unwrap();
    assert_eq!(named(&selection), ("acme", Source::Default));
    assert!(!selection.source().is_deliberate());
}

#[test]
fn both_forms_at_one_tier_are_refused_rather_than_guessed() {
    let config = config();
    let mut flags = inputs(&config);
    flags.flag_profile = Some("acme");
    flags.flag_url = Some("https://x.example");
    assert_eq!(
        select(&flags).unwrap_err(),
        SelectError::Conflict { first: "--profile", second: "--api-url" }
    );

    let mut env = inputs(&config);
    env.env_profile = Some("acme");
    env.env_url = Some("https://x.example");
    assert_eq!(
        select(&env).unwrap_err(),
        SelectError::Conflict { first: "PRK_PROFILE", second: "PRK_API_URL" }
    );
}

#[test]
fn a_higher_tier_wins_outright() {
    let config = config();
    let mut both = inputs(&config);
    both.flag_profile = Some("globex");
    both.env_url = Some("https://prick.acme.example");
    assert_eq!(named(&select(&both).unwrap()), ("globex", Source::Flag));

    let mut url_over_env = inputs(&config);
    url_over_env.flag_url = Some("https://prick.globex.example/");
    url_over_env.env_profile = Some("acme");
    assert_eq!(
        select(&url_over_env).unwrap(),
        Selection::Url {
            url: "https://prick.globex.example".to_owned(),
            source: Source::Flag,
            profile: Some("globex".to_owned()),
        }
    );
}

#[test]
fn empty_values_count_as_unset() {
    let config = config();
    let mut blank = inputs(&config);
    blank.env_profile = Some("");
    blank.env_url = Some("  ");
    assert_eq!(named(&select(&blank).unwrap()), ("acme", Source::Default));
}

#[test]
fn an_unknown_name_is_refused_and_lists_what_exists() {
    let config = config();
    let mut unknown = inputs(&config);
    unknown.env_profile = Some("initech");
    let err = select(&unknown).unwrap_err();
    assert_eq!(
        err,
        SelectError::Unknown {
            name: "initech".to_owned(),
            known: vec!["acme".to_owned(), "globex".to_owned()],
        }
    );
    assert!(err.to_string().contains("acme, globex"));
}

#[test]
fn a_renamed_name_names_its_successor_instead_of_falling_through() {
    let config = edit::rename(&config(), "acme", "acme-eu").unwrap();
    let mut old = inputs(&config);
    old.flag_profile = Some("acme");
    assert_eq!(
        select(&old).unwrap_err(),
        SelectError::Renamed { name: "acme".to_owned(), to: "acme-eu".to_owned() }
    );
}

#[test]
fn a_url_with_no_profile_is_used_bare_and_one_shared_by_two_profiles_is_refused() {
    let config = config();
    let mut bare = inputs(&config);
    bare.env_url = Some("https://other.example");
    assert_eq!(
        select(&bare).unwrap(),
        Selection::Url {
            url: "https://other.example".to_owned(),
            source: Source::Environment,
            profile: None,
        }
    );

    let config = edit::add(
        &config,
        "acme-breakglass",
        profile("https://prick.acme.example", "0000000000000003", Some(ACME)),
        false,
        false,
    )
    .unwrap();
    let mut shared = inputs(&config);
    shared.env_url = Some("https://prick.acme.example");
    assert!(matches!(select(&shared), Err(SelectError::AmbiguousUrl { .. })));
}

#[test]
fn a_project_file_selects_the_profile_pinned_to_its_instance_whatever_it_is_called() {
    let config = edit::rename(&config(), "globex", "client-two").unwrap();
    let project = project(&[GLOBEX], None, None);
    let mut with_project = inputs(&config);
    with_project.project = Some(&project);
    assert_eq!(named(&select(&with_project).unwrap()), ("client-two", Source::ProjectFile));
}

#[test]
fn a_project_file_whose_instance_nobody_pins_falls_through_to_the_default() {
    // The default is then held to the allow list once the server reports its
    // instance, so trying it sends nothing anywhere it should not go.
    let config = config();
    let project = project(&["cccccccccccccccccccccccccccccccc"], None, None);
    let mut with_project = inputs(&config);
    with_project.project = Some(&project);
    assert_eq!(named(&select(&with_project).unwrap()), ("acme", Source::Default));
}

#[test]
fn a_project_file_listing_several_deployments_does_not_choose() {
    let config = config();
    let project = project(&[ACME, GLOBEX], None, None);
    let mut with_project = inputs(&config);
    with_project.project = Some(&project);
    assert_eq!(named(&select(&with_project).unwrap()), ("acme", Source::Default));
}

#[test]
fn the_local_file_chooses_among_several_deployments_by_instance() {
    let config = config();
    let local = LocalFile { instance: Some(GLOBEX.to_owned()), ..LocalFile::default() };
    let project = project(&[ACME, GLOBEX], None, Some(local));
    let mut with_project = inputs(&config);
    with_project.project = Some(&project);
    assert_eq!(named(&select(&with_project).unwrap()), ("globex", Source::LocalFile));
}

#[test]
fn a_local_file_naming_an_instance_nobody_pins_is_refused() {
    let config = config();
    let unpinned = "cccccccccccccccccccccccccccccccc";
    let local = LocalFile { instance: Some(unpinned.to_owned()), ..LocalFile::default() };
    let project = project(&[ACME, unpinned], None, Some(local));
    let mut with_project = inputs(&config);
    with_project.project = Some(&project);
    assert!(matches!(select(&with_project), Err(SelectError::NoProfileForInstance { .. })));
}

#[test]
fn two_profiles_on_one_deployment_need_a_tie_breaker() {
    let config = edit::add(
        &config(),
        "acme-breakglass",
        profile("https://prick.acme.example", "0000000000000003", Some(ACME)),
        false,
        false,
    )
    .unwrap();

    let untied = project(&[ACME], None, None);
    let mut ambiguous = inputs(&config);
    ambiguous.project = Some(&untied);
    assert!(matches!(select(&ambiguous), Err(SelectError::AmbiguousInstance { .. })));

    let tied = project(&[ACME], Some("acme-breakglass"), None);
    let mut resolved = inputs(&config);
    resolved.project = Some(&tied);
    assert_eq!(named(&select(&resolved).unwrap()), ("acme-breakglass", Source::ProjectFile));
}

#[test]
fn a_flag_still_wins_over_a_project_file() {
    let config = config();
    let project = project(&[ACME], None, None);
    let mut flagged = inputs(&config);
    flagged.project = Some(&project);
    flagged.flag_profile = Some("globex");
    assert_eq!(named(&select(&flagged).unwrap()), ("globex", Source::Flag));
}

#[test]
fn nothing_configured_says_whether_any_profile_exists() {
    let empty = Config::default();
    assert_eq!(select(&inputs(&empty)).unwrap_err(), SelectError::Nothing { has_profiles: false });

    let (no_default, _) = edit::remove(&config(), "acme").unwrap();
    assert_eq!(
        select(&inputs(&no_default)).unwrap_err(),
        SelectError::Nothing { has_profiles: true }
    );
}

#[test]
fn a_committed_project_file_selects_but_does_not_count_as_a_deliberate_choice_for_writes() {
    for (source, deliberate) in [
        (Source::Flag, true),
        (Source::Environment, true),
        (Source::LocalFile, true),
        (Source::ProjectFile, false),
        (Source::Default, false),
    ] {
        assert_eq!(source.is_deliberate(), deliberate, "{source:?}");
    }
}

#[test]
fn only_the_flag_and_environment_tiers_may_carry_an_environment_service_token() {
    for (source, allowed) in [
        (Source::Flag, true),
        (Source::Environment, true),
        (Source::LocalFile, false),
        (Source::ProjectFile, false),
        (Source::Default, false),
    ] {
        assert_eq!(source.may_pair_env_token(), allowed, "{source:?}");
    }
}
