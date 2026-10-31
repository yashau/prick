//! Persisting profiles, and finding the project files a repository carries.
//!
//! # Updating writes nothing
//!
//! There is no migration step. An install that predates profiles has
//! `credentials.json` and no `config.toml`, and [`ProfileStore::load`] reads
//! that as one profile, `default`, whose credential is the legacy file where it
//! already is. Nothing is written until there is something new to record -- a
//! second profile, a rename, a new default, or the first instance id a server
//! reports -- and even then the legacy file is not moved. An older build on the
//! same machine therefore keeps reading the same session, and downgrading
//! works.
//!
//! # Concurrency
//!
//! Every change to `config.toml` is a read-modify-write under an advisory lock
//! file, created with `create_new` so exactly one process holds it. A rename in
//! one terminal and a first-time pin in another both persist. A lock older
//! than [`STALE_LOCK`] is taken over, because the process that held it has
//! died; nothing is held for longer than one small write.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use prick_core::profile::{
    CREDENTIAL_ID_LEN, Config, ConfigError, LocalFile, Profile, ProjectContext, ProjectFile,
};

use crate::error::AuthError;
use crate::store::{StorageBackend, TokenStore, write_private_atomically};

/// The profile configuration, in the configuration directory.
pub const CONFIG_FILE_NAME: &str = "config.toml";

/// The committed project file.
pub const PROJECT_FILE_NAME: &str = ".prick.toml";

/// The git-ignored, per-checkout project file.
pub const LOCAL_FILE_NAME: &str = ".prick.local.toml";

/// The lock taken around every change to `config.toml`.
const LOCK_FILE_NAME: &str = "config.toml.lock";

/// How old a lock must be before it is treated as abandoned.
pub const STALE_LOCK: Duration = Duration::from_secs(10);

/// How long to wait for a live lock before giving up.
const LOCK_WAIT: Duration = Duration::from_secs(5);

/// Why profiles or project files could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum ProfileStoreError {
    /// A filesystem failure.
    #[error("could not {operation} {path}: {source}")]
    Io {
        /// What was being attempted.
        operation: &'static str,
        /// The path involved.
        path: String,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// A file that is not valid TOML for its shape.
    #[error("{path} could not be read: {message}")]
    Parse {
        /// The file.
        path: String,
        /// The parser's explanation, which names the line.
        message: String,
    },
    /// A file that parses but fails validation.
    #[error("{path}: {source}")]
    Invalid {
        /// The file.
        path: String,
        /// What is wrong.
        source: ConfigError,
    },
    /// Another process holds the lock.
    #[error(
        "{path} is locked by another prk; try again, or delete the lock file if no prk is running"
    )]
    Locked {
        /// The lock file.
        path: String,
    },
    /// The legacy credential file could not be read.
    #[error(transparent)]
    Auth(#[from] AuthError),
}

/// A loaded profile configuration.
#[derive(Debug, Clone)]
pub struct Loaded {
    /// The configuration.
    pub config: Config,
    /// Whether it came from `config.toml`, rather than being read from a
    /// pre-profiles install or being empty.
    pub persisted: bool,
}

/// Reads and writes `config.toml`, and hands out each profile's token store.
#[derive(Debug, Clone)]
pub struct ProfileStore {
    /// The store for the legacy file, which carries the directory and the
    /// roaming location every profile's store is derived from.
    base: TokenStore,
}

impl ProfileStore {
    /// The store in the platform's configuration directory.
    ///
    /// # Errors
    ///
    /// See [`crate::store::default_config_dir`].
    pub fn new() -> Result<Self, AuthError> {
        Ok(Self { base: TokenStore::new(StorageBackend::File)? })
    }

    /// The store in a specific directory.
    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        Self { base: TokenStore::in_dir(dir, StorageBackend::File) }
    }

    /// The configuration directory.
    pub fn dir(&self) -> &Path {
        self.base.dir()
    }

    /// The path of `config.toml`.
    pub fn config_path(&self) -> PathBuf {
        self.dir().join(CONFIG_FILE_NAME)
    }

    /// The token store for one profile's credential.
    pub fn tokens(&self, profile: &Profile) -> TokenStore {
        self.base.for_credential(&profile.credential)
    }

    /// The token store for the legacy file.
    pub fn legacy_tokens(&self) -> &TokenStore {
        &self.base
    }

    /// Loads the profiles.
    ///
    /// `config.toml` when it exists. Otherwise a pre-profiles
    /// `credentials.json` read as the profile `default`, and otherwise an empty
    /// set. Neither of the last two writes anything.
    ///
    /// # Errors
    ///
    /// [`ProfileStoreError`] for an unreadable, unparsable or invalid file.
    pub fn load(&self) -> Result<Loaded, ProfileStoreError> {
        if let Some(config) = self.read_config()? {
            return Ok(Loaded { config, persisted: true });
        }
        let config = match self.base.load()? {
            Some(session) => Config::from_legacy(&session.api_url, &session.issuer),
            None => Config::default(),
        };
        Ok(Loaded { config, persisted: false })
    }

    fn read_config(&self) -> Result<Option<Config>, ProfileStoreError> {
        let path = self.config_path();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(ProfileStoreError::Io {
                    operation: "read",
                    path: path.display().to_string(),
                    source,
                });
            }
        };
        parse_config(&text, &path).map(Some)
    }

    /// Applies a change under the lock: re-read, change, validate, write.
    ///
    /// Re-reading under the lock is the point: a change computed from a copy
    /// loaded earlier would overwrite whatever another process wrote since.
    ///
    /// # Errors
    ///
    /// Whatever `change` returns, or [`ProfileStoreError`] converted into it.
    pub fn update<T, E>(&self, change: impl FnOnce(&mut Config) -> Result<T, E>) -> Result<T, E>
    where
        E: From<ProfileStoreError>,
    {
        let _lock = self.lock()?;
        let mut config = self.load()?.config;
        let result = change(&mut config)?;
        self.write(&config)?;
        Ok(result)
    }

    fn write(&self, config: &Config) -> Result<(), ProfileStoreError> {
        let path = self.config_path();
        config.validate().map_err(|source| ProfileStoreError::Invalid {
            path: path.display().to_string(),
            source,
        })?;
        let text = serialize_config(config);
        write_private_atomically(&path, text.as_bytes()).map_err(|source| ProfileStoreError::Io {
            operation: "write",
            path: path.display().to_string(),
            source,
        })
    }

    fn lock(&self) -> Result<LockGuard, ProfileStoreError> {
        let path = self.dir().join(LOCK_FILE_NAME);
        crate::store::ensure_private_dir(self.dir()).map_err(|source| ProfileStoreError::Io {
            operation: "create",
            path: self.dir().display().to_string(),
            source,
        })?;
        let started = SystemTime::now();
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(LockGuard { path }),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed().unwrap_or_default() > LOCK_WAIT {
                        return Err(ProfileStoreError::Locked { path: path.display().to_string() });
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(source) => {
                    return Err(ProfileStoreError::Io {
                        operation: "lock",
                        path: path.display().to_string(),
                        source,
                    });
                }
            }
        }
    }
}

/// Removes the lock when the change is done, including on an early return.
struct LockGuard {
    path: PathBuf,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A fresh credential id: 16 random lowercase hex digits.
///
/// # Errors
///
/// [`AuthError::Io`] if the platform has no randomness to give.
pub fn new_credential_id() -> Result<String, AuthError> {
    let mut bytes = [0u8; CREDENTIAL_ID_LEN / 2];
    getrandom::fill(&mut bytes).map_err(|err| {
        AuthError::Io(std::io::Error::other(format!("no randomness available: {err}")))
    })?;
    Ok(bytes.iter().fold(String::with_capacity(CREDENTIAL_ID_LEN), |mut hex, byte| {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
        hex
    }))
}

/// Parses `config.toml`.
///
/// The version is read before the shape, so a file from a newer build is
/// refused as that rather than as a parse error about a field this build has
/// never heard of.
///
/// # Errors
///
/// [`ProfileStoreError::Parse`] or [`ProfileStoreError::Invalid`].
pub fn parse_config(text: &str, path: &Path) -> Result<Config, ProfileStoreError> {
    let display = || path.display().to_string();
    let table: toml::Table = toml::from_str(text)
        .map_err(|err| ProfileStoreError::Parse { path: display(), message: err.to_string() })?;
    let version = table.get("version").and_then(toml::Value::as_integer);
    if let Some(found) = version
        && found != i64::from(prick_core::profile::CONFIG_VERSION)
    {
        return Err(ProfileStoreError::Invalid {
            path: display(),
            source: ConfigError::Version { found: u8::try_from(found).unwrap_or(u8::MAX) },
        });
    }
    let config: Config = toml::from_str(text)
        .map_err(|err| ProfileStoreError::Parse { path: display(), message: err.to_string() })?;
    config.validate().map_err(|source| ProfileStoreError::Invalid { path: display(), source })?;
    Ok(config)
}

/// Renders `config.toml`.
pub fn serialize_config(config: &Config) -> String {
    let body = toml::to_string_pretty(config).unwrap_or_default();
    format!(
        "# prick CLI profiles. Managed by `prk profile` and `prk login`; safe to read,\n\
         # and edits are validated on the next run.\n\n{body}"
    )
}

/// Parses a `.prick.toml`. Unknown keys are refused.
///
/// # Errors
///
/// [`ProfileStoreError::Parse`] naming the file and line.
pub fn parse_project_file(text: &str, path: &Path) -> Result<ProjectFile, ProfileStoreError> {
    toml::from_str(text).map_err(|err| ProfileStoreError::Parse {
        path: path.display().to_string(),
        message: err.to_string(),
    })
}

/// Parses a `.prick.local.toml`. Unknown keys are refused.
///
/// # Errors
///
/// [`ProfileStoreError::Parse`] naming the file and line.
pub fn parse_local_file(text: &str, path: &Path) -> Result<LocalFile, ProfileStoreError> {
    toml::from_str(text).map_err(|err| ProfileStoreError::Parse {
        path: path.display().to_string(),
        message: err.to_string(),
    })
}

/// Renders a project file or local file.
pub fn serialize_toml<T: serde::Serialize>(value: &T) -> String {
    toml::to_string_pretty(value).unwrap_or_default()
}

/// Where a project file was found, and the repository root that bounded the
/// search, if any.
#[derive(Debug, Clone)]
pub struct FoundProject {
    /// Both files, parsed but not yet validated.
    pub context: ProjectContext,
    /// The directory `.prick.toml` is in.
    pub dir: PathBuf,
}

/// Looks for `.prick.toml` from `start` upwards.
///
/// The search stops at the first directory containing `.git` (after checking
/// that directory) or at `home`, whichever comes first, so a stray file in a
/// parent directory cannot select a server for every repository beneath it.
/// `.prick.local.toml` is read only from beside the `.prick.toml` that was
/// found.
///
/// # Errors
///
/// [`ProfileStoreError`] for a file that exists and cannot be read or parsed.
pub fn find_project(
    start: &Path,
    home: Option<&Path>,
) -> Result<Option<FoundProject>, ProfileStoreError> {
    for dir in start.ancestors() {
        let candidate = dir.join(PROJECT_FILE_NAME);
        if let Some(text) = read_optional(&candidate)? {
            let file = parse_project_file(&text, &candidate)?;
            let local_candidate = dir.join(LOCAL_FILE_NAME);
            let (local_path, local) = match read_optional(&local_candidate)? {
                Some(text) => (
                    Some(local_candidate.display().to_string()),
                    Some(parse_local_file(&text, &local_candidate)?),
                ),
                None => (None, None),
            };
            return Ok(Some(FoundProject {
                context: ProjectContext {
                    path: candidate.display().to_string(),
                    file,
                    local_path,
                    local,
                },
                dir: dir.to_path_buf(),
            }));
        }
        if dir.join(".git").exists() || home.is_some_and(|home| home == dir) {
            break;
        }
    }
    Ok(None)
}

fn read_optional(path: &Path) -> Result<Option<String>, ProfileStoreError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ProfileStoreError::Io {
            operation: "read",
            path: path.display().to_string(),
            source,
        }),
    }
}

#[cfg(test)]
mod tests;
