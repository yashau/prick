//! Validation and safety classification of secret key names.
//!
//! Key names are stored in plaintext by design -- only values are encrypted --
//! so they are visible in listings, audit rows and error messages. That makes
//! them safe to echo, and it makes validating them purely a matter of keeping
//! them usable as environment variable names.
//!
//! The second job of this module is more interesting. `prk run` injects
//! secrets into a child process environment, and a handful of variable names
//! are interpreted by the dynamic loader or a language runtime *before* the
//! program's own code runs. A compromised or malicious server that can set
//! `LD_PRELOAD` achieves arbitrary code execution in the child. Those names are
//! therefore refused unless the operator passes `--allow-unsafe-env`.

use std::fmt;

/// The longest key name accepted. Long enough for any real name, short enough
/// that a name cannot be used as a smuggling channel.
pub const MAX_KEY_LEN: usize = 256;

/// Environment variables that change how a child process loads or bootstraps
/// itself, and so grant code execution to whoever controls their value.
const UNSAFE_EXACT: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "GIT_SSH_COMMAND",
    "GLIBC_TUNABLES",
    "IFS",
    "NODE_OPTIONS",
    "NODE_REPL_EXTERNAL_MODULE",
    "PATH",
    "PERL5OPT",
    "PERL5LIB",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "RUBYLIB",
    "RUBYOPT",
];

/// Prefixes covering whole families of loader-controlling variables:
/// `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES` and
/// their many siblings. A prefix rule rather than a list, because the loaders
/// keep adding new ones.
const UNSAFE_PREFIXES: &[&str] = &["LD_", "DYLD_"];

/// Why a key name was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum KeyNameError {
    /// The name was zero-length.
    #[error("a key name may not be empty")]
    Empty,
    /// The name exceeded [`MAX_KEY_LEN`].
    #[error("key name is {len} bytes, the maximum is {MAX_KEY_LEN}")]
    TooLong {
        /// The length that was supplied.
        len: usize,
    },
    /// The first character was a digit, which no shell will accept.
    #[error("key name `{name}` may not start with a digit")]
    LeadingDigit {
        /// The offending name.
        name: String,
    },
    /// A character outside `[A-Za-z0-9_]` appeared.
    #[error("key name `{name}` contains `{ch}`; only A-Z, a-z, 0-9 and _ are allowed")]
    InvalidCharacter {
        /// The offending name.
        name: String,
        /// The first character that was not allowed.
        ch: char,
    },
}

/// How safe a key name is to inject into a child process environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EnvSafety {
    /// An ordinary variable, inert until the program reads it.
    Safe,
    /// Interpreted by the loader or runtime before the program starts; setting
    /// it from a secret store is a code-execution primitive.
    LoaderControlled,
}

impl EnvSafety {
    /// Whether injecting a variable with this classification requires the
    /// operator to have passed `--allow-unsafe-env`.
    pub fn requires_opt_in(self) -> bool {
        matches!(self, Self::LoaderControlled)
    }
}

impl fmt::Display for EnvSafety {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Safe => f.write_str("safe"),
            Self::LoaderControlled => f.write_str("loader-controlled"),
        }
    }
}

/// Validates a secret key name.
///
/// The accepted grammar is `[A-Za-z_][A-Za-z0-9_]*`, up to [`MAX_KEY_LEN`]
/// bytes. That is the intersection of what POSIX shells, `.env` parsers,
/// Windows `set` and every language's environment API will accept, so a name
/// that passes here is usable in every output format without escaping.
///
/// # Errors
///
/// See [`KeyNameError`] for the individual rejection reasons.
pub fn validate(name: &str) -> Result<(), KeyNameError> {
    if name.is_empty() {
        return Err(KeyNameError::Empty);
    }
    if name.len() > MAX_KEY_LEN {
        return Err(KeyNameError::TooLong { len: name.len() });
    }

    if let Some(ch) = name.chars().find(|c| !(c.is_ascii_alphanumeric() || *c == '_')) {
        return Err(KeyNameError::InvalidCharacter { name: name.to_owned(), ch });
    }
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        return Err(KeyNameError::LeadingDigit { name: name.to_owned() });
    }

    Ok(())
}

/// Classifies a key name by how dangerous it is to inject into a child.
///
/// The comparison is case-sensitive and exact, because the loader's is. A
/// variable named `ld_preload` is genuinely inert on the platforms we support.
pub fn classify_env(name: &str) -> EnvSafety {
    if UNSAFE_EXACT.contains(&name) || UNSAFE_PREFIXES.iter().any(|p| name.starts_with(p)) {
        EnvSafety::LoaderControlled
    } else {
        EnvSafety::Safe
    }
}

/// Convenience predicate over [`classify_env`].
pub fn is_loader_controlled(name: &str) -> bool {
    classify_env(name).requires_opt_in()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_names() {
        for name in ["DATABASE_URL", "A", "_private", "S3_BUCKET_2", "lowercase"] {
            assert_eq!(validate(name), Ok(()), "rejected {name}");
        }
    }

    #[test]
    fn rejects_names_a_shell_could_not_use() {
        assert_eq!(validate(""), Err(KeyNameError::Empty));
        assert!(matches!(validate("1FOO"), Err(KeyNameError::LeadingDigit { .. })));
        assert!(matches!(validate("FOO-BAR"), Err(KeyNameError::InvalidCharacter { ch: '-', .. })));
        assert!(matches!(validate("FOO BAR"), Err(KeyNameError::InvalidCharacter { ch: ' ', .. })));
        assert!(matches!(validate("FOO="), Err(KeyNameError::InvalidCharacter { ch: '=', .. })));
        assert!(matches!(validate("FOO\nBAR"), Err(KeyNameError::InvalidCharacter { .. })));
        assert!(matches!(validate("CAFÉ"), Err(KeyNameError::InvalidCharacter { ch: 'É', .. })));
    }

    #[test]
    fn rejects_over_long_names() {
        let name = "A".repeat(MAX_KEY_LEN + 1);
        assert_eq!(validate(&name), Err(KeyNameError::TooLong { len: MAX_KEY_LEN + 1 }));
        assert_eq!(validate(&"A".repeat(MAX_KEY_LEN)), Ok(()));
    }

    #[test]
    fn loader_controlled_names_need_opt_in() {
        for name in [
            "LD_PRELOAD",
            "LD_AUDIT",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "PATH",
            "NODE_OPTIONS",
            "BASH_ENV",
            "PYTHONPATH",
            "GIT_SSH_COMMAND",
        ] {
            assert_eq!(classify_env(name), EnvSafety::LoaderControlled, "{name} not caught");
            assert!(is_loader_controlled(name));
        }
    }

    #[test]
    fn ordinary_names_are_safe() {
        for name in ["DATABASE_URL", "API_KEY", "STRIPE_SECRET", "LOAD_BALANCER", "PATHS"] {
            assert_eq!(classify_env(name), EnvSafety::Safe, "{name} falsely flagged");
            assert!(!is_loader_controlled(name));
        }
    }

    #[test]
    fn classification_is_case_sensitive_like_the_loader() {
        assert_eq!(classify_env("ld_preload"), EnvSafety::Safe);
        assert_eq!(classify_env("Path"), EnvSafety::Safe);
        assert_eq!(classify_env("LD_PRELOAD"), EnvSafety::LoaderControlled);
    }

    #[test]
    fn every_listed_unsafe_name_is_itself_a_valid_key_name() {
        // Otherwise the check would be unreachable: validation would reject the
        // name before classification ever saw it.
        for name in UNSAFE_EXACT {
            assert_eq!(validate(name), Ok(()), "{name} would never reach classification");
        }
    }
}
