//! `prk version`.
//!
//! The version is `env!("CARGO_PKG_VERSION")` and nothing else. In the
//! repository that reads `0.0.0-dev`; a release stamps the real `YYYY.MMDD.N`
//! into the manifests immediately before compiling, so the binary, the git tag
//! and every published package carry the same literal with no second
//! representation to drift.
//!
//! The documented consequence is that `git checkout <tag> && cargo build`
//! reports `0.0.0-dev` unless the version is stamped first.

use crate::error::CliError;
use crate::output::Output;

/// The version this binary was compiled with.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The placeholder used everywhere in the repository.
pub const DEV_VERSION: &str = "0.0.0-dev";

/// Whether this is an unstamped development build.
pub fn is_dev_build() -> bool {
    VERSION == DEV_VERSION
}

/// Prints the version.
///
/// # Errors
///
/// Infallible in practice; the signature matches every other command so the
/// dispatcher stays uniform.
pub fn run(out: Output) -> Result<(), CliError> {
    if out.is_json() {
        out.json(&serde_json::json!({
            "name": "prk",
            "version": VERSION,
            "dev": is_dev_build(),
        }));
    } else {
        out.data(&format!("prk {VERSION}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use prick_core::calver::CalVer;

    use super::*;

    #[test]
    fn the_version_is_never_empty() {
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn an_unstamped_build_is_recognisable_as_such() {
        // Guards against someone hand-editing a real version into the manifest,
        // which would make the git tag no longer the source of truth.
        if is_dev_build() {
            assert_eq!(VERSION, DEV_VERSION);
            assert!(CalVer::parse(VERSION).is_err(), "the placeholder must not parse as CalVer");
        } else {
            assert!(
                CalVer::parse(VERSION).is_ok(),
                "a stamped version must be a valid CalVer, got `{VERSION}`"
            );
        }
    }
}
