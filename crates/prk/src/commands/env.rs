//! `prk env`.
//!
//! An environment name may contain colons -- `eu:west` is a legal name -- so
//! nothing here splits one, and every name reaches the URL through
//! [`prick_core::urlpath`] rather than a `format!`. See [`prick_core::scope`]
//! for the parser that splits a *scope* on the first colon only.

use clap::Subcommand;

use crate::cli::GlobalArgs;
use crate::commands::{Context, projects::confirm};
use crate::error::CliError;
use crate::output::Output;

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

/// The project a `prk env` command operates in.
///
/// # Errors
///
/// [`CliError::Other`] naming the flag and the environment variable.
fn require_project(global: &GlobalArgs) -> Result<&str, CliError> {
    global.project.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::Other("no project selected; pass --project <NAME> or set PRK_PROJECT".to_owned())
    })
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
            let url = client.url(&["projects", project, "environments"]);
            let environments: Vec<prick_api::models::Environment> =
                context.block_on(client.get_json(&url))?;

            if global.json {
                let rows: Vec<serde_json::Value> = environments
                    .iter()
                    .map(|environment| {
                        serde_json::json!({
                            "id": environment.id,
                            "name": environment.name,
                            "rev": environment.rev,
                        })
                    })
                    .collect();
                out.json(&serde_json::Value::Array(rows));
            } else if environments.is_empty() {
                out.note("No environments. Create one with `prk env create <NAME>`.");
            } else {
                for environment in &environments {
                    out.data(&format!("{}\trev {}", environment.name, environment.rev));
                }
            }
        }

        EnvCommand::Create { name } => {
            let url = client.url(&["projects", project, "environments"]);
            let body = serde_json::json!({ "name": name });
            let environment: prick_api::models::Environment =
                context.block_on(client.post_json(&url, &body))?;

            if global.json {
                out.json(&serde_json::json!({
                    "id": environment.id,
                    "name": environment.name,
                    "rev": environment.rev,
                }));
            } else {
                out.data(&format!("Created environment `{}`.", environment.name));
            }
        }

        EnvCommand::Remove { name } => {
            if !confirm(global, out, &format!("Delete environment `{name}` and all its secrets"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            let url = client.url(&["projects", project, "environments", name]);
            context.block_on(client.delete(&url))?;

            if global.json {
                out.json(&serde_json::json!({ "deleted": name }));
            } else {
                out.data(&format!("Deleted environment `{name}`."));
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
            EnvCommand::Create { name: "eu:west".to_owned() },
            EnvCommand::Remove { name: "eu:west".to_owned() },
        ] {
            assert!(command.path().starts_with("env "));
        }
    }
}
