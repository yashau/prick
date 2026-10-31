//! Which server a command talks to.
//!
//! # Precedence
//!
//! Highest first. Within a tier, the profile form and the URL form together
//! are a refusal, because guessing which one was meant is how a command reaches
//! the wrong server. A higher tier wins outright over a lower one. An empty
//! value counts as unset, so a job can neutralise an inherited variable.
//!
//! | Tier | Profile form | URL form |
//! |---|---|---|
//! | Flag | `--profile NAME` | `--api-url URL` |
//! | Environment | `PRK_PROFILE` | `PRK_API_URL` |
//! | Project | `.prick.local.toml`, then `.prick.toml` (by instance) | -- |
//! | Default | `default_profile` | -- |
//!
//! An unknown profile name is a refusal, never a fall-through to the next tier.
//!
//! A URL form addresses the server directly. If exactly one profile is for
//! that URL its stored session is used; with none, only a service token can
//! authenticate; with several, the caller must say which.

use super::project::ProjectContext;
use super::{Config, is_profile_name, normalize_url};

/// Where a selection came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `--profile` or `--api-url`.
    Flag,
    /// `PRK_PROFILE` or `PRK_API_URL`.
    Environment,
    /// `.prick.local.toml`.
    LocalFile,
    /// `.prick.toml`.
    ProjectFile,
    /// `default_profile` in `config.toml`.
    Default,
}

impl Source {
    /// A short description, for `-v` and `prk profile show`.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Flag => "the command line",
            Self::Environment => "the environment",
            Self::LocalFile => ".prick.local.toml",
            Self::ProjectFile => ".prick.toml",
            Self::Default => "the default profile",
        }
    }

    /// Whether this selection is deliberate enough for a write when more than
    /// one profile exists.
    ///
    /// A flag, an environment variable, or this checkout's own
    /// `.prick.local.toml` is. The default is not: it is whatever was chosen
    /// last, possibly days ago, for some other piece of work. Nor is a
    /// committed `.prick.toml`: it arrives with `git clone`, so it is the
    /// repository author's choice, not the operator's. It still selects for
    /// reads and supplies project and environment defaults.
    pub fn is_deliberate(self) -> bool {
        matches!(self, Self::Flag | Self::Environment | Self::LocalFile)
    }

    /// Whether a service token from the environment may be paired with this
    /// selection when more than one profile exists. Only the flag and
    /// environment tiers qualify: a token in the environment and a server
    /// chosen by a file or a stale default are two decisions that nobody made
    /// together.
    pub fn may_pair_env_token(self) -> bool {
        matches!(self, Self::Flag | Self::Environment)
    }

    /// The identifier used under `--json`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::Environment => "environment",
            Self::LocalFile => "local_file",
            Self::ProjectFile => "project_file",
            Self::Default => "default",
        }
    }
}

/// The outcome of selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    /// A named profile.
    Profile {
        /// Its name.
        name: String,
        /// What selected it.
        source: Source,
    },
    /// A server addressed by URL.
    Url {
        /// The URL, normalised.
        url: String,
        /// What supplied it.
        source: Source,
        /// The one profile for this URL, whose session is used, if there is one.
        profile: Option<String>,
    },
}

impl Selection {
    /// What made this selection.
    pub fn source(&self) -> Source {
        match self {
            Self::Profile { source, .. } | Self::Url { source, .. } => *source,
        }
    }

    /// The profile whose session and pins apply, if any.
    pub fn profile(&self) -> Option<&str> {
        match self {
            Self::Profile { name, .. } => Some(name),
            Self::Url { profile, .. } => profile.as_deref(),
        }
    }
}

/// Everything selection depends on, as plain values.
#[derive(Debug, Clone, Copy)]
pub struct SelectInputs<'a> {
    /// `--profile`.
    pub flag_profile: Option<&'a str>,
    /// `--api-url`.
    pub flag_url: Option<&'a str>,
    /// `PRK_PROFILE`.
    pub env_profile: Option<&'a str>,
    /// `PRK_API_URL`.
    pub env_url: Option<&'a str>,
    /// The project files, already validated.
    pub project: Option<&'a ProjectContext>,
    /// The profile set.
    pub config: &'a Config,
}

/// Why no server could be selected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SelectError {
    /// Both forms at one tier.
    #[error("{first} and {second} are both set; use one of them")]
    Conflict {
        /// The profile form.
        first: &'static str,
        /// The URL form.
        second: &'static str,
    },
    /// A name outside the grammar.
    #[error("`{name}` is not a usable profile name: lowercase letters, digits and single hyphens")]
    InvalidName {
        /// The name given.
        name: String,
    },
    /// No such profile.
    #[error("there is no profile named `{name}`{}", known_list(.known))]
    Unknown {
        /// The name given.
        name: String,
        /// Every profile that does exist.
        known: Vec<String>,
    },
    /// The name was renamed away.
    #[error("profile `{name}` was renamed to `{to}`")]
    Renamed {
        /// The old name.
        name: String,
        /// The new one.
        to: String,
    },
    /// Several profiles are for one URL.
    #[error("{} profiles are for {url} ({}); pick one with --profile", .profiles.len(), .profiles.join(", "))]
    AmbiguousUrl {
        /// The URL.
        url: String,
        /// The profiles.
        profiles: Vec<String>,
    },
    /// The local file names a deployment no profile is pinned to.
    #[error(
        "{path} selects instance {instance}, but no profile here is pinned to it; sign in with `prk login <URL>` first"
    )]
    NoProfileForInstance {
        /// The file.
        path: String,
        /// The instance.
        instance: String,
    },
    /// Several profiles are pinned to one deployment and nothing breaks the tie.
    #[error("{} profiles are pinned to instance {instance} ({}); choose one with --profile or `profile = \"...\"` in {path}", .profiles.len(), .profiles.join(", "))]
    AmbiguousInstance {
        /// The file that asked for the instance.
        path: String,
        /// The instance.
        instance: String,
        /// The profiles.
        profiles: Vec<String>,
    },
    /// Nothing selects a server.
    #[error(
        "no server is selected; pass --profile <NAME> or --api-url <URL>, set PRK_PROFILE or PRK_API_URL, or run `prk login <URL>` once"
    )]
    Nothing {
        /// Whether any profile exists, which decides the advice.
        has_profiles: bool,
    },
}

fn known_list(known: &[String]) -> String {
    if known.is_empty() { String::new() } else { format!(" (profiles: {})", known.join(", ")) }
}

/// Chooses the server.
///
/// # Errors
///
/// [`SelectError`] naming what is wrong and what to do.
pub fn select(inputs: &SelectInputs<'_>) -> Result<Selection, SelectError> {
    let set = |value: Option<&str>| {
        value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
    };
    let config = inputs.config;

    for (profile, url, source, names) in [
        (inputs.flag_profile, inputs.flag_url, Source::Flag, ("--profile", "--api-url")),
        (inputs.env_profile, inputs.env_url, Source::Environment, ("PRK_PROFILE", "PRK_API_URL")),
    ] {
        match (set(profile), set(url)) {
            (Some(_), Some(_)) => {
                return Err(SelectError::Conflict { first: names.0, second: names.1 });
            }
            (Some(name), None) => return by_name(config, &name, source),
            (None, Some(url)) => return by_url(config, &url, source),
            (None, None) => {}
        }
    }

    if let Some(project) = inputs.project
        && let Some(selection) = from_project(config, project)?
    {
        return Ok(selection);
    }

    if let Some(name) = &config.default_profile {
        return by_name(config, name, Source::Default);
    }

    Err(SelectError::Nothing { has_profiles: !config.profiles.is_empty() })
}

fn by_name(config: &Config, name: &str, source: Source) -> Result<Selection, SelectError> {
    if !is_profile_name(name) {
        return Err(SelectError::InvalidName { name: name.to_owned() });
    }
    if config.profiles.contains_key(name) {
        return Ok(Selection::Profile { name: name.to_owned(), source });
    }
    if let Some(tombstone) = config.renamed.get(name) {
        return Err(SelectError::Renamed { name: name.to_owned(), to: tombstone.to.clone() });
    }
    Err(SelectError::Unknown {
        name: name.to_owned(),
        known: config.profiles.keys().cloned().collect(),
    })
}

fn by_url(config: &Config, url: &str, source: Source) -> Result<Selection, SelectError> {
    let url = normalize_url(url);
    let matching = config.profiles_for_url(&url);
    match matching.as_slice() {
        [] => Ok(Selection::Url { url, source, profile: None }),
        [one] => Ok(Selection::Url { url, source, profile: Some((*one).to_owned()) }),
        many => Err(SelectError::AmbiguousUrl {
            url,
            profiles: many.iter().map(|name| (*name).to_owned()).collect(),
        }),
    }
}

/// The project tier. `Ok(None)` falls through to the default, which is still
/// held to the project's allow list once the server reports its instance.
fn from_project(
    config: &Config,
    project: &ProjectContext,
) -> Result<Option<Selection>, SelectError> {
    if let Some(local) = &project.local {
        let local_path = project.local_path.clone().unwrap_or_default();
        if let Some(instance) = &local.instance {
            let tie = local.profile.as_deref();
            return match by_instance(config, instance, tie, &local_path, Source::LocalFile)? {
                Some(selection) => Ok(Some(selection)),
                None => Err(SelectError::NoProfileForInstance {
                    path: local_path,
                    instance: instance.clone(),
                }),
            };
        }
        if let Some(name) = &local.profile {
            return by_name(config, name, Source::LocalFile).map(Some);
        }
    }

    if let [only] = project.file.allow.as_slice() {
        let tie = project.file.profile.as_deref();
        return by_instance(config, &only.instance, tie, &project.path, Source::ProjectFile);
    }
    Ok(None)
}

fn by_instance(
    config: &Config,
    instance: &str,
    tie: Option<&str>,
    path: &str,
    source: Source,
) -> Result<Option<Selection>, SelectError> {
    let pinned = config.profiles_for_instance(instance);
    match pinned.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(Selection::Profile { name: (*one).to_owned(), source })),
        many => match tie.filter(|tie| many.contains(tie)) {
            Some(name) => Ok(Some(Selection::Profile { name: name.to_owned(), source })),
            None => Err(SelectError::AmbiguousInstance {
                path: path.to_owned(),
                instance: instance.to_owned(),
                profiles: many.iter().map(|name| (*name).to_owned()).collect(),
            }),
        },
    }
}

#[cfg(test)]
mod tests;
