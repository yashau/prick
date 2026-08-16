//! `prk projects`.
//!
//! Thin over `prick-api`. Authorization is resolved server-side once per
//! request, so there is nothing to check here -- and deliberately so: a client
//! that decided what a caller may do would be a second implementation of the
//! rule, and the two would drift.

use clap::Subcommand;

use prick_api::models::Project;
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

    /// Show one project.
    ///
    /// `list` filtered down to one row would answer a different question: this
    /// reads `GET /projects/{project}`, so a project that does not exist and one
    /// no grant of yours covers both answer `NOT_FOUND`. A slug missing from
    /// `list` is therefore not a slug that is free.
    Get {
        /// The project to show.
        #[arg(value_name = "PROJECT")]
        project: String,
    },

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
            Self::Get { .. } => "projects get",
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

        ProjectsCommand::Get { project } => {
            require_slug("project", project)?;
            // `ops`, rather than a URL assembled here: a request built outside
            // it is invisible to the contract test, which is the only thing
            // that notices a route that no longer exists.
            let found = context.block_on(ops::get_project(client, project))?;

            if global.json {
                out.json(&project_json(&found));
            } else {
                for line in describe_project(&found) {
                    out.data(&line);
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

/// One project in full, as a JSON document.
///
/// Snake case, and the same key for the same field as `projects list` --
/// `environment_count`, not `environmentCount` and not `environments`. A
/// sibling command that spelled a field its own way is something every script
/// reading both has to special-case.
///
/// It carries `updated_at` as well, which the listing does not: a read of one
/// project that returned strictly less than the listing row for it would leave
/// nothing for this command to be for.
fn project_json(project: &Project) -> serde_json::Value {
    serde_json::json!({
        "id": project.id,
        "slug": project.slug,
        "name": project.name,
        "description": project.description,
        "environment_count": project.environment_count,
        "updated_at": project.updated_at,
    })
}

/// The human-mode rendering of one project, as lines.
///
/// A value rather than a series of `out.data` calls, so that a test can assert
/// on the shape of the output. `updated_at` is deliberately absent: it is epoch
/// milliseconds, nothing in this CLI formats a timestamp, and a raw integer
/// under a heading reads as an identifier. `--json` carries it for the callers
/// that can do something with it.
fn describe_project(project: &Project) -> Vec<String> {
    vec![
        format!("{}\t{}", project.slug, project.name),
        format!("id\t{}", project.id),
        // "none" rather than an empty column: a blank after a label reads as a
        // rendering fault rather than as an absent description.
        format!("description\t{}", project.description.as_deref().unwrap_or("none")),
        format!("environments\t{}", project.environment_count),
    ]
}

/// Prints one project.
fn report_project(project: &Project, global: &GlobalArgs, out: Output, verb: &str) {
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
    use clap::Parser as _;

    use super::*;
    use crate::cli::{Cli, ColorChoice, Command};

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

    /// A project row in the shape the server sends one.
    ///
    /// Deserialised rather than constructed: `Project` is `#[non_exhaustive]`,
    /// and going through serde means a field the server renames breaks these
    /// tests instead of quietly rendering a default.
    fn project(slug: &str, name: &str, description: Option<&str>) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": format!("project-{slug}"),
            "slug": slug,
            "name": name,
            "description": description,
            "environmentCount": 3,
            "updatedAt": 1_760_000_000_000_i64,
        }))
        .expect("the shape matches the server's project row")
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        let mut paths = Vec::new();

        for command in [
            ProjectsCommand::List,
            ProjectsCommand::Get { project: "a".to_owned() },
            ProjectsCommand::Create { name: "a".to_owned(), slug: None },
            ProjectsCommand::Rename { project: "a".to_owned(), name: "b".to_owned() },
            ProjectsCommand::Remove { project: "a".to_owned() },
        ] {
            assert!(command.path().starts_with("projects "));
            paths.push(command.path());
        }

        // A copy-pasted arm reports a sibling's name, and `prk -v` then says it
        // is dispatching a command the user did not type.
        let unique: std::collections::BTreeSet<&str> = paths.iter().copied().collect();
        assert_eq!(unique.len(), paths.len(), "two subcommands share a path: {paths:?}");
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

    // -----------------------------------------------------------------------
    // `projects get`
    // -----------------------------------------------------------------------

    /// The invocation `docs/reference/cli/projects.md` prints, character for character.
    #[test]
    fn the_documented_get_invocation_parses_as_a_read_of_one_project() {
        let cli = Cli::try_parse_from(["prk", "projects", "get", "api"])
            .expect("the invocation printed in docs/reference/cli/projects.md must parse");

        let Command::Projects(ProjectsCommand::Get { project }) = cli.command else {
            panic!("`projects get` did not parse as itself");
        };
        assert_eq!(project, "api");
    }

    #[test]
    fn the_human_rendering_carries_every_field_the_project_has() {
        // A renderer that printed the slug and stopped would still look like
        // output, and `list` already prints the slug.
        let lines = describe_project(&project("billing", "Billing EU", Some("Invoicing")));

        assert_eq!(lines[0], "billing\tBilling EU");
        assert!(lines.iter().any(|line| line == "description\tInvoicing"), "{lines:?}");
        assert!(lines.iter().any(|line| line == "environments\t3"), "{lines:?}");
        assert!(lines.iter().any(|line| line == "id\tproject-billing"), "{lines:?}");
    }

    #[test]
    fn two_different_projects_do_not_render_the_same_lines() {
        // The failure this is here for: a renderer that emits a constant, or
        // one that renders a field of something other than its argument.
        let one = describe_project(&project("billing", "Billing EU", Some("Invoicing")));
        let two = describe_project(&project("payments", "Payments", Some("Card capture")));

        assert_ne!(one, two);
        assert!(!one.join("\n").contains("payments"), "{one:?}");
        assert!(!two.join("\n").contains("billing"), "{two:?}");
    }

    #[test]
    fn a_project_with_no_description_says_so_rather_than_printing_an_empty_column() {
        let lines = describe_project(&project("billing", "Billing EU", None));
        assert!(lines.iter().any(|line| line == "description\tnone"), "{lines:?}");
    }

    #[test]
    fn the_json_document_carries_the_projects_fields() {
        let document = project_json(&project("billing", "Billing EU", Some("Invoicing")));

        assert_eq!(document["id"], "project-billing");
        assert_eq!(document["slug"], "billing");
        assert_eq!(document["name"], "Billing EU");
        assert_eq!(document["description"], "Invoicing");
        assert_eq!(document["environment_count"], 3);
        assert_eq!(document["updated_at"], 1_760_000_000_000_i64);
    }

    #[test]
    fn the_json_keys_are_the_snake_case_ones_the_other_commands_emit() {
        // `prk projects list` emits `environment_count`. A second spelling for
        // the same field in a sibling command is a thing every script reading
        // both has to special-case.
        let document = project_json(&project("billing", "Billing EU", Some("Invoicing")));

        for key in ["id", "slug", "name", "description", "environment_count", "updated_at"] {
            assert!(document.get(key).is_some(), "`{key}` is missing from the document");
        }
        assert!(
            document.get("environmentCount").is_none(),
            "the camel-case spelling must not leak through"
        );
        assert!(document.get("updatedAt").is_none());
    }

    #[test]
    fn an_absent_description_is_null_rather_than_missing() {
        // A key that disappears when the value is absent makes every consumer
        // handle two shapes for one field.
        let document = project_json(&project("billing", "Billing EU", None));
        assert_eq!(document["description"], serde_json::Value::Null);
        assert!(document.get("description").is_some());
    }
}
