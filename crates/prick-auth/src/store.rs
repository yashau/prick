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
        let base = lookup("APPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| missing("%APPDATA%"))?;
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

/// Reads and writes the token file.
#[derive(Debug, Clone)]
pub struct TokenStore {
    dir: PathBuf,
    backend: StorageBackend,
}

impl TokenStore {
    /// Builds a store rooted at the platform's configuration directory.
    ///
    /// # Errors
    ///
    /// See [`default_config_dir`].
    pub fn new(backend: StorageBackend) -> Result<Self, AuthError> {
        Ok(Self::in_dir(default_config_dir()?, backend))
    }

    /// Builds a store rooted at a specific directory.
    pub fn in_dir(dir: impl Into<PathBuf>, backend: StorageBackend) -> Self {
        Self { dir: dir.into(), backend }
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
    /// # Errors
    ///
    /// [`AuthError::StorageUnavailable`] for the keyring backend,
    /// [`AuthError::Store`] for an unreadable or unparsable file.
    pub fn load(&self) -> Result<Option<StoredSession>, AuthError> {
        self.require_file_backend()?;

        let path = self.path();
        let mut bytes = match std::fs::read(&path) {
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
        // The buffer held the tokens in plaintext; clear it before anything
        // else can happen, including the error path.
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

    /// Writes the session, replacing whatever was there.
    ///
    /// # Errors
    ///
    /// [`AuthError::StorageUnavailable`] for the keyring backend, and
    /// [`AuthError::Store`] for any filesystem failure.
    pub fn save(&self, session: &StoredSession) -> Result<(), AuthError> {
        self.require_file_backend()?;
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
        result
    }

    /// Removes the stored session.
    ///
    /// A missing file is success: `prk logout` is idempotent by design, because
    /// the state it establishes is "no credentials", and that state is already
    /// true.
    ///
    /// # Errors
    ///
    /// [`AuthError::Store`] for a file that exists and cannot be removed.
    pub fn clear(&self) -> Result<(), AuthError> {
        let path = self.path();
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(AuthError::Store {
                operation: "remove",
                path: path.display().to_string(),
                source,
            }),
        }
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
    fn require_file_backend(&self) -> Result<(), AuthError> {
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
mod tests {
    use super::*;

    fn session() -> StoredSession {
        StoredSession {
            api_url: "https://prick.example.com".to_owned(),
            issuer: "https://example.cloudflareaccess.com".to_owned(),
            client_id: "client-123".to_owned(),
            token_endpoint: "https://example.cloudflareaccess.com/token".to_owned(),
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

        let stale = store.dir().join(format!(".{TOKEN_FILE_NAME}.{}.tmp", std::process::id()));
        std::fs::write(&stale, b"leftover from a crash").expect("write");

        store.save(&session()).expect("a stale temporary file must not wedge the store");
        assert!(!stale.exists());
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
        std::fs::write(store.path(), raw.replace("\"version\": 1", "\"version\": 99"))
            .expect("write");

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
    fn the_keyring_backend_says_so_rather_than_writing_a_file() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let store = TokenStore::in_dir(dir.path(), StorageBackend::Keyring);

        let err = store.save(&session()).expect_err("the keyring is not available");
        assert!(matches!(err, AuthError::StorageUnavailable { backend: "keyring" }));
        assert!(!store.path().exists(), "a keyring request silently wrote a file");
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
        assert!(
            session.needs_refresh(expires_at - 60, 60),
            "a token expiring mid-request is stale"
        );
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
        let dir =
            config_dir_from(|name| (name == CONFIG_DIR_VAR).then(|| "/scratch/prick".to_owned()))
                .expect("the override always resolves");
        assert_eq!(dir, PathBuf::from("/scratch/prick"));
    }

    #[test]
    fn an_empty_override_falls_through_to_the_platform_default() {
        let resolved = config_dir_from(|name| {
            Some(match name {
                CONFIG_DIR_VAR => String::new(),
                "HOME" => "/home/u".to_owned(),
                "APPDATA" => r"C:\Users\u\AppData\Roaming".to_owned(),
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
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o644))
            .expect("chmod");

        assert!(!store.is_owner_only().expect("readable"), "0644 was not reported as a finding");
    }
}
