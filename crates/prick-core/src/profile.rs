//! Named server profiles: the data model, its validation, and the decision of
//! which server a command talks to.
//!
//! # What a profile is
//!
//! A **profile** is a local name bound to one server URL, plus the credential
//! obtained by signing in to that server under that name. The name is a label
//! the user chooses and may change at any time; it never identifies a server.
//! What identifies a server is its **instance id**, a permanent random value a
//! deployment reports about itself, which a profile pins the first time it
//! talks to the server.
//!
//! Two deployments can run the same application behind the same Access
//! organisation, with the same project, environment and key names. Nothing in a
//! request distinguishes them, so a write that reaches the wrong one succeeds.
//! The instance pin is what turns that into a refusal.
//!
//! # Why this module is pure
//!
//! Choosing a server is a security decision with a dozen inputs: two flags, two
//! environment variables, two project files, the configured default, and the
//! profiles themselves. Every one of those arrives here as a plain value, so
//! the whole precedence table is a total function that is tested exhaustively
//! and runs under miri. Reading the files and the environment is the caller's
//! job.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::slug::is_slug;

/// The `config.toml` format version this build reads and writes.
///
/// Read first; an unknown version is refused rather than guessed at. A new
/// field whose loss on rewrite would weaken a check bumps it, so an older
/// build refuses the file instead of rewriting it without the check.
pub const CONFIG_VERSION: u8 = 1;

/// The credential file of an install that predates profiles.
///
/// The profile built from such an install keeps using this file where it is,
/// so an older build on the same machine keeps working against it.
pub const LEGACY_CREDENTIAL: &str = "credentials.json";

/// The name given to the profile built from a pre-profiles install, and to the
/// first profile ever created.
pub const DEFAULT_NAME: &str = "default";

/// The length of an instance id, in hex characters.
pub const INSTANCE_ID_LEN: usize = 32;

/// The length of a generated credential id, in hex characters.
pub const CREDENTIAL_ID_LEN: usize = 16;

/// Whether a string is a valid profile name.
///
/// The slug grammar: lowercase letters, digits and single hyphens. A name
/// never becomes a path -- credential files are named by an id -- so it needs
/// no rules beyond being easy to type and unambiguous on a command line.
pub fn is_profile_name(value: &str) -> bool {
    is_slug(value)
}

/// Whether a string is a well-formed instance id: 32 lowercase hex digits.
pub fn is_instance_id(value: &str) -> bool {
    value.len() == INSTANCE_ID_LEN && is_lower_hex(value)
}

/// Whether a string can name a profile's credential file.
///
/// Either the legacy file, or a generated id of 16 lowercase hex digits. Both
/// are fixed shapes, so a hand-edited `config.toml` cannot point a credential
/// at an arbitrary path.
pub fn is_credential_ref(value: &str) -> bool {
    value == LEGACY_CREDENTIAL || (value.len() == CREDENTIAL_ID_LEN && is_lower_hex(value))
}

fn is_lower_hex(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The first eight characters of an instance id, for display.
pub fn short_instance(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// Normalises a server URL the way every comparison in this module expects:
/// surrounding whitespace and trailing slashes removed.
pub fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

/// Why a server URL was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlError {
    /// Not `https://`, and not `http://` to a loopback host.
    #[error(
        "`{url}` is not an https URL; a credential is sent with every request, so only https, or http to a loopback address, is accepted"
    )]
    Insecure {
        /// The URL as given.
        url: String,
    },
    /// Carries `user:password@`, which proxies log and this API never reads.
    #[error("`{url}` carries credentials in the URL; remove the `user@` part")]
    Userinfo {
        /// The URL as given.
        url: String,
    },
    /// Has no host, or is not a URL at all.
    #[error("`{url}` is not a server URL; expected something like https://prick.example.com")]
    Malformed {
        /// The URL as given.
        url: String,
    },
}

/// Validates a server URL and returns it normalised.
///
/// # Errors
///
/// [`UrlError`] naming what is wrong.
pub fn validate_url(url: &str) -> Result<String, UrlError> {
    let normalized = normalize_url(url);
    let lower = normalized.to_ascii_lowercase();
    let (secure, rest) = if let Some(rest) = lower.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(UrlError::Malformed { url: url.to_owned() });
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err(UrlError::Userinfo { url: url.to_owned() });
    }
    let host = host_of_authority(authority);
    if host.is_empty() {
        return Err(UrlError::Malformed { url: url.to_owned() });
    }
    if !secure && !is_loopback(host) {
        return Err(UrlError::Insecure { url: url.to_owned() });
    }
    Ok(normalized)
}

/// The host part of a URL, lowercased, without scheme, port or path.
///
/// What every display of a profile shows next to its name, because the name
/// is a local label and the host is the same on every machine.
pub fn host_of(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower.split_once("://").map_or(lower.as_str(), |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    host_of_authority(authority).to_owned()
}

fn host_of_authority(authority: &str) -> &str {
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.split(']').next().unwrap_or("");
    }
    authority.split(':').next().unwrap_or("")
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host.split('.').next() == Some("127") && host.split('.').count() == 4
}

/// One saved server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// The server, normalised without a trailing slash.
    pub api_url: String,

    /// Which file holds this profile's session: [`LEGACY_CREDENTIAL`], or a
    /// generated id naming `credentials/<id>.json`.
    pub credential: String,

    /// The deployment this profile is pinned to, once it has been seen.
    ///
    /// `None` until the server first reports an instance id, or for a server
    /// that does not report one. Once set, a server reporting any other value
    /// is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,

    /// The Access organisation (token issuer) this profile signed in through.
    ///
    /// Pinned at the first sign-in. A later sign-in through a different issuer
    /// is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,

    /// The service-token client id this profile expects from the environment.
    ///
    /// When set, an environment service token with any other client id is
    /// refused before it is sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_token_client_id: Option<String>,

    /// The project used when neither `--project` nor `PRK_PROJECT` names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,

    /// The environment used when neither `--env` nor `PRK_ENV` names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
}

impl Profile {
    /// A profile for a server, with nothing pinned yet.
    pub fn new(api_url: impl Into<String>, credential: impl Into<String>) -> Self {
        Self {
            api_url: api_url.into(),
            credential: credential.into(),
            instance: None,
            issuer: None,
            service_token_client_id: None,
            project: None,
            env: None,
        }
    }
}

/// What became of a renamed profile's old name.
///
/// Kept so the old name fails with a message naming the new one, and so it
/// cannot quietly come to mean another deployment: a script still saying
/// `--profile prod`, written when `prod` meant one organisation, must not start
/// writing to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    /// The name the profile was renamed to.
    pub to: String,
    /// The deployment it was pinned to at the time, if it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

/// The whole of `config.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// The format version. See [`CONFIG_VERSION`].
    pub version: u8,

    /// The profile used when nothing more specific selects one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,

    /// Every profile, by name.
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,

    /// Names that were renamed away, and what they became.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub renamed: BTreeMap<String, Tombstone>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            default_profile: None,
            profiles: BTreeMap::new(),
            renamed: BTreeMap::new(),
        }
    }
}

/// Why a `config.toml` was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// Written by a newer build.
    #[error(
        "the profile configuration is version {found}, written by a newer prk (this build reads version {CONFIG_VERSION}); update prk"
    )]
    Version {
        /// The version in the file.
        found: u8,
    },
    /// A profile name outside the grammar.
    #[error("`{name}` is not a usable profile name: lowercase letters, digits and single hyphens")]
    Name {
        /// The offending name.
        name: String,
    },
    /// A field that fails its own validation.
    #[error("profile `{profile}` has an invalid {field}: {reason}")]
    Field {
        /// The profile it belongs to.
        profile: String,
        /// Which field.
        field: &'static str,
        /// What is wrong with it.
        reason: String,
    },
    /// `default_profile` names no profile.
    #[error("the default profile `{name}` does not exist")]
    MissingDefault {
        /// The dangling name.
        name: String,
    },
    /// Two profiles share one credential file.
    #[error("profiles `{first}` and `{second}` share a credential file")]
    SharedCredential {
        /// One of them.
        first: String,
        /// The other.
        second: String,
    },
}

impl Config {
    /// The configuration of an install that predates profiles: one profile,
    /// [`DEFAULT_NAME`], using [`LEGACY_CREDENTIAL`] where it already is.
    ///
    /// Built in memory on every run until something new needs recording, so
    /// updating `prk` writes nothing.
    pub fn from_legacy(api_url: &str, issuer: &str) -> Self {
        let mut profile = Profile::new(normalize_url(api_url), LEGACY_CREDENTIAL);
        profile.issuer = Some(issuer.to_owned()).filter(|issuer| !issuer.is_empty());
        let mut config = Self { default_profile: Some(DEFAULT_NAME.to_owned()), ..Self::default() };
        config.profiles.insert(DEFAULT_NAME.to_owned(), profile);
        config
    }

    /// Checks everything a hand edit could get wrong.
    ///
    /// # Errors
    ///
    /// [`ConfigError`] for the first problem found.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.version != CONFIG_VERSION {
            return Err(ConfigError::Version { found: self.version });
        }
        let mut credentials: BTreeMap<&str, &str> = BTreeMap::new();
        for (name, profile) in &self.profiles {
            if !is_profile_name(name) {
                return Err(ConfigError::Name { name: name.clone() });
            }
            let field = |field: &'static str, reason: String| ConfigError::Field {
                profile: name.clone(),
                field,
                reason,
            };
            validate_url(&profile.api_url).map_err(|err| field("api_url", err.to_string()))?;
            if !is_credential_ref(&profile.credential) {
                return Err(field("credential", "not a credential id".to_owned()));
            }
            if let Some(first) = credentials.insert(&profile.credential, name) {
                return Err(ConfigError::SharedCredential {
                    first: first.to_owned(),
                    second: name.clone(),
                });
            }
            if let Some(instance) = &profile.instance
                && !is_instance_id(instance)
            {
                return Err(field("instance", "expected 32 lowercase hex digits".to_owned()));
            }
            for (label, value) in [("project", &profile.project), ("env", &profile.env)] {
                if let Some(value) = value
                    && !is_slug(value)
                {
                    return Err(field(label, format!("`{value}` is not a slug")));
                }
            }
        }
        if let Some(default) = &self.default_profile
            && !self.profiles.contains_key(default)
        {
            return Err(ConfigError::MissingDefault { name: default.clone() });
        }
        Ok(())
    }

    /// Every profile whose URL is `url`, by name.
    pub fn profiles_for_url(&self, url: &str) -> Vec<&str> {
        let wanted = normalize_url(url);
        self.profiles
            .iter()
            .filter(|(_, profile)| profile.api_url == wanted)
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// Every profile pinned to `instance`, by name.
    pub fn profiles_for_instance(&self, instance: &str) -> Vec<&str> {
        self.profiles
            .iter()
            .filter(|(_, profile)| profile.instance.as_deref() == Some(instance))
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// The name for a profile created by signing in to `url` without naming one.
    ///
    /// [`DEFAULT_NAME`] when no profile exists yet, so the first sign-in reads
    /// naturally; otherwise the URL's host as a slug, with a numeric suffix if
    /// that is taken -- including by a tombstone, so an old name is never
    /// handed out again by accident.
    pub fn auto_name(&self, url: &str) -> String {
        if self.profiles.is_empty() && !self.renamed.contains_key(DEFAULT_NAME) {
            return DEFAULT_NAME.to_owned();
        }
        let base = crate::slug::slugify(&host_of(url).replace('.', "-"))
            .unwrap_or_else(|| "server".to_owned());
        let taken =
            |name: &str| self.profiles.contains_key(name) || self.renamed.contains_key(name);
        if !taken(&base) {
            return base;
        }
        (2..=u32::MAX).map(|n| format!("{base}-{n}")).find(|name| !taken(name)).unwrap_or(base)
    }
}

#[cfg(test)]
mod tests;

pub mod edit;
pub mod project;
pub mod select;

pub use edit::EditError;
pub use project::{Allow, LocalFile, ProjectContext, ProjectFile, ProjectFileError};
pub use select::{SelectError, SelectInputs, Selection, Source};
