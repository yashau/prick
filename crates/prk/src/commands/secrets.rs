//! `prk secrets`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! # Constraints these commands are built under
//!
//! - **`set` never takes a value as an argument.** A value on the command line
//!   is in the shell history and visible in `ps` to every user on the box. The
//!   value comes from a masked prompt on `/dev/tty` or from `--stdin`, and
//!   reading the prompt from the terminal device directly is what lets the two
//!   coexist.
//! - **`get` fetches one secret**, not the whole environment to print one of
//!   them.
//! - **`--output` writes mode 0600.** A world-readable file of secrets is the
//!   same defect whether it is written by mistake or by default.
//! - **A decryption failure is loud.** A row that will not decrypt fails the
//!   command or is marked unreadable; it is never quietly dropped, because a
//!   silently shorter `.env` is how a deploy goes out without `DATABASE_URL`.
//!
//! TODO: implement all of the above.

use std::path::PathBuf;

use clap::{Args, Subcommand};

use prick_core::format::OutputFormat;

/// Secret subcommands.
#[derive(Debug, Subcommand)]
pub enum SecretsCommand {
    /// List secret names and metadata. Never values.
    List,

    /// Print one secret's value.
    Get {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Set a secret's value.
    ///
    /// The value is never taken as an argument: it would be recorded in the
    /// shell history and visible to `ps`.
    Set(SetArgs),

    /// Delete a secret.
    #[command(name = "rm")]
    Remove {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Replace an environment's secrets from a file.
    Upload(UploadArgs),

    /// Write an environment's secrets to stdout or a file.
    Download(DownloadArgs),

    /// Show the version history of one secret.
    History {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Restore a secret to an earlier version.
    ///
    /// Re-encrypts the old plaintext as a new version. The old ciphertext is
    /// never resurrected, so a rolled-back value is bound to its new version.
    Rollback {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,

        /// The version to restore.
        #[arg(long, value_name = "N")]
        to: u32,
    },
}

impl SecretsCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "secrets list",
            Self::Get { .. } => "secrets get",
            Self::Set(_) => "secrets set",
            Self::Remove { .. } => "secrets rm",
            Self::Upload(_) => "secrets upload",
            Self::Download(_) => "secrets download",
            Self::History { .. } => "secrets history",
            Self::Rollback { .. } => "secrets rollback",
        }
    }
}

/// Arguments to `prk secrets set`.
#[derive(Debug, Clone, Args)]
pub struct SetArgs {
    /// The secret's key.
    #[arg(value_name = "KEY")]
    pub key: String,

    /// Read the value from stdin instead of prompting.
    ///
    /// The prompt reads the terminal device directly, so this and an
    /// interactive prompt never contend for the same stream.
    #[arg(long)]
    pub stdin: bool,

    /// A human-readable description stored alongside the secret.
    #[arg(long, value_name = "TEXT")]
    pub description: Option<String>,
}

/// Arguments to `prk secrets upload`.
#[derive(Debug, Clone, Args)]
pub struct UploadArgs {
    /// The `.env` file to read.
    #[arg(value_name = "FILE")]
    pub file: PathBuf,

    /// Report what would change and exit without writing.
    #[arg(long)]
    pub dry_run: bool,

    /// Fail unless the environment is still at this revision.
    ///
    /// Guards against overwriting a change made between reading and writing.
    #[arg(long, value_name = "REV")]
    pub expected_rev: Option<u64>,
}

/// Arguments to `prk secrets download`.
#[derive(Debug, Clone, Args)]
pub struct DownloadArgs {
    /// Output format.
    #[arg(long, value_name = "FORMAT", default_value = "env")]
    pub format: FormatArg,

    /// Write to a file instead of stdout. Created with mode 0600.
    #[arg(long, short, value_name = "FILE")]
    pub output: Option<PathBuf>,
}

/// Command-line spelling of [`OutputFormat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum FormatArg {
    /// `KEY="value"`, for a `.env` file.
    #[default]
    Env,
    /// `export KEY='value'`, for `eval`.
    Shell,
    /// A flat YAML mapping with quoted keys and values.
    Yaml,
    /// A JSON object with sorted keys.
    Json,
}

impl From<FormatArg> for OutputFormat {
    fn from(value: FormatArg) -> Self {
        match value {
            FormatArg::Env => Self::Env,
            FormatArg::Shell => Self::Shell,
            FormatArg::Yaml => Self::Yaml,
            FormatArg::Json => Self::Json,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_argument_spelling_covers_every_output_format() {
        let mapped: Vec<OutputFormat> =
            [FormatArg::Env, FormatArg::Shell, FormatArg::Yaml, FormatArg::Json]
                .into_iter()
                .map(OutputFormat::from)
                .collect();
        assert_eq!(mapped, OutputFormat::ALL.to_vec());
    }

    #[test]
    fn the_default_format_matches_the_librarys() {
        assert_eq!(OutputFormat::from(FormatArg::default()), OutputFormat::default());
    }
}
