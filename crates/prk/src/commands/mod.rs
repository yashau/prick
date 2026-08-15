//! Command implementations.
//!
//! # Status
//!
//! The interface is complete; the behaviour is not. Every command that needs
//! the network returns [`CliError::NotImplemented`], which is a real error with
//! a real exit code rather than a stub that prints and returns success.
//! `prk completions` and `prk version` are fully wired.
//!
//! # House rules
//!
//! - A command never writes to a stream directly. It takes an [`Output`] and
//!   calls into it; the workspace lints make anything else a build failure.
//! - A command returns `Result<(), CliError>`. Rendering the failure is
//!   [`crate::run`]'s job, so the `--json` contract is enforced in one place
//!   instead of being reimplemented per command.

pub mod access;
pub mod auth;
pub mod completions;
pub mod doctor;
pub mod env;
pub mod projects;
pub mod run;
pub mod secrets;
pub mod version;

use crate::cli::{Cli, Command};
use crate::error::CliError;
use crate::output::Output;

/// Routes a parsed invocation to its implementation.
///
/// # Errors
///
/// Whatever the command returns. Unimplemented commands return
/// [`CliError::NotImplemented`].
pub fn dispatch(cli: &Cli, out: Output) -> Result<(), CliError> {
    out.debug(1, &format!("dispatching `prk {}`", cli.command.path()));

    match &cli.command {
        Command::Completions(args) => completions::run(args, out),
        Command::Version => version::run(out),
        other => Err(CliError::NotImplemented { command: other.path() }),
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use super::*;
    use crate::cli::ColorChoice;

    fn quiet() -> Output {
        Output::new(false, true, 0, ColorChoice::Auto)
    }

    #[test]
    fn unimplemented_commands_fail_rather_than_silently_succeeding() {
        for argv in [
            vec!["prk", "login", "https://prick.example.com"],
            vec!["prk", "logout"],
            vec!["prk", "whoami"],
            vec!["prk", "doctor"],
            vec!["prk", "projects", "list"],
            vec!["prk", "env", "list"],
            vec!["prk", "secrets", "list"],
            vec!["prk", "run", "--", "true"],
            vec!["prk", "access", "list"],
        ] {
            let cli = Cli::try_parse_from(&argv).unwrap();
            let err = dispatch(&cli, quiet()).unwrap_err();
            assert!(
                matches!(err, CliError::NotImplemented { .. }),
                "{argv:?} returned {err:?} instead of NotImplemented"
            );
            assert_ne!(err.exit_code(), 0);
        }
    }

    #[test]
    fn the_wired_commands_succeed() {
        for argv in [vec!["prk", "version"], vec!["prk", "completions", "bash"]] {
            let cli = Cli::try_parse_from(&argv).unwrap();
            assert!(dispatch(&cli, quiet()).is_ok(), "{argv:?} failed");
        }
    }
}
