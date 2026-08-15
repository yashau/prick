//! `prk projects`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! TODO: implement against `prick-api`. Authorization is resolved server-side
//! once per request, so these are thin.

use clap::Subcommand;

/// Project subcommands.
#[derive(Debug, Subcommand)]
pub enum ProjectsCommand {
    /// List projects visible to the current identity.
    List,

    /// Create a project.
    Create {
        /// The project name.
        #[arg(value_name = "NAME")]
        name: String,

        /// URL-safe short name. Defaults to a slugified `NAME`.
        #[arg(long, value_name = "SLUG")]
        slug: Option<String>,
    },

    /// Rename a project.
    Rename {
        /// The project to rename.
        #[arg(value_name = "PROJECT")]
        project: String,

        /// The new name.
        #[arg(value_name = "NAME")]
        name: String,
    },

    /// Delete a project and everything in it.
    #[command(name = "rm")]
    Remove {
        /// The project to delete.
        #[arg(value_name = "PROJECT")]
        project: String,
    },
}

impl ProjectsCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "projects list",
            Self::Create { .. } => "projects create",
            Self::Rename { .. } => "projects rename",
            Self::Remove { .. } => "projects rm",
        }
    }
}
