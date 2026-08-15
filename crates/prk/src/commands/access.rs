//! `prk access`.
//!
//! # The detail that makes this usable
//!
//! A service token's identity is its `common_name`, which looks like
//! `e367826f93b8d71185e03fe518aff3b4.access`. Nobody can map that string to
//! "the staging deploy job" from memory.
//!
//! So denials are audited, and `prk access identities --denied` lists subjects
//! that were recently refused. The workflow becomes: point CI at the server,
//! watch it get a 403, then grant the identity that just appeared. No copying
//! opaque identifiers between two consoles.
//!
//! There is also **no god mode**. A global administrator is an ordinary grant
//! row with a global scope, resolved by the same code as every other grant, so
//! it is auditable and revocable. A special case in the authorization check
//! that returns "allowed" for a class of caller is the bug this design exists
//! to prevent.

use clap::Subcommand;

use prick_core::scope::Scope;

use crate::cli::GlobalArgs;
use crate::commands::{Context, projects::confirm};
use crate::error::CliError;
use crate::output::Output;

/// Access subcommands.
#[derive(Debug, Subcommand)]
pub enum AccessCommand {
    /// List grants.
    List,

    /// List identities the server has seen.
    Identities {
        /// Show only identities that were denied and have no grant.
        #[arg(long)]
        denied: bool,
    },

    /// Grant a role on a scope to an identity.
    Grant {
        /// The identity: an email address, or a service token's common name.
        #[arg(value_name = "SUBJECT")]
        subject: String,

        /// The role to grant.
        #[arg(long, value_name = "ROLE")]
        role: RoleArg,

        /// The scope, written `project:environment`. `*` is a wildcard.
        ///
        /// Split on the first colon only, so an environment name may itself
        /// contain colons.
        #[arg(long, value_name = "SCOPE", default_value = "*:*")]
        scope: String,

        /// Expire the grant after this many days.
        #[arg(long, value_name = "DAYS")]
        expires_in: Option<u32>,
    },

    /// Revoke a grant.
    Revoke {
        /// The identity to revoke.
        #[arg(value_name = "SUBJECT")]
        subject: String,

        /// The scope to revoke it on.
        #[arg(long, value_name = "SCOPE", default_value = "*:*")]
        scope: String,
    },
}

impl AccessCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "access list",
            Self::Identities { .. } => "access identities",
            Self::Grant { .. } => "access grant",
            Self::Revoke { .. } => "access revoke",
        }
    }
}

/// The roles a grant can carry, in increasing order of privilege.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, clap::ValueEnum)]
pub enum RoleArg {
    /// Read secret metadata and values.
    Reader,
    /// Everything a reader can do, plus writing secrets.
    Writer,
    /// Everything a writer can do, plus managing grants.
    Admin,
}

impl RoleArg {
    /// The name the API uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reader => "reader",
            Self::Writer => "writer",
            Self::Admin => "admin",
        }
    }
}

/// Runs an access subcommand.
///
/// # Errors
///
/// [`CliError::Scope`] for an unparsable scope, [`CliError::Auth`] if no
/// credential is available, and [`CliError::Api`] for anything the server
/// reported.
pub fn run(command: &AccessCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();

    match command {
        AccessCommand::List => {
            let url = client.url(&["grants"]);
            let grants: serde_json::Value = context.block_on(client.get_json(&url))?;
            out.json(&grants);
        }

        AccessCommand::Identities { denied } => {
            let url = if *denied {
                client.url(&["access", "unknown-identities"])
            } else {
                client.url(&["access", "identities"])
            };
            let identities: serde_json::Value = context.block_on(client.get_json(&url))?;
            out.json(&identities);

            if *denied && !global.json {
                out.note(
                    "Grant one of these with `prk access grant <SUBJECT> --role reader --scope \
                     <PROJECT>:<ENVIRONMENT>`.",
                );
            }
        }

        AccessCommand::Grant { subject, role, scope, expires_in } => {
            // Parsed rather than passed through, so a malformed scope fails
            // here with a message about scopes instead of at the server with a
            // validation error about a field.
            let parsed: Scope = scope.parse()?;

            let url = client.url(&["grants"]);
            let mut body = serde_json::json!({
                "subject": subject,
                "role": role.as_str(),
                "scope": parsed.to_string(),
            });
            if let Some(days) = expires_in {
                body["expires_in_days"] = serde_json::json!(days);
            }

            let created: serde_json::Value = context.block_on(client.post_json(&url, &body))?;

            if global.json {
                out.json(&created);
            } else {
                out.data(&format!("Granted {} to `{subject}` on `{parsed}`.", role.as_str()));
            }
        }

        AccessCommand::Revoke { subject, scope } => {
            let parsed: Scope = scope.parse()?;

            if !confirm(global, out, &format!("Revoke `{subject}` on `{parsed}`"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }

            let url = client.url(&["grants", subject, &parsed.to_string()]);
            context.block_on(client.delete(&url))?;

            if global.json {
                out.json(&serde_json::json!({ "revoked": subject, "scope": parsed.to_string() }));
            } else {
                out.data(&format!("Revoked `{subject}` on `{parsed}`."));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_order_by_privilege() {
        // Effective role is the maximum over matching grants, so the ordering
        // is behaviour rather than presentation.
        assert!(RoleArg::Reader < RoleArg::Writer);
        assert!(RoleArg::Writer < RoleArg::Admin);
        assert_eq!([RoleArg::Admin, RoleArg::Reader].into_iter().max(), Some(RoleArg::Admin));
    }

    #[test]
    fn role_names_match_what_the_api_expects() {
        assert_eq!(RoleArg::Reader.as_str(), "reader");
        assert_eq!(RoleArg::Writer.as_str(), "writer");
        assert_eq!(RoleArg::Admin.as_str(), "admin");
    }

    #[test]
    fn a_scope_is_parsed_before_it_reaches_the_server() {
        let scope: Scope = "billing:eu:west".parse().expect("a colon-bearing environment name");
        assert_eq!(scope.project(), "billing");
        // Split on the first colon only: `eu:west` is one environment name.
        assert_eq!(scope.environment(), "eu:west");
    }

    #[test]
    fn a_malformed_scope_fails_as_a_scope_error() {
        let err: CliError = "no-colon".parse::<Scope>().unwrap_err().into();
        assert_eq!(err.code(), "INVALID_SCOPE");
        assert_eq!(err.exit_code(), 11);
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        for command in [
            AccessCommand::List,
            AccessCommand::Identities { denied: true },
            AccessCommand::Grant {
                subject: "ci@example.com".to_owned(),
                role: RoleArg::Reader,
                scope: "*:*".to_owned(),
                expires_in: None,
            },
            AccessCommand::Revoke { subject: "ci@example.com".to_owned(), scope: "*:*".to_owned() },
        ] {
            assert!(command.path().starts_with("access "));
        }
    }
}
