//! Token persistence.
//!
//! # Status
//!
//! Skeleton. The backends are named and the file mode is fixed; nothing is
//! written yet.
//!
//! TODO:
//!
//! - Resolve the token path from the platform config directory.
//! - Write with mode `0600` on Unix, creating the parent directory with `0700`.
//!   Write to a temporary file in the same directory and rename over the
//!   target, so an interrupted write never truncates a working token.
//! - On Windows, restrict the DACL to the current user; there is no `0600`.
//! - Zeroize the buffer after use.
//! - Implement the keyring backend behind `--storage keyring`.

/// The file mode tokens are written with on Unix. Owner read/write only.
pub const TOKEN_FILE_MODE: u32 = 0o600;

/// The directory mode the token's parent is created with on Unix.
pub const TOKEN_DIR_MODE: u32 = 0o700;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
