//! The CLI error type.
//!
//! Libraries in this workspace use `thiserror`; the binary is where those are
//! collected and given an exit code, a machine-readable code and a hint.
//!
//! # Why these are not rendered through `miette`
//!
//! It was planned, once the API client landed, for two things: a structured
//! `help()` channel shaped like the hints below, and source-span diagnostics
//! for `.env` import failures. The second is why it is not going to happen.
//!
//! A span diagnostic renders the offending source line under a caret, and the
//! offending line of a `.env` file is `API_KEY=<the value>`. A parse failure is
//! exactly the moment this process is holding a file of plaintext values it has
//! not yet stored, so the diagnostic that reads best is also the one that
//! prints a secret to a terminal, to a scrollback buffer, and into whatever CI
//! captured the run. [`prick_core::dotenv::DotenvError`] is built the other way
//! round on purpose -- every variant carries a line NUMBER and at most a key
//! name, never the text of the line -- and there is nothing to give a
//! `#[source_code]` field that does not undo that.
//!
//! That leaves the `help()` channel on its own, which does not pay for a
//! dependency: [`CliError::hint`] already is one.

use prick_core::classify::{EXIT_FAILURE, ErrorKind};

/// Anything that can end a `prk` run unsuccessfully.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CliError {
    /// The command exists in the interface but has no implementation yet.
    ///
    /// Nothing constructs this today -- every arm of the dispatch in
    /// [`crate::commands::run`] reaches a real implementation. It stays because
    /// the interface is generated from `clap`, so a subcommand can be declared
    /// ahead of its body again, and because `NOT_IMPLEMENTED` is a code the
    /// server can answer with too.
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

    /// A scope string could not be parsed.
    #[error(transparent)]
    Scope(#[from] prick_core::scope::ParseScopeError),

    /// A child process would have received a variable the loader interprets.
    ///
    /// Peeled out of [`prick_exec::LaunchError`] by the `From` impl below, so
    /// a guard refusal keeps its own code rather than arriving as a launch
    /// failure. See that impl for why.
    #[error(transparent)]
    Guard(#[from] prick_exec::GuardError),

    /// The child process could not be started.
    ///
    /// Carries the shell's own codes -- 127 for not found, 126 for found but
    /// not runnable -- rather than mapping onto the API taxonomy. A caller of
    /// `prk run` is already branching on those, and a command that could not be
    /// started must be indistinguishable from one a shell could not start.
    ///
    /// No `#[from]`: the conversion is hand-written below, because one variant
    /// of [`prick_exec::LaunchError`] must not land here.
    #[error(transparent)]
    Launch(prick_exec::LaunchError),

    /// Authentication failed.
    #[error(transparent)]
    Auth(#[from] prick_auth::AuthError),

    /// stdout would not take the whole answer.
    ///
    /// Raised after the command has returned, from [`crate::run`], because that
    /// is the first moment it is known whether anything else went wrong. It is
    /// **not** every short write: a reader that closes a pipe part way through
    /// ordinary output has seen what it wanted, and that run ends quietly at 0.
    /// This is the other two cases -- a value cut in half, and a write that
    /// failed for a reason no reader chose -- where a caller is left holding
    /// something that looks whole and is not.
    ///
    /// Carries the stream's own words, because "the pipe has been ended" and
    /// "no space left on device" call for different next steps.
    #[error("stdout would not take the whole answer, so what it received is truncated: {0}")]
    TruncatedOutput(String),

    /// A failure with no more specific type.
    #[error("{0}")]
    Other(String),
}

/// Collects a launch failure, routing the guard refusal to its own variant.
///
/// `prick-exec` carries the guard refusal inside [`prick_exec::LaunchError`],
/// because that is the one type its launch API can fail with. Here it has to
/// come back out: the guard is a *rejection of the request*, decided before
/// anything is spawned, where every other variant describes a command that was
/// attempted and could not start. They are documented as different codes --
/// `UNSAFE_ENVIRONMENT` at exit 11 against `LAUNCH_FAILED` at the shell's 126
/// and 127 -- and a script branching on the refusal of a security control must
/// not have it arrive in the generic bucket.
///
/// So this cannot be `#[from]`: the derived conversion would put a `Guard`
/// into [`CliError::Launch`], and the correct mapping below would never run.
impl From<prick_exec::LaunchError> for CliError {
    fn from(err: prick_exec::LaunchError) -> Self {
        match err {
            prick_exec::LaunchError::Guard(guard) => Self::Guard(guard),
            other => Self::Launch(other),
        }
    }
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
            Self::TruncatedOutput(_) => prick_core::classify::EXIT_TRUNCATED,
            Self::Scope(_) | Self::Guard(_) => ErrorKind::Validation.exit_code(),
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
            Self::TruncatedOutput(_) => "TRUNCATED_OUTPUT",
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
            Self::TruncatedOutput(_) => Some(
                "Whatever read this got part of the answer. Write to a file with \
                 `prk secrets download --output <FILE>` instead of piping, and treat \
                 anything already written as incomplete.",
            ),
            Self::Guard(_) => Some(
                "Rename the secret, or pass --allow-unsafe-env if the child really is \
                 meant to be configured this way.",
            ),
            Self::NotImplemented { .. } => {
                Some("Run `prk --help` to see the commands this build implements.")
            }
            Self::Scope(_) | Self::Other(_) => None,
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
    fn a_truncated_stream_is_neither_an_unrepresentable_value_nor_an_oversized_response() {
        // All three are about output and mean different things: 9 is "this
        // value cannot be written in this format", 12 is "the answer was too
        // big to read in", 13 is "the format and the size were fine and the
        // stream stopped taking it". Anyone debugging a pipeline reads the
        // number first.
        let err = CliError::TruncatedOutput("the pipe has been ended".to_owned());
        assert_eq!(err.exit_code(), prick_core::classify::EXIT_TRUNCATED);
        assert_ne!(err.exit_code(), prick_core::classify::EXIT_UNREPRESENTABLE);
        assert_ne!(err.exit_code(), ErrorKind::ResponseTooLarge.exit_code());
        assert_eq!(err.code(), "TRUNCATED_OUTPUT");
        assert!(err.to_string().contains("the pipe has been ended"));
        assert!(err.hint().is_some_and(|hint| hint.contains("--output")));
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
    fn a_guard_refusal_does_not_arrive_as_a_launch_failure() {
        // `prick-exec` can only fail its launch API one way, so it carries the
        // guard refusal inside `LaunchError`. Converting has to take it back
        // out, or a refused unsafe environment is indistinguishable from a
        // command that could not be spawned.
        let err = CliError::from(prick_exec::LaunchError::from(
            prick_exec::GuardError::LoaderControlled { name: "NODE_OPTIONS".to_owned() },
        ));
        assert!(matches!(err, CliError::Guard(_)), "a guard refusal was filed as {err:?}");
        assert_eq!(err.code(), "UNSAFE_ENVIRONMENT");
        assert_eq!(err.exit_code(), 11);

        // Everything else still converts to `Launch`, keeping the shell's codes.
        let err = CliError::from(prick_exec::LaunchError::NotFound { program: "npm".to_owned() });
        assert!(matches!(err, CliError::Launch(_)));
        assert_eq!(err.code(), "LAUNCH_FAILED");
        assert_eq!(err.exit_code(), 127);
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
