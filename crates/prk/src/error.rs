//! The CLI error type.
//!
//! Libraries in this workspace use `thiserror`; the binary is where those are
//! collected and given an exit code, a machine-readable code and a hint.
//!
//! TODO: render through `miette` once the API client lands. Its structured
//! `help()` channel is exactly the shape the hints already have, and it gives
//! source-span diagnostics for `.env` import failures for free.

use prick_core::classify::{EXIT_FAILURE, ErrorKind};

/// Anything that can end a `prk` run unsuccessfully.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CliError {
    /// The command exists in the interface but has no implementation yet.
    #[error("`prk {command}` is not implemented yet")]
    NotImplemented {
        /// The command path, as the user would type it.
        command: &'static str,
    },

    /// The API call failed.
    #[error(transparent)]
    Api(#[from] prick_api::ApiError),

    /// A secret set could not be rendered in the requested format.
    #[error(transparent)]
    Format(#[from] prick_core::format::FormatError),

    /// A `.env` document could not be parsed.
    #[error(transparent)]
    Dotenv(#[from] prick_core::dotenv::DotenvError),

    /// A scope string could not be parsed.
    #[error(transparent)]
    Scope(#[from] prick_core::scope::ParseScopeError),

    /// A child process would have received a variable the loader interprets.
    #[error(transparent)]
    Guard(#[from] prick_exec::GuardError),

    /// The child process could not be started.
    ///
    /// Carries the shell's own codes -- 127 for not found, 126 for found but
    /// not runnable -- rather than mapping onto the API taxonomy. A caller of
    /// `prk run` is already branching on those, and a command that could not be
    /// started must be indistinguishable from one a shell could not start.
    #[error(transparent)]
    Launch(#[from] prick_exec::LaunchError),

    /// Authentication failed.
    #[error(transparent)]
    Auth(#[from] prick_auth::AuthError),

    /// A failure with no more specific type.
    #[error("{0}")]
    Other(String),
}

impl CliError {
    /// The process exit code for this failure.
    ///
    /// The API taxonomy owns codes 3 to 11; see
    /// [`prick_core::classify::ErrorKind::exit_code`] for the table. Local
    /// failures map onto it rather than inventing parallel codes.
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Api(err) => err.exit_code(),
            Self::Auth(err) => err.exit_code(),
            // 126 and 127 are outside the taxonomy on purpose: they are the
            // shell's, and reproducing them exactly is what makes `prk run`
            // transparent to a script.
            Self::Launch(err) => u8::try_from(err.exit_code()).unwrap_or(EXIT_FAILURE),
            Self::Format(_) => prick_core::classify::EXIT_UNREPRESENTABLE,
            Self::Dotenv(_) | Self::Scope(_) | Self::Guard(_) => ErrorKind::Validation.exit_code(),
            Self::NotImplemented { .. } | Self::Other(_) => EXIT_FAILURE,
        }
    }

    /// The stable machine-readable code emitted under `--json`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Api(err) => err.kind().code(),
            Self::Auth(err) => err.code(),
            Self::Launch(_) => "LAUNCH_FAILED",
            Self::Format(_) => "UNREPRESENTABLE_OUTPUT",
            Self::Dotenv(_) => "INVALID_DOTENV",
            Self::Scope(_) => "INVALID_SCOPE",
            Self::Guard(_) => "UNSAFE_ENVIRONMENT",
            Self::NotImplemented { .. } => "NOT_IMPLEMENTED",
            Self::Other(_) => "ERROR",
        }
    }

    /// The actionable next step, rendered as `help:` under the error.
    ///
    /// Borrowed rather than `'static`, because the best hint for an API failure
    /// is often the server's own: it is about the request that just failed --
    /// which route to use instead, which variable to set -- where this client's
    /// static advice is about the whole class of failure.
    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Api(err) => err.server_hint().or_else(|| err.hint()),
            Self::Auth(err) => err.hint(),
            Self::Launch(err) => err.hint(),
            Self::Format(_) => Some(
                "The value contains a control character this format cannot encode. \
                 Use --format json or --format yaml, both of which can.",
            ),
            Self::Guard(_) => Some(
                "Rename the secret, or pass --allow-unsafe-env if the child really is \
                 meant to be configured this way.",
            ),
            Self::NotImplemented { .. } => {
                Some("This build is a skeleton. Run `prk --help` to see what is wired up.")
            }
            Self::Dotenv(_) | Self::Scope(_) | Self::Other(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use prick_core::classify::EXIT_SUCCESS;

    use super::*;

    #[test]
    fn no_failure_can_report_success() {
        let errors = [
            CliError::NotImplemented { command: "doctor" },
            CliError::Api(prick_api::ApiError::new(ErrorKind::Forbidden, "nope")),
            CliError::Guard(prick_exec::GuardError::LoaderControlled {
                name: "LD_PRELOAD".to_owned(),
            }),
            CliError::Other("something".to_owned()),
        ];

        for err in &errors {
            assert_ne!(err.exit_code(), EXIT_SUCCESS, "{err} claimed success");
            assert!(!err.code().is_empty());
        }
    }

    #[test]
    fn api_failures_keep_the_taxonomys_codes() {
        let err = CliError::Api(prick_api::ApiError::new(ErrorKind::Unauthenticated, "no token"));
        assert_eq!(err.exit_code(), 3);
        assert_eq!(err.code(), "UNAUTHENTICATED");
        assert!(err.hint().is_some_and(|h| h.contains("prk login")));
    }

    #[test]
    fn an_unrepresentable_value_gets_its_own_exit_code_and_a_way_out() {
        let err = CliError::Format(prick_core::format::FormatError::UnrepresentableControl {
            key: "K".to_owned(),
            code: 7,
            format: "env",
        });
        assert_eq!(err.exit_code(), prick_core::classify::EXIT_UNREPRESENTABLE);
        assert!(err.hint().is_some_and(|h| h.contains("json")));
    }

    #[test]
    fn a_guard_refusal_points_at_the_override() {
        let err = CliError::Guard(prick_exec::GuardError::LoaderControlled {
            name: "LD_PRELOAD".to_owned(),
        });
        assert_eq!(err.code(), "UNSAFE_ENVIRONMENT");
        assert!(err.hint().is_some_and(|h| h.contains("--allow-unsafe-env")));
    }

    #[test]
    fn not_implemented_names_the_command_it_was_given() {
        let err = CliError::NotImplemented { command: "secrets download" };
        assert_eq!(err.to_string(), "`prk secrets download` is not implemented yet");
    }

    #[test]
    fn parse_failures_convert_through_from() {
        let err: CliError = "no-colon".parse::<prick_core::scope::Scope>().unwrap_err().into();
        assert_eq!(err.code(), "INVALID_SCOPE");
        assert_eq!(err.exit_code(), 11);
    }
}
