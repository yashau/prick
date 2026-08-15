//! The `prk` executable.
//!
//! Deliberately empty of logic. Everything lives in the library so that xtask
//! can build completions and man pages from the same [`clap::Command`] the
//! binary parses with, and so tests can drive the CLI without a subprocess.

use std::process::ExitCode;

fn main() -> ExitCode {
    prk::run()
}
