//! `prk env`.
//!
//! # An environment has two names
//!
//! A **slug**, which is what every route addresses it by and what `--env`
//! takes, and a **display name**, which is free text. `eu-west` and "EU West"
//! are the same environment; only the first appears in a URL.
//!
//! The slug grammar excludes `:` outright, which is what makes the CLI's own
//! `project:environment` scope spelling unambiguous -- see
//! [`prick_core::scope`] for the parser that splits on the first colon.

use clap::Subcommand;

use prick_api::ops;

use crate::cli::GlobalArgs;
use crate::commands::{
    Context, projects::confirm, projects::resolve_slug, require_project, require_slug,
};
use crate::error::CliError;
use crate::output::Output;

/// Environment subcommands.
#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    /// List environments in a project.
    List,

    /// Create an environment.
    Create {
        /// The environment's display name.
        #[arg(value_name = "NAME")]
        name: String,

        /// URL-safe short name, and the only way an environment is addressed.
        ///
        /// Required by the server; derived from `NAME` when it is not given.
        #[arg(long, value_name = "SLUG")]
        slug: Option<String>,
    },

    /// Delete an environment and its secrets.
    #[command(name = "rm")]
    Remove {
        /// The environment to delete, by slug.
        #[arg(value_name = "SLUG")]
        slug: String,
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

/// Runs an environment subcommand.
///
/// # Errors
///
/// [`CliError::Auth`] if no credential is available, [`CliError::Api`] for
/// anything the server reported.
pub fn run(command: &EnvCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let project = require_project(global)?;

    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();

    match command {
        EnvCommand::List => {
            let environments = context.block_on(ops::list_environments(client, project))?;

            if global.json {
                let rows: Vec<serde_json::Value> = environments
                    .iter()
                    .map(|environment| {
                        serde_json::json!({
                            "id": environment.id,
                            "project_id": environment.project_id,
                            "slug": environment.slug,
                            "name": environment.name,
                            "rev": environment.rev,
                            "secret_count": environment.secret_count,
                        })
                    })
                    .collect();
                out.json(&serde_json::Value::Array(rows));
            } else if environments.is_empty() {
                out.note("No environments. Create one with `prk env create <NAME>`.");
            } else {
                for environment in &environments {
                    out.data(&format!(
                        "{}\t{}\trev {}\t{} secret(s)",
                        environment.slug,
                        environment.name,
                        environment.rev,
                        environment.secret_count
                    ));
                }
            }
        }

        EnvCommand::Create { name, slug } => {
            // Both halves are required: the server stores them separately and
            // will not derive one from the other.
            let slug = resolve_slug("environment", slug.as_deref(), name)?;
            let environment =
                context.block_on(ops::create_environment(client, project, &slug, name, None))?;

            if global.json {
                out.json(&serde_json::json!({
                    "id": environment.id,
                    "project_id": environment.project_id,
                    "slug": environment.slug,
                    "name": environment.name,
                    "rev": environment.rev,
                }));
            } else {
                out.data(&format!(
                    "Created environment `{}` ({}).",
                    environment.name, environment.slug
                ));
            }
        }

        EnvCommand::Remove { slug } => {
            require_slug("environment", slug)?;
            if !confirm(global, out, &format!("Delete environment `{slug}` and all its secrets"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            context.block_on(ops::delete_environment(client, project, slug))?;

            if global.json {
                out.json(&serde_json::json!({ "deleted": slug }));
            } else {
                out.data(&format!("Deleted environment `{slug}`."));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ColorChoice;

    fn global(project: Option<&str>) -> GlobalArgs {
        GlobalArgs {
            json: false,
            color: ColorChoice::Auto,
            quiet: true,
            verbose: 0,
            no_input: true,
            yes: false,
            api_url: None,
            access_client_id: None,
            access_client_secret: None,
            access_client_secret_file: None,
            project: project.map(str::to_owned),
            env: None,
            timeout: 30,
        }
    }

    #[test]
    fn a_project_is_required_and_the_message_names_both_ways_to_supply_it() {
        let err = require_project(&global(None)).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("--project"), "{message}");
        assert!(message.contains("PRK_PROJECT"), "{message}");
    }

    #[test]
    fn a_configured_project_is_used() {
        assert_eq!(require_project(&global(Some("billing"))).unwrap(), "billing");
    }

    #[test]
    fn an_empty_project_is_treated_as_absent() {
        // What an exported-but-empty PRK_PROJECT produces.
        assert!(require_project(&global(Some(""))).is_err());
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        for command in [
            EnvCommand::List,
            EnvCommand::Create { name: "EU West".to_owned(), slug: None },
            EnvCommand::Remove { slug: "eu-west".to_owned() },
        ] {
            assert!(command.path().starts_with("env "));
        }
    }
}
