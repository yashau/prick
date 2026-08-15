//! Refusing to inject variables that grant code execution in the child.
//!
//! `prk run -- <cmd>` puts secret values into a child's environment. A handful
//! of variable names are read by the dynamic loader or a language runtime
//! *before* the program's own first instruction, so whoever controls their
//! value controls what the program does. `LD_PRELOAD` is the canonical example.
//!
//! That turns a compromised or hostile server into arbitrary code execution on
//! every machine that runs `prk run`. The server is not in the trust boundary
//! for this: it stores secrets, it does not get to choose what code runs.
//!
//! So those names are **refused by default** and require `--allow-unsafe-env`.
//! The classification itself lives in [`prick_core::keyname`]; this module is
//! the policy that consumes it.

use prick_core::keyname;

/// A rejected injection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum GuardError {
    /// A secret's name is one the loader or a runtime interprets.
    #[error(
        "refusing to set `{name}` in the child environment: it is interpreted before the \
         program starts, so its value controls what code runs. Pass --allow-unsafe-env to \
         override."
    )]
    LoaderControlled {
        /// The refused variable name.
        name: String,
    },
}

/// The policy applied to a set of secrets before they reach a child.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EnvGuard {
    allow_unsafe: bool,
}

impl EnvGuard {
    /// The default policy: loader-controlling names are refused.
    pub fn strict() -> Self {
        Self { allow_unsafe: false }
    }

    /// The policy `--allow-unsafe-env` selects.
    pub fn permissive() -> Self {
        Self { allow_unsafe: true }
    }

    /// Checks a single name against the policy.
    ///
    /// # Errors
    ///
    /// Returns [`GuardError::LoaderControlled`] for a name the loader or a
    /// language runtime interprets, unless the guard is permissive.
    pub fn check(self, name: &str) -> Result<(), GuardError> {
        if !self.allow_unsafe && keyname::is_loader_controlled(name) {
            return Err(GuardError::LoaderControlled { name: name.to_owned() });
        }
        Ok(())
    }

    /// Checks every name, failing on the first refusal.
    ///
    /// Fails the whole launch rather than dropping the offending variable: a
    /// child started with a silently missing variable is a debugging problem,
    /// and a child started with a silently *present* one is a breach.
    ///
    /// # Errors
    ///
    /// See [`EnvGuard::check`].
    pub fn check_all<'a>(self, names: impl IntoIterator<Item = &'a str>) -> Result<(), GuardError> {
        for name in names {
            self.check(name)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_policy_is_strict() {
        assert_eq!(EnvGuard::default(), EnvGuard::strict());
    }

    #[test]
    fn loader_controlled_names_are_refused_by_default() {
        let guard = EnvGuard::strict();
        for name in ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "NODE_OPTIONS", "BASH_ENV"] {
            assert_eq!(
                guard.check(name),
                Err(GuardError::LoaderControlled { name: name.to_owned() }),
                "{name} was not refused"
            );
        }
    }

    #[test]
    fn ordinary_names_pass() {
        let guard = EnvGuard::strict();
        for name in ["DATABASE_URL", "API_KEY", "STRIPE_SECRET"] {
            assert_eq!(guard.check(name), Ok(()), "{name} was wrongly refused");
        }
    }

    #[test]
    fn the_opt_in_allows_everything() {
        let guard = EnvGuard::permissive();
        assert_eq!(guard.check("LD_PRELOAD"), Ok(()));
        assert_eq!(guard.check("DATABASE_URL"), Ok(()));
    }

    #[test]
    fn a_single_refusal_fails_the_whole_set() {
        let guard = EnvGuard::strict();
        let names = ["SAFE_ONE", "LD_PRELOAD", "SAFE_TWO"];
        assert_eq!(
            guard.check_all(names),
            Err(GuardError::LoaderControlled { name: "LD_PRELOAD".to_owned() })
        );
        assert_eq!(guard.check_all(["SAFE_ONE", "SAFE_TWO"]), Ok(()));
    }

    #[test]
    fn the_refusal_message_names_the_override() {
        let err = EnvGuard::strict().check("LD_PRELOAD").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("LD_PRELOAD"));
        assert!(message.contains("--allow-unsafe-env"));
    }
}
