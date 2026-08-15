//! `prk env`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! Note that an environment name may contain colons, so nothing here may split
//! one; see [`prick_core::scope`].

use clap::Subcommand;

/// Environment subcommands.
#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    /// List environments in a project.
    List,

    /// Create an environment.
    Create {
        /// The environment name. May contain colons.
        #[arg(value_name = "NAME")]
        name: String,
    },

    /// Delete an environment and its secrets.
    #[command(name = "rm")]
    Remove {
        /// The environment to delete.
        #[arg(value_name = "NAME")]
        name: String,
    },
}

impl EnvCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "env list",
            Self::Create { .. } => "env create",
            Self::Remove { .. } => "env rm",
        }
    }
}
