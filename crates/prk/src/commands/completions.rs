//! `prk completions`.
//!
//! Generated from the same [`clap::Command`] the binary parses with, so a
//! completion script can never describe an interface that does not exist.
//!
//! The script is built into a buffer and handed to [`Output`], rather than
//! written to a stream directly: the workspace output discipline has no
//! exceptions, not even for content that obviously contains no secrets.

use clap::{Args, CommandFactory as _};
use clap_complete::Shell;

use crate::cli::Cli;
use crate::error::CliError;
use crate::output::Output;

/// Arguments to `prk completions`.
#[derive(Debug, Clone, Args)]
pub struct CompletionsArgs {
    /// The shell to generate a completion script for.
    #[arg(value_name = "SHELL")]
    pub shell: Shell,
}

/// Writes a completion script to stdout.
///
/// # Errors
///
/// Infallible in practice; the signature matches every other command so the
/// dispatcher stays uniform.
pub fn run(args: &CompletionsArgs, out: Output) -> Result<(), CliError> {
    let mut command = Cli::command();
    let name = command.get_name().to_owned();

    let mut buffer: Vec<u8> = Vec::new();
    clap_complete::generate(args.shell, &mut command, name, &mut buffer);

    out.data_raw(&String::from_utf8_lossy(&buffer));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script_for(shell: Shell) -> String {
        let mut command = Cli::command();
        let name = command.get_name().to_owned();
        let mut buffer: Vec<u8> = Vec::new();
        clap_complete::generate(shell, &mut command, name, &mut buffer);
        String::from_utf8(buffer).expect("completion scripts are UTF-8")
    }

    #[test]
    fn a_script_is_produced_for_every_supported_shell() {
        for shell in [Shell::Bash, Shell::Zsh, Shell::Fish, Shell::PowerShell, Shell::Elvish] {
            let script = script_for(shell);
            assert!(!script.is_empty(), "{shell} produced nothing");
            assert!(script.contains("prk"), "{shell} script does not mention the binary");
        }
    }

    #[test]
    fn the_script_covers_the_real_subcommands() {
        let script = script_for(Shell::Bash);
        for command in ["login", "logout", "whoami", "doctor", "secrets", "run", "access"] {
            assert!(script.contains(command), "bash completions omit `{command}`");
        }
    }
}
