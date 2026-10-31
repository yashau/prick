//! `.prick.toml` and `.prick.local.toml`: what a repository says about which
//! deployments it belongs to.
//!
//! # The project file allows; it never points
//!
//! A committed `.prick.toml` arrives with `git clone`, so it is input from
//! whoever wrote the repository. It can therefore only **narrow** what this
//! machine does: it lists the deployment instance ids the code may talk to,
//! and among the servers the user already registered, picks the one pinned to
//! that instance. It never names a URL and never holds a credential, so a
//! cloned repository cannot steer a command, or a service token from the
//! environment, at a server the user did not register.
//!
//! Selection is by **instance**, not by profile name, because profile names are
//! local labels: `prod` on one machine is not `prod` on another, and a user may
//! rename theirs. A name in the file is only a tie-breaker between two local
//! profiles pinned to the same deployment.
//!
//! # One repository, several organisations
//!
//! With more than one `[[allow]]` entry the committed file cannot choose.
//! The choice comes from a flag, an environment variable, or a git-ignored
//! `.prick.local.toml` beside it, which only that checkout holds.

use serde::{Deserialize, Serialize};

use super::is_instance_id;
use crate::slug::is_slug;

/// One deployment a repository may talk to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Allow {
    /// The deployment's instance id.
    pub instance: String,
    /// The Access organisation it must also be behind, if the author pinned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
}

/// The committed `.prick.toml`.
///
/// Unknown keys are refused rather than ignored, so a `url = ...` line is never
/// mistaken for something that is honoured.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectFile {
    /// A tie-breaker between local profiles pinned to the one allowed instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// The project used when neither a flag nor the environment names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The environment used when neither a flag nor the environment names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    /// The deployments this repository may talk to. At least one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<Allow>,
}

/// The git-ignored `.prick.local.toml`: this checkout's own choice.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFile {
    /// The deployment this checkout uses. Survives profile renames.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// A tie-breaker between local profiles pinned to that instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Overrides the committed file's project for this checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Overrides the committed file's environment for this checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
}

/// Why a project file was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProjectFileError {
    /// No `[[allow]]` entry.
    #[error(
        "{path} lists no deployment; add an [[allow]] entry with the server's instance id (`prk profile pin` writes one)"
    )]
    NoAllow {
        /// The file.
        path: String,
    },
    /// An instance id of the wrong shape.
    #[error("{path}: `{value}` is not an instance id (32 lowercase hex digits)")]
    Instance {
        /// The file.
        path: String,
        /// The offending value.
        value: String,
    },
    /// A project or environment that is not a slug.
    #[error("{path}: `{value}` is not a usable {field} name")]
    Slug {
        /// The file.
        path: String,
        /// Which field.
        field: &'static str,
        /// The offending value.
        value: String,
    },
    /// A committed file that lists several deployments and also names a profile.
    #[error(
        "{path} lists more than one deployment, so it cannot choose a profile; remove `profile`, and choose with --profile, PRK_PROFILE or a git-ignored .prick.local.toml"
    )]
    ChoiceInSharedFile {
        /// The file.
        path: String,
    },
    /// The local file names an instance the committed file does not allow.
    #[error("{path} selects instance {instance}, which the project's .prick.toml does not allow")]
    LocalNotAllowed {
        /// The local file.
        path: String,
        /// The instance it names.
        instance: String,
    },
}

/// Both files, parsed, with the paths they came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectContext {
    /// Where `.prick.toml` was found.
    pub path: String,
    /// Its contents.
    pub file: ProjectFile,
    /// Where `.prick.local.toml` was found, if beside it.
    pub local_path: Option<String>,
    /// Its contents.
    pub local: Option<LocalFile>,
}

impl ProjectContext {
    /// Checks both files against each other and against their own grammar.
    ///
    /// # Errors
    ///
    /// [`ProjectFileError`] for the first problem found.
    pub fn validate(&self) -> Result<(), ProjectFileError> {
        let path = || self.path.clone();
        if self.file.allow.is_empty() {
            return Err(ProjectFileError::NoAllow { path: path() });
        }
        for allow in &self.file.allow {
            if !is_instance_id(&allow.instance) {
                return Err(ProjectFileError::Instance {
                    path: path(),
                    value: allow.instance.clone(),
                });
            }
        }
        if self.file.allow.len() > 1 && self.file.profile.is_some() {
            return Err(ProjectFileError::ChoiceInSharedFile { path: path() });
        }
        check_slugs(&self.path, self.file.project.as_deref(), self.file.env.as_deref())?;

        if let Some(local) = &self.local {
            let local_path = self.local_path.clone().unwrap_or_default();
            check_slugs(&local_path, local.project.as_deref(), local.env.as_deref())?;
            if let Some(instance) = &local.instance {
                if !is_instance_id(instance) {
                    return Err(ProjectFileError::Instance {
                        path: local_path,
                        value: instance.clone(),
                    });
                }
                if !self.allows(instance) {
                    return Err(ProjectFileError::LocalNotAllowed {
                        path: local_path,
                        instance: instance.clone(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Whether the committed file allows this instance.
    pub fn allows(&self, instance: &str) -> bool {
        self.file.allow.iter().any(|allow| allow.instance == instance)
    }

    /// The issuer the committed file requires alongside this instance, if any.
    pub fn required_issuer(&self, instance: &str) -> Option<&str> {
        self.file
            .allow
            .iter()
            .find(|allow| allow.instance == instance)
            .and_then(|allow| allow.issuer.as_deref())
    }

    /// The project these files name: the local file's, then the committed one's.
    pub fn project(&self) -> Option<&str> {
        self.local
            .as_ref()
            .and_then(|local| local.project.as_deref())
            .or(self.file.project.as_deref())
    }

    /// The environment these files name: the local file's, then the committed one's.
    pub fn env(&self) -> Option<&str> {
        self.local.as_ref().and_then(|local| local.env.as_deref()).or(self.file.env.as_deref())
    }
}

fn check_slugs(
    path: &str,
    project: Option<&str>,
    env: Option<&str>,
) -> Result<(), ProjectFileError> {
    for (field, value) in [("project", project), ("environment", env)] {
        if let Some(value) = value
            && !is_slug(value)
        {
            return Err(ProjectFileError::Slug {
                path: path.to_owned(),
                field,
                value: value.to_owned(),
            });
        }
    }
    Ok(())
}
