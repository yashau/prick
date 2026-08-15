//! `prk login`, `prk logout`, `prk whoami`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! TODO: drive the handshake in `prick_auth::oauth`. The probe of `/health`
//! comes first and has three distinct outcomes, all of which must be handled:
//! managed OAuth enabled (continue), managed OAuth off (fail, naming the exact
//! dashboard path), and a `200` returned to an unauthenticated request -- which
//! means the secrets manager is exposed and must produce a loud warning through
//! [`crate::output::Output::warn`].

use clap::Args;

use prick_auth::StorageBackend;

/// Arguments to `prk login`.
#[derive(Debug, Clone, Args)]
pub struct LoginArgs {
    /// Base URL of the prick server.
    #[arg(value_name = "URL")]
    pub url: String,

    /// Where to keep the resulting token.
    ///
    /// The default is a file with owner-only permissions. The OS keyring is
    /// available but breaks over SSH and in CI, where there is no session to
    /// unlock it, and on macOS re-prompts after every update because the
    /// Keychain ACL is bound to the binary's code signature.
    #[arg(long, value_name = "BACKEND", default_value = "file")]
    pub storage: StorageBackendArg,
}

/// Command-line spelling of [`StorageBackend`].
///
/// A separate type so the `clap` derive does not have to reach into
/// `prick-auth`, which would make the library depend on the CLI's argument
/// parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum StorageBackendArg {
    /// A file with owner-only permissions.
    #[default]
    File,
    /// The operating system keyring.
    Keyring,
}

impl From<StorageBackendArg> for StorageBackend {
    fn from(value: StorageBackendArg) -> Self {
        match value {
            StorageBackendArg::File => Self::File,
            StorageBackendArg::Keyring => Self::Keyring,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_storage_is_the_headless_safe_one() {
        assert_eq!(StorageBackend::from(StorageBackendArg::default()), StorageBackend::File);
        assert!(StorageBackend::from(StorageBackendArg::default()).works_headless());
    }

    #[test]
    fn the_argument_spelling_maps_onto_the_library_type() {
        assert_eq!(StorageBackend::from(StorageBackendArg::Keyring), StorageBackend::Keyring);
    }
}
