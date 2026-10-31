//! Which server this invocation talks to, and the checks that hold it there.
//!
//! # One invocation, one server
//!
//! A [`Target`] is resolved once, before any request, and the [`Context`] built
//! from it has no way to change its URL or its token store afterwards. There is
//! no command that reads from one profile and writes to another; moving values
//! between deployments takes two commands, each of which passes every check
//! here on its own.
//!
//! # The checks, in the order they run
//!
//! Before a credential is resolved:
//!
//! - a write, with more than one profile configured, must have been aimed
//!   deliberately: by a flag, an environment variable or this checkout's
//!   `.prick.local.toml`, not by the default or a committed `.prick.toml`
//!   alone;
//! - a service token, with more than one profile configured, pairs only with a
//!   server chosen by a flag or the environment, and only with the client id
//!   the profile expects, if it records one;
//! - a profile already pinned to an instance the project file does not allow,
//!   or other than `--expect-instance`, is refused without a request.
//!
//! After the credential is attached, and before the command's own first
//! request, the server is asked who it is (`/whoami`, which carries no secret).
//! Its instance id must match the profile's pin, `--expect-instance` and the
//! project's allow list. A profile with no pin yet is pinned to what the
//! server reports: the trust is the same the user gave when they signed in to
//! that URL.
//!
//! An invocation addressed purely by URL, with no profile for it, no
//! expectation and no project file, sends no extra request: that is the CI
//! shape, and it behaves exactly as it always has.
//!
//! [`Context`]: crate::commands::Context

use std::path::{Path, PathBuf};

use prick_auth::ServiceToken;
use prick_auth::profiles::{FoundProject, ProfileStore, ProfileStoreError, find_project};
use prick_core::classify::{EXIT_FAILURE, EXIT_USAGE, ErrorKind};
use prick_core::profile::{
    EditError, LEGACY_CREDENTIAL, Profile, ProjectFileError, SelectError, SelectInputs, Selection,
    Source, UrlError, host_of, is_instance_id, short_instance,
};

use crate::cli::GlobalArgs;

/// The environment variable naming a profile.
pub const PROFILE_VAR: &str = "PRK_PROFILE";

/// The environment variable naming a server URL.
pub const API_URL_VAR: &str = "PRK_API_URL";

/// The environment variable naming the instance a run must reach.
pub const EXPECT_INSTANCE_VAR: &str = "PRK_EXPECT_INSTANCE";

/// Why the server could not be chosen, or was refused.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TargetError {
    /// `config.toml` or a project file could not be read or written.
    #[error(transparent)]
    Store(#[from] ProfileStoreError),

    /// The selection itself failed.
    #[error(transparent)]
    Select(#[from] SelectError),

    /// A change to the profile set was refused.
    #[error(transparent)]
    Edit(#[from] EditError),

    /// A project file is malformed.
    #[error(transparent)]
    Project(#[from] ProjectFileError),

    /// A project file could not be read or parsed, or carries a key it may
    /// not (`url`, for one).
    #[error(transparent)]
    ProjectRead(ProfileStoreError),

    /// A server URL was refused.
    #[error(transparent)]
    Url(#[from] UrlError),

    /// `--expect-instance` is not an instance id.
    #[error("`{value}` is not an instance id (32 lowercase hex digits)")]
    BadExpectation {
        /// The value given.
        value: String,
    },

    /// `.prick.local.toml` is not ignored by git, so it could be committed.
    #[error(
        "{path} is not ignored by git{reason}; add it to .gitignore so this checkout's choice is never committed"
    )]
    LocalNotIgnored {
        /// The file.
        path: String,
        /// Why it could not be confirmed, when git did not say "not ignored".
        reason: String,
    },

    /// A write, with several profiles, selected only by the default.
    #[error(
        "this command changes data, and {count} profiles are configured; name the server with --profile, PRK_PROFILE or .prick.local.toml (`{default}`, chosen by {source_desc}, is not used for writes)"
    )]
    WriteNeedsProfile {
        /// The profile that was selected.
        default: String,
        /// What selected it.
        source_desc: &'static str,
        /// How many profiles exist.
        count: usize,
    },

    /// A service token, with several profiles, and a server not chosen explicitly.
    #[error(
        "a service token is configured, and the server was chosen by {source_desc}; with {count} profiles, pass --profile or --api-url (or PRK_PROFILE / PRK_API_URL) so the token cannot reach the wrong one"
    )]
    TokenNeedsSelection {
        /// What chose the server.
        source_desc: &'static str,
        /// How many profiles exist.
        count: usize,
    },

    /// A service token whose client id the profile does not expect.
    #[error("profile `{profile}` expects service token {expected}, but {found} is configured")]
    ServiceTokenMismatch {
        /// The profile.
        profile: String,
        /// The client id it records.
        expected: String,
        /// The client id that was configured.
        found: String,
    },

    /// The server reports a different instance than the profile is pinned to.
    #[error(
        "{host} is a different deployment than profile `{profile}` is pinned to (expected instance {pinned}, it reports {reported}); nothing beyond the identity check was sent"
    )]
    InstanceMismatch {
        /// The profile.
        profile: String,
        /// The server's host.
        host: String,
        /// The pinned instance.
        pinned: String,
        /// What the server reports.
        reported: String,
    },

    /// The server reports no instance where one is required.
    #[error(
        "{host} reports no instance id, so it cannot be verified against {what}; nothing beyond the identity check was sent"
    )]
    InstanceUnreported {
        /// The server's host.
        host: String,
        /// What required verification.
        what: String,
    },

    /// The server's instance is not on the project's allow list.
    #[error(
        "{path} does not allow instance {instance} ({host}); nothing beyond the identity check was sent"
    )]
    NotAllowed {
        /// The project file.
        path: String,
        /// The instance.
        instance: String,
        /// The server's host.
        host: String,
    },

    /// The server's instance is not the one `--expect-instance` names.
    #[error(
        "{host} reports instance {reported}, not the expected {expected}; nothing beyond the identity check was sent"
    )]
    ExpectMismatch {
        /// The server's host.
        host: String,
        /// The expected instance.
        expected: String,
        /// What the server reports.
        reported: String,
    },

    /// A sign-in went through a different Access organisation than the profile's.
    #[error(
        "{host} now signs in through {found}, but profile `{profile}` was created against {pinned}; nothing was saved"
    )]
    IssuerMismatch {
        /// The profile.
        profile: String,
        /// The server's host.
        host: String,
        /// The pinned issuer.
        pinned: String,
        /// The issuer this sign-in used.
        found: String,
    },
}

impl TargetError {
    /// The process exit code.
    ///
    /// A deployment that is not the one expected is an authentication failure
    /// (3): the server is not who it should be. A selection the operator has
    /// to fix is a usage error (2).
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Store(_) | Self::Select(SelectError::Nothing { .. }) => EXIT_FAILURE,
            Self::InstanceMismatch { .. }
            | Self::InstanceUnreported { .. }
            | Self::NotAllowed { .. }
            | Self::ExpectMismatch { .. }
            | Self::IssuerMismatch { .. } => ErrorKind::Unauthenticated.exit_code(),
            _ => EXIT_USAGE,
        }
    }

    /// The stable code emitted under `--json`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Store(_) => "PROFILE_STORE_FAILED",
            Self::Select(err) => match err {
                SelectError::Conflict { .. } => "SELECTION_CONFLICT",
                SelectError::InvalidName { .. } | SelectError::Unknown { .. } => "PROFILE_UNKNOWN",
                SelectError::Renamed { .. } => "PROFILE_RENAMED",
                SelectError::AmbiguousUrl { .. }
                | SelectError::AmbiguousInstance { .. }
                | SelectError::NoProfileForInstance { .. } => "PROFILE_AMBIGUOUS",
                SelectError::Nothing { .. } => "NO_SERVER",
            },
            Self::Edit(_) => "PROFILE_EDIT_REFUSED",
            Self::Project(_) | Self::ProjectRead(_) | Self::LocalNotIgnored { .. } => {
                "PROJECT_FILE_INVALID"
            }
            Self::Url(_) => "INVALID_URL",
            Self::BadExpectation { .. } => "INVALID_INSTANCE",
            Self::WriteNeedsProfile { .. } => "PROFILE_REQUIRED",
            Self::TokenNeedsSelection { .. } | Self::ServiceTokenMismatch { .. } => {
                "SERVICE_TOKEN_REFUSED"
            }
            Self::InstanceMismatch { .. } | Self::ExpectMismatch { .. } => "INSTANCE_MISMATCH",
            Self::InstanceUnreported { .. } => "INSTANCE_UNVERIFIED",
            Self::NotAllowed { .. } => "INSTANCE_NOT_ALLOWED",
            Self::IssuerMismatch { .. } => "ISSUER_MISMATCH",
        }
    }

    /// The next step.
    pub fn hint(&self) -> Option<&'static str> {
        Some(match self {
            Self::Select(SelectError::Nothing { has_profiles: false }) => {
                "Run `prk login <URL>` once, or pass --api-url <URL> / set PRK_API_URL."
            }
            Self::Select(SelectError::Nothing { has_profiles: true }) => {
                "Pass --profile <NAME>, or choose a default with `prk profile use <NAME>`."
            }
            Self::Select(SelectError::Renamed { .. }) => {
                "Use the new name. A script can pin its deployment with --expect-instance."
            }
            Self::Select(SelectError::Unknown { .. }) => "`prk profile list` shows every profile.",
            Self::InstanceMismatch { .. } | Self::IssuerMismatch { .. } => {
                "If this server was replaced on purpose, remove and re-add the profile: \
                 `prk profile remove <NAME>`, then `prk login <URL>`."
            }
            Self::NotAllowed { .. } => {
                "Choose a profile for a deployment this project allows, or add the instance with \
                 `prk profile pin` if it belongs to the project."
            }
            Self::WriteNeedsProfile { .. } => {
                "`prk profile list` shows the profiles; `prk profile pin --local` records this                  checkout's choice in .prick.local.toml."
            }
            Self::TokenNeedsSelection { .. } => "`prk profile list` shows the profiles.",
            _ => return None,
        })
    }
}

/// The environment variables selection reads, captured once.
#[derive(Debug, Clone, Default)]
pub struct EnvVars {
    /// `PRK_PROFILE`.
    pub profile: Option<String>,
    /// `PRK_API_URL`.
    pub api_url: Option<String>,
    /// `PRK_EXPECT_INSTANCE`.
    pub expect_instance: Option<String>,
}

impl EnvVars {
    /// Reads them from this process's environment.
    pub fn from_process() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self {
            profile: read(PROFILE_VAR),
            api_url: read(API_URL_VAR),
            expect_instance: read(EXPECT_INSTANCE_VAR),
        }
    }
}

/// The server one invocation talks to.
#[derive(Debug, Clone)]
pub struct Target {
    /// How it was chosen.
    pub selection: Selection,
    /// Its URL, normalised.
    pub api_url: String,
    /// The profile whose session and pins apply, if any.
    pub profile: Option<(String, Profile)>,
    /// How many profiles are configured.
    pub profile_count: usize,
    /// The project files in force, already validated.
    pub project: Option<FoundProject>,
    /// The instance `--expect-instance` / `PRK_EXPECT_INSTANCE` demands.
    pub expect_instance: Option<String>,
    /// Where profiles live.
    pub store: ProfileStore,
    /// What the server reported, once verified.
    pub verified_instance: Option<String>,
    /// Whether this run pinned the profile to the instance it reported.
    pub pinned_now: bool,
    /// Things worth telling the operator, printed when the command
    /// authenticates.
    pub notes: Vec<String>,
    /// Things that went wrong without stopping the command, printed as
    /// warnings once the server has been verified.
    pub warnings: Vec<String>,
}

/// Resolves the target from the flags, the environment and the files.
///
/// # Errors
///
/// [`TargetError`] for any refusal, [`prick_auth::AuthError`] if no
/// configuration directory can be found.
pub fn resolve(global: &GlobalArgs) -> Result<Target, crate::error::CliError> {
    let store = ProfileStore::new()?;
    let cwd = std::env::current_dir().ok();
    let home = home_dir();
    Ok(resolve_in(global, &EnvVars::from_process(), cwd.as_deref(), home.as_deref(), store)?)
}

/// [`resolve`], changing nothing on disk.
///
/// For reading the project and environment defaults before a command runs.
/// The command's own resolution is the one that adopts a stray legacy session
/// and reports having done so.
///
/// # Errors
///
/// See [`resolve`].
pub fn peek(global: &GlobalArgs) -> Result<Target, crate::error::CliError> {
    let store = ProfileStore::new()?;
    let cwd = std::env::current_dir().ok();
    let home = home_dir();
    let env = EnvVars::from_process();
    Ok(resolve_with(global, &env, cwd.as_deref(), home.as_deref(), store, false)?)
}

/// [`resolve`] with every input injected, for tests.
///
/// # Errors
///
/// [`TargetError`].
pub fn resolve_in(
    global: &GlobalArgs,
    env: &EnvVars,
    cwd: Option<&Path>,
    home: Option<&Path>,
    store: ProfileStore,
) -> Result<Target, TargetError> {
    resolve_with(global, env, cwd, home, store, true)
}

fn resolve_with(
    global: &GlobalArgs,
    env: &EnvVars,
    cwd: Option<&Path>,
    home: Option<&Path>,
    store: ProfileStore,
    adopt: bool,
) -> Result<Target, TargetError> {
    let mut notes = Vec::new();
    let mut loaded = store.load()?;
    if adopt
        && loaded.persisted
        && let Some(note) = adopt_legacy_session(&store, &loaded.config)?
    {
        notes.push(note);
        loaded = store.load()?;
    }

    let project = match cwd {
        Some(cwd) => find_project(cwd, home).map_err(TargetError::ProjectRead)?,
        None => None,
    };
    if let Some(found) = &project {
        found.context.validate()?;
        check_local_ignored(found)?;
    }

    let selection = prick_core::profile::select::select(&SelectInputs {
        flag_profile: global.profile.as_deref(),
        flag_url: global.api_url.as_deref(),
        env_profile: env.profile.as_deref(),
        env_url: env.api_url.as_deref(),
        project: project.as_ref().map(|found| &found.context),
        config: &loaded.config,
    })?;

    let profile = selection.profile().and_then(|name| {
        loaded.config.profiles.get(name).map(|profile| (name.to_owned(), profile.clone()))
    });
    let api_url = match (&selection, &profile) {
        (Selection::Url { url, .. }, _) => url.clone(),
        (Selection::Profile { .. }, Some((_, profile))) => profile.api_url.clone(),
        (Selection::Profile { name, .. }, None) => {
            return Err(SelectError::Unknown { name: name.clone(), known: Vec::new() }.into());
        }
    };

    let expect_instance = global
        .expect_instance
        .clone()
        .or_else(|| env.expect_instance.clone())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(value) = &expect_instance
        && !is_instance_id(value)
    {
        return Err(TargetError::BadExpectation { value: value.clone() });
    }

    Ok(Target {
        selection,
        api_url,
        profile,
        profile_count: loaded.config.profiles.len(),
        project,
        expect_instance,
        store,
        verified_instance: None,
        pinned_now: false,
        notes,
        warnings: Vec::new(),
    })
}

/// Moves a session an older `prk` wrote into the legacy file to the profile it
/// belongs to.
///
/// An older build knows only `credentials.json`, so its `prk login <other>`
/// replaces the session of whichever profile uses that file with one for
/// another server. The URL check means that session is never sent anywhere
/// but its own server; this puts it where it can be used: into the one
/// profile for that URL that has no session of its own, or into a new
/// profile. A profile that already has a session is never overwritten, and
/// the profile that owned the file is left signed out.
///
/// # Errors
///
/// [`TargetError::Store`] if a file cannot be written.
fn adopt_legacy_session(
    store: &ProfileStore,
    config: &prick_core::profile::Config,
) -> Result<Option<String>, TargetError> {
    let Some((owner, profile)) =
        config.profiles.iter().find(|(_, profile)| uses_legacy_file(profile))
    else {
        return Ok(None);
    };
    let legacy = store.legacy_tokens();
    let Ok(Some(session)) = legacy.load() else {
        return Ok(None);
    };
    if prick_core::profile::same_server(&session.api_url, &profile.api_url) {
        return Ok(None);
    }

    let candidates: Vec<&str> = config
        .profiles_for_url(&session.api_url)
        .into_iter()
        .filter(|name| name != owner)
        .collect();
    let (name, destination) = match candidates.as_slice() {
        [] => {
            let name = config.auto_name(&session.api_url);
            let mut adopted = Profile::new(
                &session.api_url,
                prick_auth::profiles::new_credential_id().map_err(ProfileStoreError::from)?,
            );
            adopted.issuer = Some(session.issuer.clone());
            (name, adopted)
        }
        [one] => {
            let existing = config.profiles[*one].clone();
            if store.tokens(&existing).path().exists() {
                return Ok(None);
            }
            ((*one).to_owned(), existing)
        }
        _ => return Ok(None),
    };

    store.tokens(&destination).save(&session).map_err(ProfileStoreError::from)?;
    store.update(|config| -> Result<(), TargetError> {
        if !config.profiles.contains_key(&name) {
            *config =
                prick_core::profile::edit::add(config, &name, destination.clone(), false, false)?;
        }
        Ok(())
    })?;
    legacy.clear().map_err(ProfileStoreError::from)?;

    Ok(Some(format!(
        "moved the session for {} that an older prk wrote into {LEGACY_CREDENTIAL} to profile `{name}`; \
         profile `{owner}` is signed out (`prk login --profile {owner}`)",
        host_of(&session.api_url)
    )))
}

/// The user's home directory, which bounds the project-file search.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Refuses a `.prick.local.toml` that git would commit.
///
/// Its purpose is to hold one checkout's choice. Committed, it would make that
/// choice for everyone who clones the repository, which is the decision the
/// shared `.prick.toml` is deliberately not allowed to make.
fn check_local_ignored(found: &FoundProject) -> Result<(), TargetError> {
    let Some(local_path) = &found.context.local_path else {
        return Ok(());
    };
    let in_repository = found.dir.ancestors().any(|dir| dir.join(".git").exists());
    if !in_repository {
        return Ok(());
    }
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(&found.dir)
        .args(["check-ignore", "-q", prick_auth::profiles::LOCAL_FILE_NAME])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status.map(|status| status.code()) {
        Ok(Some(0)) => Ok(()),
        Ok(Some(1)) => {
            Err(TargetError::LocalNotIgnored { path: local_path.clone(), reason: String::new() })
        }
        Ok(_) => Err(TargetError::LocalNotIgnored {
            path: local_path.clone(),
            reason: " (git could not confirm it)".to_owned(),
        }),
        Err(err) => Err(TargetError::LocalNotIgnored {
            path: local_path.clone(),
            reason: format!(" (git could not be run: {err})"),
        }),
    }
}

impl Target {
    /// A target for one URL and nothing else: no profile, no project file, no
    /// expectation.
    ///
    /// For `prk login` before the profile exists, and for revoking a session
    /// against the server that issued it.
    pub fn bare(api_url: &str, store: ProfileStore) -> Self {
        let api_url = prick_core::profile::normalize_url(api_url);
        Self {
            selection: Selection::Url { url: api_url.clone(), source: Source::Flag, profile: None },
            api_url,
            profile: None,
            profile_count: 0,
            project: None,
            expect_instance: None,
            store,
            verified_instance: None,
            pinned_now: false,
            notes: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// The server's host, for every message that names it.
    pub fn host(&self) -> String {
        host_of(&self.api_url)
    }

    /// The token store this invocation reads and writes.
    ///
    /// The selected profile's file. With no profile, the legacy file: a session
    /// in it is only ever used for the URL it records, so a bare URL reaches it
    /// only if it is that session's server.
    pub fn tokens(&self) -> prick_auth::TokenStore {
        match &self.profile {
            Some((_, profile)) => self.store.tokens(profile),
            None => self.store.legacy_tokens().clone(),
        }
    }

    /// The project to use when neither a flag nor `PRK_PROJECT` names one.
    pub fn default_project(&self) -> Option<String> {
        self.project
            .as_ref()
            .and_then(|found| found.context.project().map(str::to_owned))
            .or_else(|| self.profile.as_ref().and_then(|(_, profile)| profile.project.clone()))
    }

    /// The environment to use when neither a flag nor `PRK_ENV` names one.
    pub fn default_env(&self) -> Option<String> {
        self.project
            .as_ref()
            .and_then(|found| found.context.env().map(str::to_owned))
            .or_else(|| self.profile.as_ref().and_then(|(_, profile)| profile.env.clone()))
    }

    /// Whether a resolution failure is about a project file, which a command
    /// should hear about before anything else it might complain of.
    pub fn is_project_error(err: &TargetError) -> bool {
        matches!(
            err,
            TargetError::Project(_)
                | TargetError::ProjectRead(_)
                | TargetError::LocalNotIgnored { .. }
        )
    }

    /// Whether the server must be asked who it is before the command runs.
    pub fn needs_verification(&self) -> bool {
        self.profile.is_some() || self.expect_instance.is_some() || self.project.is_some()
    }

    /// Everything that can be refused without a request.
    ///
    /// # Errors
    ///
    /// [`TargetError`] naming the rule.
    pub fn check_before_credentials(
        &self,
        writes: bool,
        token: Option<&ServiceToken>,
    ) -> Result<(), TargetError> {
        let several = self.profile_count >= 2;
        let source = self.selection.source();

        if writes && several && !source.is_deliberate() {
            return Err(TargetError::WriteNeedsProfile {
                default: self.selection.profile().unwrap_or_default().to_owned(),
                source_desc: source.describe(),
                count: self.profile_count,
            });
        }

        if let Some(token) = token {
            if several && !source.may_pair_env_token() {
                return Err(TargetError::TokenNeedsSelection {
                    source_desc: source.describe(),
                    count: self.profile_count,
                });
            }
            if let Some((name, profile)) = &self.profile
                && let Some(expected) = &profile.service_token_client_id
                && token.client_id() != expected
            {
                return Err(TargetError::ServiceTokenMismatch {
                    profile: name.clone(),
                    expected: expected.clone(),
                    found: token.client_id().to_owned(),
                });
            }
        }

        if let Some(pinned) =
            self.profile.as_ref().and_then(|(_, profile)| profile.instance.as_deref())
        {
            self.check_reported(pinned)?;
        }
        Ok(())
    }

    /// Checks what the server reported against every expectation, and pins an
    /// unpinned profile to it.
    ///
    /// # Errors
    ///
    /// [`TargetError`] for any mismatch; nothing has been sent but `/whoami`.
    pub fn verify(&mut self, reported: Option<&str>) -> Result<(), TargetError> {
        let reported = reported.filter(|value| is_instance_id(value));
        let host = self.host();

        if let Some((name, profile)) = &self.profile {
            match (profile.instance.as_deref(), reported) {
                (Some(pinned), Some(reported)) if pinned != reported => {
                    return Err(TargetError::InstanceMismatch {
                        profile: name.clone(),
                        host,
                        pinned: pinned.to_owned(),
                        reported: reported.to_owned(),
                    });
                }
                (Some(_), None) => {
                    return Err(TargetError::InstanceUnreported {
                        host,
                        what: format!("profile `{name}`'s pin"),
                    });
                }
                _ => {}
            }
        }

        if let Some(reported) = reported {
            self.check_reported(reported)?;
        } else if self.expect_instance.is_some() {
            return Err(TargetError::InstanceUnreported {
                host,
                what: "--expect-instance".to_owned(),
            });
        } else if let Some(found) = &self.project {
            return Err(TargetError::InstanceUnreported { host, what: found.context.path.clone() });
        }

        if let (Some(reported), Some((name, profile))) = (reported, &self.profile)
            && profile.instance.is_none()
        {
            self.pin(&name.clone(), &profile.api_url.clone(), reported);
        }
        self.verified_instance = reported.map(str::to_owned);
        Ok(())
    }

    /// Checks one instance id against `--expect-instance` and the allow list.
    fn check_reported(&self, instance: &str) -> Result<(), TargetError> {
        if let Some(expected) = &self.expect_instance
            && expected != instance
        {
            return Err(TargetError::ExpectMismatch {
                host: self.host(),
                expected: expected.clone(),
                reported: instance.to_owned(),
            });
        }
        if let Some(found) = &self.project {
            if !found.context.allows(instance) {
                return Err(TargetError::NotAllowed {
                    path: found.context.path.clone(),
                    instance: instance.to_owned(),
                    host: self.host(),
                });
            }
            let issuer = self.profile.as_ref().and_then(|(_, profile)| profile.issuer.as_deref());
            if let (Some(required), Some(issuer)) =
                (found.context.required_issuer(instance), issuer)
                && required != issuer
            {
                return Err(TargetError::IssuerMismatch {
                    profile: self.selection.profile().unwrap_or_default().to_owned(),
                    host: self.host(),
                    pinned: required.to_owned(),
                    found: issuer.to_owned(),
                });
            }
        }
        Ok(())
    }

    /// Records the first instance a profile's server reports.
    ///
    /// Under the configuration lock, and only if the profile still has the
    /// same URL and still has no pin, so a concurrent change is never
    /// overwritten.
    ///
    /// Saving is best effort. The check this run makes is already done, in
    /// memory, against what the server reported; a configuration directory
    /// that cannot be written (read-only, or a profile file this build cannot
    /// rewrite) costs the pin being recorded, not the command. The failure is
    /// reported through [`Target::warnings`], and the next run tries again.
    fn pin(&mut self, name: &str, api_url: &str, instance: &str) {
        if let Some((_, profile)) = &mut self.profile {
            profile.instance = Some(instance.to_owned());
        }
        let saved = self.store.update(|config| -> Result<(), TargetError> {
            if let Some(profile) = config.profiles.get_mut(name)
                && prick_core::profile::same_server(&profile.api_url, api_url)
                && profile.instance.is_none()
            {
                profile.instance = Some(instance.to_owned());
            }
            Ok(())
        });
        match saved {
            Ok(()) => self.pinned_now = true,
            Err(err) => self.warnings.push(format!(
                "could not record profile `{name}`'s instance pin ({err}); the server was checked for                  this run, and the pin is saved the next time it can be"
            )),
        }
    }

    /// One line naming where a write is going.
    pub fn destination_line(&self) -> String {
        let name = self
            .selection
            .profile()
            .map_or_else(|| "no profile".to_owned(), |name| format!("profile {name}"));
        format!("writing to {} ({name}, {})", self.host(), self.instance_label())
    }

    /// The same, for `--json`.
    pub fn destination_json(&self) -> serde_json::Value {
        serde_json::json!({
            "server": self.host(),
            "profile": self.selection.profile(),
            "instance": self.verified_instance,
        })
    }

    /// `instance 3f9c01ab`, or `instance unverified`.
    pub fn instance_label(&self) -> String {
        let instance = self
            .verified_instance
            .as_deref()
            .or_else(|| self.profile.as_ref().and_then(|(_, profile)| profile.instance.as_deref()));
        match instance {
            Some(id) => format!("instance {}", short_instance(id)),
            None => "instance unverified".to_owned(),
        }
    }
}

/// Whether a profile uses the legacy credential file.
pub fn uses_legacy_file(profile: &Profile) -> bool {
    profile.credential == LEGACY_CREDENTIAL
}

/// Describes a selection source for `prk profile show` and `-v`.
pub fn describe_source(source: Source, target: &Target) -> String {
    match (source, &target.project) {
        (Source::ProjectFile | Source::LocalFile, Some(found)) => {
            let path = if source == Source::LocalFile {
                found.context.local_path.clone().unwrap_or_default()
            } else {
                found.context.path.clone()
            };
            format!("from {path}")
        }
        _ => format!("from {}", source.describe()),
    }
}

#[cfg(test)]
mod tests;
