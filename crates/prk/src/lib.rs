//! The `prk` command-line client.
//!
//! # Output discipline
//!
//! The workspace denies `clippy::print_stdout` and `clippy::print_stderr`, with
//! no exceptions anywhere: [`output`] reaches the streams through their handles
//! instead, so every byte this program writes passes through one file that can
//! be read in a minute. A secret reaching stderr is therefore a **lint
//! failure**, not something a reviewer has to catch.
//!
//! Under `--json` the contract is exact:
//!
//! | Outcome | stdout | stderr |
//! |---|---|---|
//! | Success | one JSON document | **empty** |
//! | Failure | **empty** | one JSON error envelope |
//!
//! Both halves matter. Diagnostics on stderr during a successful `--json` run
//! break callers that merge the streams; anything on stdout during a failure
//! means `prk secrets download --json > file` can write a truncated file that
//! looks plausible.
//!
//! The one thing that can put a partial document on stdout is the stream
//! refusing the rest of it, and that is what `TRUNCATED_OUTPUT` exists to say.
//! See [`output`] for when a short write is reported and when it is a reader
//! that had simply seen enough.

pub mod cli;
pub mod commands;
pub mod error;
pub mod output;

use std::process::ExitCode;

use clap::Parser as _;

pub use cli::Cli;
pub use error::CliError;
pub use output::Output;

/// Parses arguments, dispatches, and renders the outcome.
///
/// Returns an [`ExitCode`] rather than calling `std::process::exit` so that
/// destructors run -- which is what lets a token buffer be zeroized on the way
/// out. `clippy::exit` is denied workspace-wide to keep it that way.
pub fn run() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            // clap writes help and version to stdout and usage errors to
            // stderr, and reports the exit code it would have used.
            let _ = err.print();
            let code = u8::try_from(err.exit_code()).unwrap_or(prick_core::classify::EXIT_USAGE);
            return ExitCode::from(code);
        }
    };

    let out = Output::from(&cli.global);

    match commands::dispatch(&cli, out) {
        Ok(()) => finish(out),
        Err(err) => {
            out.failure(&err);
            ExitCode::from(err.exit_code())
        }
    }
}

/// Turns what happened to stdout into the exit code of a command that worked.
///
/// A command can return `Ok(())` having failed to deliver its answer: the
/// reader of a pipe closes when it has seen enough, and `prk completions bash |
/// head -2` does exactly that. Which of the two that is comes from
/// [`output::stdout_outcome`], and the reasoning behind the split is in that
/// module's header.
///
/// Only the success path consults it. A run that already has a failure to
/// report has one worth more than "and stdout was cut short as well".
fn finish(out: Output) -> ExitCode {
    match output::stdout_outcome() {
        // Nothing is said about a reader that hung up, because the stream that
        // would say it is the one that closed.
        output::StdoutOutcome::Whole | output::StdoutOutcome::ReaderGone => ExitCode::SUCCESS,
        output::StdoutOutcome::Truncated => {
            let err = CliError::TruncatedOutput(
                output::stdout_failure().unwrap_or("the stream did not say why").to_owned(),
            );
            out.failure(&err);
            ExitCode::from(err.exit_code())
        }
    }
}
