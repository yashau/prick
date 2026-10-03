//! Token persistence.
//!
//! # Why a file rather than the OS keyring
//!
//! The default is a `0600` file, and that is deliberate:
//!
//! - Over SSH or in CI there is no D-Bus session, so a keyring lookup fails or
//!   blocks. A secrets manager that cannot run in CI is not one.
//! - On macOS the Keychain ACL is bound to the binary's code signature, so
//!   every update re-prompts for authorisation -- unusable from inside
//!   `prk run`, which is exactly where a prompt cannot be answered.
//!
//! Keyring support stays behind `--storage keyring` for people whose threat
//! model wants it.
//!
//! # Location
//!
//! On Windows the file lives under `%LOCALAPPDATA%`, never `%APPDATA%`. The
//! roaming half of a profile is copied to a file server at sign-out wherever
//! roaming profiles or folder redirection are in force, and a refresh token on
//! a share sits outside the DACL this module sets and inside every backup of
//! that share. A session is bound to the machine that signed in, so it belongs
//! in the half of the profile that stays on it.
//!
//! A session found in `%APPDATA%\prick` is moved to the local directory the
//! first time it is read, and the roaming copy is deleted. `prk logout` removes
//! both, and `prk doctor` reports a roaming copy that could not be removed.
//!
//! # Atomicity
//!
//! A token file is written to a temporary file **in the same directory**, then
//! `fsync`ed, then renamed over the target. Same directory because `rename` is
//! only atomic within a filesystem; `fsync` before the rename because otherwise
//! a crash can leave a renamed-but-empty file, which is worse than no file at
//! all -- an empty token file reads as a corrupt session rather than as an
//! absent one.
//!
//! On Unix the parent directory is `fsync`ed too, so the rename itself is
//! durable rather than merely ordered.
//!
//! # Permissions
//!
//! Unix has a mode: `0600` on the file, `0700` on the directory, set at
//! creation rather than afterwards so there is no window in which the file
//! exists and is readable.
//!
//! Windows has no mode. A new file inherits its parent's ACL, which under a
//! user profile already grants `SYSTEM` and `Administrators`. So the DACL is
//! replaced outright with a single entry for the current user and marked
//! protected -- see `prick_exec::winsec` for why that lives where it does.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize as _;

use crate::error::AuthError;

/// The file mode tokens are written with on Unix. Owner read/write only.
pub const TOKEN_FILE_MODE: u32 = 0o600;

/// The directory mode the token's parent is created with on Unix.
pub const TOKEN_DIR_MODE: u32 = 0o700;

/// The environment variable that overrides the configuration directory.
pub const CONFIG_DIR_VAR: &str = "PRK_CONFIG_DIR";

/// The file tokens are kept in.
pub const TOKEN_FILE_NAME: &str = "credentials.json";

/// Where tokens are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum StorageBackend {
    /// A file with owner-only permissions. The default.
    ///
    /// Works identically over SSH, in a container and in CI, none of which have
    /// a session keyring.
    #[default]
    File,
    /// The operating system keyring, opt-in via `--storage keyring`.
    Keyring,
}

impl StorageBackend {
    /// The name accepted on the command line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Keyring => "keyring",
        }
    }

    /// Whether this backend can be used with no interactive session available.
    ///
    /// The keyring cannot: over SSH there is no D-Bus session to talk to, and
    /// on macOS the Keychain prompts for authorisation that nobody can answer
    /// from inside `prk run`.
    pub fn works_headless(self) -> bool {
        matches!(self, Self::File)
    }
}

/// A set of OAuth tokens.
#[derive(Debug, Clone)]
pub struct Tokens {
    /// The token presented to the API.
    pub access_token: SecretString,
    /// The token used to renew the access token without a browser.
    pub refresh_token: Option<SecretString>,
    /// When the access token stops being accepted, in seconds since the epoch.
    ///
    /// `None` means the server did not say, in which case the token is used
    /// until it is refused rather than pre-emptively renewed.
    pub expires_at: Option<u64>,
}

/// Everything needed to keep talking to one server.
#[derive(Debug, Clone)]
pub struct StoredSession {
    /// The server these tokens are for. A token issued for one server is never
    /// presented to another.
    pub api_url: String,
    /// The authorization server that issued them.
    pub issuer: String,
    /// The dynamically registered client id, needed to refresh.
    pub client_id: String,
    /// The token endpoint, so a refresh does not repeat discovery.
    pub token_endpoint: String,
    /// The RFC 8707 resource indicator these tokens were minted for.
    ///
    /// Kept so a renewal can name the same resource the first exchange did,
    /// without repeating discovery to find out what it was.
    ///
    /// `None` for a server with nothing in front of it, and for a session
    /// written before this field existed. Sending no indicator is exactly what
    /// every login did until Access started refusing it, so an old session
    /// refreshes as well as it ever did rather than failing to load.
    pub resource: Option<String>,
    /// The RFC 7009 revocation endpoint, so `prk logout` can hand the token
    /// back without repeating discovery.
    ///
    /// Stored rather than rediscovered because logout is the one command that
    /// must work when the network is worse than usual -- a laptop being handed
    /// on, a machine being decommissioned -- and a discovery round trip is one
    /// more thing between the operator and a revoked token.
    ///
    /// `None` for a server that advertises no revocation endpoint, and for a
    /// session written before this field existed. Both mean the same thing at
    /// logout: fall back to discovery, and say so if that finds nothing.
    pub revocation_endpoint: Option<String>,
    /// The tokens themselves.
    pub tokens: Tokens,
}

impl StoredSession {
    /// Whether the access token is close enough to expiry to renew.
    ///
    /// `skew` is the margin: a token that expires during the request it is
    /// about to authenticate is no more useful than one that has already
    /// expired.
    pub fn needs_refresh(&self, now: u64, skew: u64) -> bool {
        self.tokens.expires_at.is_some_and(|expires_at| expires_at.saturating_sub(skew) <= now)
    }

    /// Whether this session can be renewed without a browser.
    pub fn is_refreshable(&self) -> bool {
        self.tokens.refresh_token.is_some()
    }
}

/// The on-disk shape.
///
/// A separate type from [`StoredSession`] so the secret-carrying fields are
/// plain strings for exactly as long as serialisation takes, and the buffer
/// they live in can be zeroized afterwards. Deriving `Serialize` straight onto
/// a `SecretString` would put the value into `serde`'s hands with no way to
/// clear what it allocated.
#[derive(Debug, Serialize, Deserialize)]
struct Wire {
    version: u8,
    api_url: String,
    issuer: String,
    client_id: String,
    token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revocation_endpoint: Option<String>,
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

/// The format version written into every file.
///
/// Byte-for-byte the same idea as the ciphertext envelope on the server: read
/// the version first and refuse an unknown one rather than guessing at a shape.
const WIRE_VERSION: u8 = 1;

impl Wire {
    fn from_session(session: &StoredSession) -> Self {
        Self {
            version: WIRE_VERSION,
            api_url: session.api_url.clone(),
            issuer: session.issuer.clone(),
            client_id: session.client_id.clone(),
            token_endpoint: session.token_endpoint.clone(),
            resource: session.resource.clone(),
            revocation_endpoint: session.revocation_endpoint.clone(),
            access_token: session.tokens.access_token.expose_secret().to_owned(),
            refresh_token: session
                .tokens
                .refresh_token
                .as_ref()
                .map(|token| token.expose_secret().to_owned()),
            expires_at: session.tokens.expires_at,
        }
    }

    fn into_session(mut self) -> StoredSession {
        StoredSession {
            api_url: std::mem::take(&mut self.api_url),
            issuer: std::mem::take(&mut self.issuer),
            client_id: std::mem::take(&mut self.client_id),
            token_endpoint: std::mem::take(&mut self.token_endpoint),
            resource: self.resource.take(),
            revocation_endpoint: self.revocation_endpoint.take(),
            tokens: Tokens {
                access_token: SecretString::from(std::mem::take(&mut self.access_token)),
                refresh_token: self.refresh_token.take().map(SecretString::from),
                expires_at: self.expires_at,
            },
        }
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(token) = self.refresh_token.as_mut() {
            token.zeroize();
        }
    }
}

/// The default configuration directory for this platform.
///
/// `PRK_CONFIG_DIR` overrides it unconditionally, which is what makes the
/// store testable without touching a real user's files and what lets a CI job
/// point at a scratch directory.
///
/// # Errors
///
/// [`AuthError::Store`] when neither the platform variable nor `HOME` is set,
/// which is a real state inside a minimal container.
pub fn default_config_dir() -> Result<PathBuf, AuthError> {
    config_dir_from(|name| std::env::var(name).ok())
}

/// [`default_config_dir`] with an injectable environment, for tests.
///
/// # Errors
///
/// See [`default_config_dir`].
pub fn config_dir_from(lookup: impl Fn(&str) -> Option<String>) -> Result<PathBuf, AuthError> {
    if let Some(dir) = lookup(CONFIG_DIR_VAR).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir));
    }

    let missing = |what: &str| AuthError::Store {
        operation: "locate",
        path: what.to_owned(),
        source: std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no configuration directory could be determined",
        ),
    };

    if cfg!(windows) {
        // Local, not roaming: see the module documentation.
        let base = lookup("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| missing("%LOCALAPPDATA%"))?;
        return Ok(PathBuf::from(base).join("prick"));
    }

    let home = lookup("HOME").filter(|value| !value.is_empty()).ok_or_else(|| missing("$HOME"))?;

    if cfg!(target_os = "macos") {
        return Ok(PathBuf::from(home).join("Library").join("Application Support").join("prick"));
    }

    let base = lookup("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map_or_else(|| PathBuf::from(home).join(".config"), PathBuf::from);
    Ok(base.join("prick"))
}

/// The roaming directory a Windows session was kept in before it moved to
/// `%LOCALAPPDATA%`, if there is one to look in.
///
/// `None` off Windows, and `None` under `PRK_CONFIG_DIR`: an operator who named
/// a directory has said where the session is, and reaching past that into a
/// profile directory would read a session they did not point at.
pub fn roaming_config_dir_from(lookup: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if !cfg!(windows) || lookup(CONFIG_DIR_VAR).is_some_and(|value| !value.is_empty()) {
        return None;
    }
    lookup("APPDATA")
        .filter(|value| !value.is_empty())
        .map(|base| PathBuf::from(base).join("prick"))
}

/// Reads and writes the token file.
#[derive(Debug, Clone)]
pub struct TokenStore {
    dir: PathBuf,
    /// Where a session written to the roaming profile is picked up from.
    roaming: Option<PathBuf>,
    backend: StorageBackend,
}

impl TokenStore {
    /// Builds a store rooted at the platform's configuration directory.
    ///
    /// # Errors
    ///
    /// See [`default_config_dir`].
    pub fn new(backend: StorageBackend) -> Result<Self, AuthError> {
        let roaming = roaming_config_dir_from(|name| std::env::var(name).ok());
        Ok(Self { roaming, ..Self::in_dir(default_config_dir()?, backend) })
    }

    /// Builds a store rooted at a specific directory.
    ///
    /// Only that directory: a roaming copy is picked up by [`TokenStore::new`]
    /// alone.
    pub fn in_dir(dir: impl Into<PathBuf>, backend: StorageBackend) -> Self {
        Self { dir: dir.into(), roaming: None, backend }
    }

    /// The same store, on another backend.
    #[must_use]
    pub fn with_backend(&self, backend: StorageBackend) -> Self {
        Self { backend, ..self.clone() }
    }

    /// The roaming token file this store migrates from and removes on logout,
    /// whether or not it exists.
    pub fn roaming_path(&self) -> Option<PathBuf> {
        self.roaming.as_ref().map(|dir| dir.join(TOKEN_FILE_NAME))
    }

    /// The directory the token file lives in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The token file's path.
    pub fn path(&self) -> PathBuf {
        self.dir.join(TOKEN_FILE_NAME)
    }

    /// The backend this store was built for.
    pub fn backend(&self) -> StorageBackend {
        self.backend
    }

    /// Loads the stored session, if there is one.
    ///
    /// A missing file is `Ok(None)`, not an error: not being logged in is a
    /// normal state and the caller has a better message for it than this does.
    ///
    /// With no local file, a roaming copy is read instead and moved into the
    /// local directory before it is returned.
    ///
    /// # Errors
    ///
    /// [`AuthError::StorageUnavailable`] for the keyring backend,
    /// [`AuthError::Store`] for an unreadable or unparsable file, or a roaming
    /// copy that cannot be written locally.
    pub fn load(&self) -> Result<Option<StoredSession>, AuthError> {
        self.check_available()?;

        if let Some(session) = read_session(&self.path())? {
            return Ok(Some(session));
        }

        let Some(roaming) = self.roaming_path() else {
            return Ok(None);
        };
        let Some(session) = read_session(&roaming)? else {
            return Ok(None);
        };

        // Written locally first, so a failure here leaves the roaming copy as
        // the only one rather than leaving none at all.
        self.save(&session)?;
        Ok(Some(session))
    }

    /// Writes the session, replacing whatever was there.
    ///
    /// A roaming copy is deleted once the local file is in place, so no
    /// session outlives its replacement on a file share. That deletion is best
    /// effort: a save that has already succeeded is not turned into a failure,
    /// and `prk doctor` reports a roaming copy that survives.
    ///
    /// # Errors
    ///
    /// [`AuthError::StorageUnavailable`] for the keyring backend, and
    /// [`AuthError::Store`] for any filesystem failure.
    pub fn save(&self, session: &StoredSession) -> Result<(), AuthError> {
        self.check_available()?;
        self.ensure_dir()?;

        let wire = Wire::from_session(session);
        let mut bytes = serde_json::to_vec_pretty(&wire).map_err(|err| AuthError::Store {
            operation: "encode",
            path: self.path().display().to_string(),
            source: std::io::Error::other(err.to_string()),
        })?;
        drop(wire);

        let result = self.write_atomically(&bytes);
        bytes.zeroize();
        result?;

        if let Some(roaming) = self.roaming_path() {
            let _ = remove_if_present(&roaming);
        }
        Ok(())
    }

    /// Removes the stored session, and any roaming copy of it.
    ///
    /// A missing file is success: `prk logout` is idempotent by design, because
    /// the state it establishes is "no credentials", and that state is already
    /// true.
    ///
    /// # Errors
    ///
    /// [`AuthError::Store`] for a file that exists and cannot be removed.
    /// Unlike [`TokenStore::save`] a roaming copy that survives is an error
    /// here: an operator who logged out is owed the absence of every copy.
    pub fn clear(&self) -> Result<(), AuthError> {
        let local = remove_if_present(&self.path());
        let roaming = self.roaming_path().map_or(Ok(()), |path| remove_if_present(&path));
        local.and(roaming)
    }

    /// Whether the token file is readable only by its owner.
    ///
    /// What `prk doctor` reports. A `false` here is a finding: a credentials
    /// file that group or other can read is the same defect on both platforms,
    /// even though it is spelled differently.
    ///
    /// # Errors
    ///
    /// [`AuthError::Store`] if the file's metadata or ACL cannot be read.
    pub fn is_owner_only(&self) -> Result<bool, AuthError> {
        let path = self.path();
        if !path.exists() {
            return Ok(true);
        }
        owner_only(&path).map_err(|source| AuthError::Store {
            operation: "inspect",
            path: path.display().to_string(),
            source,
        })
    }

    /// Refuses a backend this build cannot serve.
    ///
    /// Public so a caller can ask before doing work whose result this store
    /// will have to hold: a login that only discovers it cannot save at the very
    /// end has already sent the operator through a browser sign-in for nothing.
    ///
    /// # Errors
    ///
    /// [`AuthError::StorageUnavailable`] for a backend this build cannot serve.
    pub fn check_available(&self) -> Result<(), AuthError> {
        match self.backend {
            StorageBackend::File => Ok(()),
            // Named rather than silently downgraded to a file: an operator who
            // asked for the keyring did so for a reason, and quietly writing
            // the token to disk instead would be the wrong answer to give them.
            StorageBackend::Keyring => {
                Err(AuthError::StorageUnavailable { backend: StorageBackend::Keyring.as_str() })
            }
        }
    }

    /// Creates the configuration directory with owner-only permissions.
    fn ensure_dir(&self) -> Result<(), AuthError> {
        let map = |source| AuthError::Store {
            operation: "create",
            path: self.dir.display().to_string(),
            source,
        };

        if self.dir.is_dir() {
            return restrict_dir(&self.dir).map_err(map);
        }
        if let Some(parent) = self.dir.parent() {
            std::fs::create_dir_all(parent).map_err(map)?;
        }
        create_private_dir(&self.dir).map_err(map)
    }

    /// Temporary file, `fsync`, rename.
    fn write_atomically(&self, bytes: &[u8]) -> Result<(), AuthError> {
        let target = self.path();
        let map = |operation: &'static str| {
            let path = target.display().to_string();
            move |source| AuthError::Store { operation, path: path.clone(), source }
        };

        // In the same directory, so the rename stays within one filesystem and
        // is therefore atomic. A temporary directory elsewhere would make it a
        // copy, which has a window in which the file is half written.
        let temporary = self.dir.join(format!(".{TOKEN_FILE_NAME}.{}.tmp", std::process::id()));

        // Best effort: a leftover from a previous crash would fail `create_new`.
        let _ = std::fs::remove_file(&temporary);

        let mut file = create_private_file(&temporary).map_err(map("create"))?;
        file.write_all(bytes).map_err(map("write"))?;
        // Before the rename, not after: a rename that lands before the data is
        // durable can leave an empty file, which reads as a corrupt session
        // rather than an absent one.
        file.sync_all().map_err(map("write"))?;
        drop(file);

        restrict_file(&temporary).map_err(map("secure"))?;

        if let Err(source) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            return Err(AuthError::Store {
                operation: "replace",
                path: target.display().to_string(),
                source,
            });
        }

        sync_dir(&self.dir).map_err(map("write"))?;
        Ok(())
    }
}

/// Reads one token file. A missing file is `Ok(None)`.
fn read_session(path: &Path) -> Result<Option<StoredSession>, AuthError> {
    let mut bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(AuthError::Store {
                operation: "read",
                path: path.display().to_string(),
                source,
            });
        }
    };

    let parsed = serde_json::from_slice::<Wire>(&bytes);
    // The buffer held the tokens in plaintext; clear it before anything else
    // can happen, including the error path.
    bytes.zeroize();

    let wire = parsed.map_err(|err| AuthError::Store {
        operation: "parse",
        path: path.display().to_string(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidData, err.to_string()),
    })?;

    if wire.version != WIRE_VERSION {
        return Err(AuthError::Store {
            operation: "read",
            path: path.display().to_string(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unknown credential file version {} (this build understands {WIRE_VERSION})",
                    wire.version
                ),
            ),
        });
    }

    Ok(Some(wire.into_session()))
}

/// Removes a file, treating one that is already gone as removed.
fn remove_if_present(path: &Path) -> Result<(), AuthError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => {
            Err(AuthError::Store { operation: "remove", path: path.display().to_string(), source })
        }
    }
}

/// Creates a file only the owner can read, with no window in which it is not.
#[cfg(unix)]
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    // The mode is set at creation. Creating first and chmodding after would
    // leave the file world-readable for as long as that takes.
    std::fs::OpenOptions::new().write(true).create_new(true).mode(TOKEN_FILE_MODE).open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

/// Creates a directory only the owner can enter.
#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt as _;

    std::fs::DirBuilder::new().mode(TOKEN_DIR_MODE).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir(path)?;
    restrict_dir(path)
}

/// Narrows an existing directory to the owner.
#[cfg(unix)]
fn restrict_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(TOKEN_DIR_MODE))
}

#[cfg(windows)]
fn restrict_dir(path: &Path) -> std::io::Result<()> {
    prick_exec::winsec::restrict_to_current_user(path, prick_exec::winsec::Inheritance::Propagating)
}

#[cfg(not(any(unix, windows)))]
#[allow(clippy::unnecessary_wraps, reason = "matches the platform implementations")]
fn restrict_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Narrows an existing file to the owner.
#[cfg(unix)]
fn restrict_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(TOKEN_FILE_MODE))
}

#[cfg(windows)]
fn restrict_file(path: &Path) -> std::io::Result<()> {
    prick_exec::winsec::restrict_to_current_user(path, prick_exec::winsec::Inheritance::ObjectOnly)
}

#[cfg(not(any(unix, windows)))]
#[allow(clippy::unnecessary_wraps, reason = "matches the platform implementations")]
fn restrict_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Whether a path grants access to nobody but its owner.
#[cfg(unix)]
fn owner_only(path: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt as _;

    let mode = std::fs::metadata(path)?.permissions().mode();
    // clippy::verbose_bit_mask suggests `trailing_zeros() >= 6`. That is the
    // same test and strictly less readable: `& 0o077 == 0` is THE idiomatic
    // spelling of "group and other have no bits", and a permission check should
    // look like a permission check. Suppressed rather than obeyed.
    //
    // This fires only on Unix, so it cannot be seen from the Windows dev
    // machine -- it took a CI run on Linux to surface.
    #[expect(clippy::verbose_bit_mask, reason = "reads as a permission mask, which is the point")]
    Ok(mode & 0o077 == 0)
}

#[cfg(windows)]
fn owner_only(path: &Path) -> std::io::Result<bool> {
    prick_exec::winsec::is_restricted_to_current_user(path)
}

#[cfg(not(any(unix, windows)))]
#[allow(clippy::unnecessary_wraps, reason = "matches the platform implementations")]
fn owner_only(_path: &Path) -> std::io::Result<bool> {
    Ok(false)
}

/// Flushes the directory entry, so the rename survives a power failure.
///
/// Only meaningful on Unix; Windows has no handle to a directory that
/// `FlushFileBuffers` accepts, and `MoveFileEx` is ordered against the file's
/// own flush.
#[cfg(unix)]
fn sync_dir(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
#[allow(
    clippy::unnecessary_wraps,
    reason = "the signature matches the Unix implementation so the caller has no cfg in it"
)]
fn sync_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
