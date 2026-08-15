//! `prk projects`.
//!
//! Thin over `prick-api`. Authorization is resolved server-side once per
//! request, so there is nothing to check here -- and deliberately so: a client
//! that decided what a caller may do would be a second implementation of the
//! rule, and the two would drift.

use clap::Subcommand;

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;

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

/// Runs a project subcommand.
///
/// # Errors
///
/// [`CliError::Auth`] if no credential is available, [`CliError::Api`] for
/// anything the server reported.
pub fn run(command: &ProjectsCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();

    match command {
        ProjectsCommand::List => {
            let url = client.url(&["projects"]);
            let projects: Vec<prick_api::models::Project> =
                context.block_on(client.get_json(&url))?;

            if global.json {
                let rows: Vec<serde_json::Value> = projects
                    .iter()
                    .map(|project| {
                        serde_json::json!({
                            "id": project.id,
                            "slug": project.slug,
                            "name": project.name,
                        })
                    })
                    .collect();
                out.json(&serde_json::Value::Array(rows));
            } else if projects.is_empty() {
                out.note("No projects. Create one with `prk projects create <NAME>`.");
            } else {
                for project in &projects {
                    out.data(&format!("{}\t{}", project.slug, project.name));
                }
            }
        }

        ProjectsCommand::Create { name, slug } => {
            let url = client.url(&["projects"]);
            let mut body = serde_json::json!({ "name": name });
            if let Some(slug) = slug {
                body["slug"] = serde_json::Value::String(slug.clone());
            }
            let project: prick_api::models::Project =
                context.block_on(client.post_json(&url, &body))?;
            report_project(&project, global, out, "Created");
        }

        ProjectsCommand::Rename { project, name } => {
            let url = client.url(&["projects", project]);
            let body = serde_json::json!({ "name": name });
            let renamed: prick_api::models::Project =
                context.block_on(client.patch_json(&url, &body))?;
            report_project(&renamed, global, out, "Renamed");
        }

        ProjectsCommand::Remove { project } => {
            // Deleting a project cascades to its environments and their
            // secrets, which is not something to do on a typo.
            if !global.yes && !confirm(global, out, &format!("Delete project `{project}`"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            let url = client.url(&["projects", project]);
            context.block_on(client.delete(&url))?;

            if global.json {
                out.json(&serde_json::json!({ "deleted": project }));
            } else {
                out.data(&format!("Deleted project `{project}`."));
            }
        }
    }

    Ok(())
}

/// Prints one project.
fn report_project(
    project: &prick_api::models::Project,
    global: &GlobalArgs,
    out: Output,
    verb: &str,
) {
    if global.json {
        out.json(&serde_json::json!({
            "id": project.id,
            "slug": project.slug,
            "name": project.name,
        }));
    } else {
        out.data(&format!("{verb} project `{}` ({}).", project.name, project.slug));
    }
}

/// Asks for confirmation on stderr, reading a line from stdin.
///
/// `--no-input` refuses rather than assuming: a destructive default is how a
/// CI job deletes a production environment.
///
/// # Errors
///
/// [`CliError::Other`] when prompting is disabled or stdin cannot be read.
pub fn confirm(global: &GlobalArgs, out: Output, question: &str) -> Result<bool, CliError> {
    if global.yes {
        return Ok(true);
    }
    if global.no_input {
        return Err(CliError::Other(format!(
            "{question}? refusing to prompt because --no-input was given; pass --yes to confirm"
        )));
    }

    out.note(&format!("{question}? [y/N] "));

    let mut answer = String::new();
    std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut answer)
        .map_err(|err| CliError::Other(format!("could not read the answer: {err}")))?;

    Ok(matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ColorChoice;

    fn global(yes: bool, no_input: bool) -> GlobalArgs {
        GlobalArgs {
            json: false,
            color: ColorChoice::Auto,
            quiet: true,
            verbose: 0,
            no_input,
            yes,
            api_url: None,
            access_client_id: None,
            access_client_secret: None,
            access_client_secret_file: None,
            project: None,
            env: None,
            timeout: 30,
        }
    }

    fn quiet() -> Output {
        Output::new(false, true, 0, ColorChoice::Auto)
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        for command in [
            ProjectsCommand::List,
            ProjectsCommand::Create { name: "a".to_owned(), slug: None },
            ProjectsCommand::Rename { project: "a".to_owned(), name: "b".to_owned() },
            ProjectsCommand::Remove { project: "a".to_owned() },
        ] {
            assert!(command.path().starts_with("projects "));
        }
    }

    #[test]
    fn yes_confirms_without_asking() {
        assert!(confirm(&global(true, false), quiet(), "Delete").unwrap());
        // Even with prompting disabled: an explicit --yes is an answer.
        assert!(confirm(&global(true, true), quiet(), "Delete").unwrap());
    }

    #[test]
    fn no_input_refuses_rather_than_assuming_yes() {
        // A destructive default is how a CI job deletes production.
        let err = confirm(&global(false, true), quiet(), "Delete project `x`").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("--no-input"), "{message}");
        assert!(message.contains("--yes"), "{message}");
    }
}
