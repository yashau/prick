//! Build-time generation of shell completions and man pages.
//!
//! Run as `cargo xtask <task>` via the alias in `.cargo/config.toml`.
//!
//! # Why a Rust binary rather than a script
//!
//! These artefacts are derived from the [`clap::Command`] the binary actually
//! parses with, so they cannot drift from the interface. A script would have to
//! either shell out to `prk` or re-describe the interface, and the second is
//! how a completion script ends up offering a flag that was removed.
//!
//! # Output discipline
//!
//! xtask writes its progress through [`prk::output`], the same module the
//! binary uses. That is not ceremony: it means the workspace has exactly one
//! place where `print_stdout` and `print_stderr` are permitted, and the rule is
//! true without exceptions rather than true-except-for-the-build-tool.

use std::io;
use std::path::{Path, PathBuf};

use clap::{CommandFactory as _, Parser, Subcommand};

use prk::cli::Cli as PrkCli;
use prk::output;

/// Shells to generate completion scripts for.
const SHELLS: [clap_complete::Shell; 5] = [
    clap_complete::Shell::Bash,
    clap_complete::Shell::Zsh,
    clap_complete::Shell::Fish,
    clap_complete::Shell::PowerShell,
    clap_complete::Shell::Elvish,
];

/// Repository maintenance tasks.
#[derive(Debug, Parser)]
#[command(name = "xtask", about, long_about = None, arg_required_else_help = true)]
struct Cli {
    /// The task to run.
    #[command(subcommand)]
    task: Task,
}

/// The available tasks.
#[derive(Debug, Subcommand)]
enum Task {
    /// Generate shell completion scripts.
    Completions {
        /// Directory to write into.
        #[arg(long, value_name = "DIR", default_value = "dist/completions")]
        out_dir: PathBuf,
    },

    /// Generate man pages.
    Man {
        /// Directory to write into.
        #[arg(long, value_name = "DIR", default_value = "dist/man")]
        out_dir: PathBuf,
    },

    /// Generate everything.
    All {
        /// Directory to write into. Subdirectories are created per artefact.
        #[arg(long, value_name = "DIR", default_value = "dist")]
        out_dir: PathBuf,
    },
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();

    match cli.task {
        Task::Completions { out_dir } => completions(&out_dir),
        Task::Man { out_dir } => man(&out_dir),
        Task::All { out_dir } => {
            completions(&out_dir.join("completions"))?;
            man(&out_dir.join("man"))
        }
    }
}

/// Writes a completion script per shell into `out_dir`.
fn completions(out_dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(out_dir)?;
    let mut command = PrkCli::command();
    let name = command.get_name().to_owned();

    for shell in SHELLS {
        let path = clap_complete::generate_to(shell, &mut command, &name, out_dir)?;
        output::note(&format!("wrote {}", path.display()));
    }

    Ok(())
}

/// Writes a man page for the binary and one per subcommand into `out_dir`.
fn man(out_dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(out_dir)?;
    let command = PrkCli::command();

    clap_mangen::generate_to(command, out_dir)?;
    output::note(&format!("wrote man pages to {}", out_dir.display()));

    Ok(())
}
