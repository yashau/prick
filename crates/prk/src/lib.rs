//! The `prk` command-line client.
//!
//! # Output discipline
//!
//! The workspace denies `clippy::print_stdout` and `clippy::print_stderr`.
//! [`output`] is the only module that lifts the ban, so every byte this program
//! writes passes through one file that can be read in a minute. A secret
//! reaching stderr is therefore a **lint failure**, not something a reviewer has
//! to catch.
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
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            out.failure(&err);
            ExitCode::from(err.exit_code())
        }
    }
}
