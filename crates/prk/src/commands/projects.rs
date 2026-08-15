//! `prk projects`.
//!
//! Thin over `prick-api`. Authorization is resolved server-side once per
//! request, so there is nothing to check here -- and deliberately so: a client
//! that decided what a caller may do would be a second implementation of the
//! rule, and the two would drift.

use clap::Subcommand;

use prick_api::ops;
use prick_core::slug::slugify;

use crate::cli::GlobalArgs;
use crate::commands::{Context, require_slug};
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

        /// URL-safe short name, and the only way a project is addressed.
        ///
        /// Required by the server; derived from `NAME` when it is not given.
        #[arg(long, value_name = "SLUG")]
        slug: Option<String>,
    },

    /// Rename a project.
    ///
    /// Changes the display name only. The slug is how everybody else addresses
    /// the project, and there is no route that repoints it.
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
            let projects = context.block_on(ops::list_projects(client))?;

            if global.json {
                let rows: Vec<serde_json::Value> = projects
                    .iter()
                    .map(|project| {
                        serde_json::json!({
                            "id": project.id,
                            "slug": project.slug,
                            "name": project.name,
                            "description": project.description,
                            "environment_count": project.environment_count,
                        })
                    })
                    .collect();
                out.json(&serde_json::Value::Array(rows));
            } else if projects.is_empty() {
                out.note("No projects. Create one with `prk projects create <NAME>`.");
            } else {
                for project in &projects {
                    out.data(&format!(
                        "{}\t{}\t{} environment(s)",
                        project.slug, project.name, project.environment_count
                    ));
                }
            }
        }

        ProjectsCommand::Create { name, slug } => {
            // The server requires a slug and will not invent one, because the
            // slug is the identifier every other route and every script uses.
            let slug = resolve_slug("project", slug.as_deref(), name)?;
            let project = context.block_on(ops::create_project(client, &slug, name, None))?;
            report_project(&project, global, out, "Created");
        }

        ProjectsCommand::Rename { project, name } => {
            require_slug("project", project)?;
            let renamed =
                context.block_on(ops::update_project(client, project, Some(name), None))?;
            report_project(&renamed, global, out, "Renamed");
        }

        ProjectsCommand::Remove { project } => {
            require_slug("project", project)?;
            // Deleting a project cascades to its environments and their
            // secrets, which is not something to do on a typo.
            if !global.yes && !confirm(global, out, &format!("Delete project `{project}`"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            context.block_on(ops::delete_project(client, project))?;

            if global.json {
                out.json(&serde_json::json!({ "deleted": project }));
            } else {
                out.data(&format!("Deleted project `{project}`."));
            }
        }
    }

    Ok(())
}

/// Resolves the slug a create call must send.
///
/// An explicit `--slug` is validated rather than mangled: a name the user typed
/// deliberately should be rejected rather than silently turned into something
/// else. A derived one is checked too, so the failure is always local.
///
/// # Errors
///
/// [`CliError::Other`] when the slug is unusable, or when nothing usable can be
/// derived from the name.
pub fn resolve_slug(kind: &str, slug: Option<&str>, name: &str) -> Result<String, CliError> {
    match slug {
        Some(slug) => {
            require_slug(kind, slug)?;
            Ok(slug.to_owned())
        }
        None => slugify(name).ok_or_else(|| {
            CliError::Other(format!(
                "no {kind} slug could be derived from `{name}`; pass --slug <SLUG> with lowercase \
                 letters, digits and single hyphens"
            ))
        }),
    }
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
            "description": project.description,
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
    fn a_create_derives_the_slug_the_server_requires() {
        assert_eq!(resolve_slug("project", None, "Billing EU").unwrap(), "billing-eu");
    }

    #[test]
    fn an_explicit_slug_is_validated_rather_than_mangled() {
        // Silently turning `Billing EU` into `billing-eu` when it was passed to
        // --slug deliberately would create an identifier nobody asked for.
        assert_eq!(
            resolve_slug("project", Some("billing-eu"), "Billing EU").unwrap(),
            "billing-eu"
        );
        let err = resolve_slug("project", Some("Billing EU"), "Billing EU").unwrap_err();
        assert!(err.to_string().contains("billing-eu"), "{err}");
    }

    #[test]
    fn a_name_with_no_derivable_slug_says_to_pass_one() {
        let err = resolve_slug("project", None, "日本").unwrap_err();
        assert!(err.to_string().contains("--slug"), "{err}");
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
