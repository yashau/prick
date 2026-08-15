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
//!
//! # A subject is not an identity id
//!
//! `POST /grants` takes an `identity_id`, and `DELETE /grants/{id}` takes the
//! grant's own uuid. Neither takes a subject, and neither takes a scope string.
//! So this module resolves both: a subject becomes an identity through
//! `GET /identities`, and a revocation finds the one grant that matches the
//! subject and the scope. Asking an operator to paste uuids between two
//! consoles is exactly the workflow this CLI exists to avoid.
//!
//! # Groups, and what this command therefore cannot tell you
//!
//! The server has a group surface: `/groups`, its members, and grants held by a
//! **group** rather than by a person. This command does not use it, and that is
//! a deliberate stopping point rather than an oversight -- but it has a
//! consequence worth being loud about.
//!
//! `GET /grants` lists **direct** grants only. Group-held grants live under
//! `/groups/{id}/grants`, so "who can read production" is the union of the two
//! and `prk access list` is half of it. A listing that looked complete and was
//! not is how a revocation gets signed off while the access it was meant to
//! remove is still in place -- so the human-mode listing says so, and the
//! revocation path says so when it finds nothing to revoke.
//!
//! `GET /identities/{id}/effective-permissions` is the route that answers the
//! whole question, sources and all. Wiring it up is the next command to write
//! here, not a change to these ones.

use std::time::{SystemTime, UNIX_EPOCH};

use clap::Subcommand;

use prick_api::models::{Grant, Identity};
use prick_api::{GrantScope, ops};
use prick_core::scope::Scope;

use crate::cli::GlobalArgs;
use crate::commands::{Context, naming, projects::confirm};
use crate::error::CliError;
use crate::output::Output;

/// Access subcommands.
#[derive(Debug, Subcommand)]
pub enum AccessCommand {
    /// List grants held directly by an identity.
    ///
    /// Not grants held by a group. The server keeps those under a separate
    /// route, so an identity can hold a role this listing does not show.
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
        ///
        /// It must have authenticated at least once, because that is when the
        /// server first learns the subject exists. `prk access identities
        /// --denied` lists the ones that tried and were refused.
        #[arg(value_name = "SUBJECT")]
        subject: String,

        /// The role to grant.
        #[arg(long, value_name = "ROLE")]
        role: RoleArg,

        /// The scope, written `project:environment`. `*` is a wildcard.
        ///
        /// `*:*` is global, `billing:*` is a whole project, `billing:eu-west`
        /// is one environment. `*:something` is not a scope the server has.
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
            let grants = context.block_on(ops::list_grants(client))?;
            report_grants(&grants, global, out);
        }

        AccessCommand::Identities { denied: true } => {
            let denied = context.block_on(ops::list_unknown_identities(client))?;

            if global.json {
                let rows: Vec<serde_json::Value> = denied
                    .iter()
                    .map(|entry| {
                        serde_json::json!({
                            "kind": entry.kind,
                            "subject": entry.subject,
                            "first_seen_at": entry.first_seen_at,
                            "last_seen_at": entry.last_seen_at,
                            "attempts": entry.attempts,
                        })
                    })
                    .collect();
                out.json(&serde_json::Value::Array(rows));
            } else if denied.is_empty() {
                out.note("Nothing has been denied and left ungranted.");
            } else {
                for entry in &denied {
                    out.data(&format!(
                        "{}\t{}\t{} attempt(s)",
                        entry.subject, entry.kind, entry.attempts
                    ));
                }
                out.note(
                    "Grant one of these with `prk access grant <SUBJECT> --role reader --scope \
                     <PROJECT>:<ENVIRONMENT>`.",
                );
            }
        }

        AccessCommand::Identities { denied: false } => {
            let identities = context.block_on(ops::list_identities(client))?;

            if global.json {
                let rows: Vec<serde_json::Value> = identities.iter().map(identity_json).collect();
                out.json(&serde_json::Value::Array(rows));
            } else if identities.is_empty() {
                out.note("No identities have authenticated yet.");
            } else {
                for identity in &identities {
                    let disabled = if identity.disabled { "\tDISABLED" } else { "" };
                    out.data(&format!("{}\t{}{disabled}", identity.subject, identity.kind));
                }
            }
        }

        AccessCommand::Grant { subject, role, scope, expires_in } => {
            // Parsed rather than passed through, so a malformed scope fails
            // here with a message about scopes instead of at the server with a
            // validation error about a field.
            let parsed: Scope = scope.parse()?;
            require_scope_slugs(&parsed)?;
            let grant_scope = GrantScope::from_scope(&parsed)?;

            // The API grants to an identity id. Resolving it here is what keeps
            // the workflow "watch CI get a 403, then grant the subject that
            // appeared" rather than "find the uuid first".
            let identity = resolve_identity(&context, subject)?;
            let expires_at = expires_in.map(expires_at_from_now).transpose()?;

            let grant = context.block_on(ops::create_grant(
                client,
                &identity.id,
                role.as_str(),
                grant_scope,
                expires_at,
            ))?;

            if global.json {
                out.json(&grant_json(&grant));
            } else {
                out.data(&format!("Granted {} to `{subject}` on `{parsed}`.", role.as_str()));
            }
        }

        AccessCommand::Revoke { subject, scope } => {
            let parsed: Scope = scope.parse()?;

            // Revocation is by the grant's own id, so the pair the operator
            // typed has to be resolved to exactly one row first.
            let grants = context.block_on(ops::list_grants(client))?;
            let grant = find_grant(&grants, subject, &parsed)?;

            if !confirm(global, out, &format!("Revoke `{subject}` on `{parsed}`"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }

            context.block_on(ops::revoke_grant(client, &grant.id))?;

            if global.json {
                out.json(&serde_json::json!({
                    "revoked": subject,
                    "scope": parsed.to_string(),
                    "grant_id": grant.id,
                }));
            } else {
                out.data(&format!("Revoked `{subject}` on `{parsed}`."));
            }
        }
    }

    Ok(())
}

/// Rejects a scope whose concrete halves could not appear in a URL.
///
/// Both are validated against the slug grammar the server enforces, so a
/// mistyped project fails here rather than as a 422 about a schema.
///
/// # Errors
///
/// [`CliError::Other`] naming the offending half.
fn require_scope_slugs(scope: &Scope) -> Result<(), CliError> {
    if !scope.is_project_wildcard() {
        naming::require_slug("project", scope.project())?;
    }
    if !scope.is_environment_wildcard() {
        naming::require_slug("environment", scope.environment())?;
    }
    Ok(())
}

/// Turns "expires in N days" into the absolute epoch-millisecond deadline the
/// API stores.
///
/// Absolute rather than relative, because a grant that expires is a fact about
/// a moment in time and the server should not have to guess when the request
/// was made.
///
/// # Errors
///
/// [`CliError::Other`] if the system clock is before the Unix epoch, or if the
/// deadline does not fit in the field.
fn expires_at_from_now(days: u32) -> Result<i64, CliError> {
    /// Milliseconds in a day.
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CliError::Other("the system clock is before 1970".to_owned()))?;

    let now_ms = i64::try_from(now.as_millis())
        .map_err(|_| CliError::Other("the system clock is implausibly far ahead".to_owned()))?;

    i64::from(days)
        .checked_mul(DAY_MS)
        .and_then(|offset| now_ms.checked_add(offset))
        .ok_or_else(|| CliError::Other(format!("--expires-in {days} is too far in the future")))
}

/// Finds the identity row for a subject.
///
/// # Errors
///
/// [`CliError::Api`] for the listing itself, and [`CliError::Other`] when no
/// identity has that subject -- which is the normal state for a service token
/// that has never been used, and is fixed by using it once.
fn resolve_identity(context: &Context, subject: &str) -> Result<Identity, CliError> {
    let identities = context.block_on(ops::list_identities(context.client()))?;

    identities.into_iter().find(|identity| identity.subject == subject).ok_or_else(|| {
        CliError::Other(format!(
            "no identity has authenticated as `{subject}`, so there is nothing to grant a role to \
             yet; have it make one request, then check `prk access identities --denied`"
        ))
    })
}

/// Finds the one grant a subject holds at a scope.
///
/// # Errors
///
/// [`CliError::Other`] when there is no such grant, or when more than one row
/// matches -- which the server's uniqueness rules make impossible, so it is
/// reported rather than resolved by picking one.
fn find_grant<'a>(
    grants: &'a [Grant],
    subject: &str,
    scope: &Scope,
) -> Result<&'a Grant, CliError> {
    let wanted = scope.to_string();
    let mut matching =
        grants.iter().filter(|grant| grant.subject == subject && grant.scope() == wanted);

    let grant = matching.next().ok_or_else(|| {
        // Naming groups here matters: "no grant" is otherwise read as "no
        // access", and the operator stops looking while the access remains.
        CliError::Other(format!(
            "`{subject}` holds no direct grant on `{scope}`. `prk access list` shows what they do \
             hold directly -- but a role reaching this scope through a group is revoked by \
             removing them from the group, which this command cannot do."
        ))
    })?;

    if matching.next().is_some() {
        return Err(CliError::Other(format!(
            "`{subject}` holds more than one grant on `{scope}`; revoke them by id through the \
             admin UI and report this, because the server should not allow it"
        )));
    }

    Ok(grant)
}

/// Prints a grant listing.
fn report_grants(grants: &[Grant], global: &GlobalArgs, out: Output) {
    if global.json {
        let rows: Vec<serde_json::Value> = grants.iter().map(grant_json).collect();
        out.json(&serde_json::Value::Array(rows));
        return;
    }

    if grants.is_empty() {
        out.note("No direct grants.");
    } else {
        for grant in grants {
            out.data(&format!("{}\t{}\t{}", grant.subject, grant.role, grant.scope()));
        }
    }

    // Said every time, including when the list is empty -- especially then. An
    // empty listing reads as "nobody has access", and with group grants in the
    // model that is a conclusion this command cannot support.
    out.note(
        "Direct grants only. A role held through a group is not listed here; the admin UI shows \
         the full picture for an identity.",
    );
}

/// One grant, as a JSON document.
fn grant_json(grant: &Grant) -> serde_json::Value {
    serde_json::json!({
        "id": grant.id,
        "identity_id": grant.identity_id,
        "subject": grant.subject,
        "role": grant.role,
        "scope_type": grant.scope_type,
        "scope": grant.scope(),
        "project": grant.project_slug,
        "environment": grant.environment_slug,
        "expires_at": grant.expires_at,
    })
}

/// One identity, as a JSON document.
fn identity_json(identity: &Identity) -> serde_json::Value {
    serde_json::json!({
        "id": identity.id,
        "kind": identity.kind,
        "subject": identity.subject,
        "display_name": identity.display_name,
        "disabled": identity.disabled,
        "last_seen_at": identity.last_seen_at,
    })
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

    fn grant(subject: &str, scope_type: &str, project: Option<&str>, env: Option<&str>) -> Grant {
        serde_json::from_value(serde_json::json!({
            "id": format!("grant-{subject}-{scope_type}"),
            "identityId": "identity-1",
            "subject": subject,
            "role": "reader",
            "scopeType": scope_type,
            "projectSlug": project,
            "environmentSlug": env,
            "expiresAt": null,
        }))
        .expect("the shape matches the server's grant row")
    }

    #[test]
    fn a_scope_is_parsed_before_it_reaches_the_server() {
        let scope: Scope = "billing:eu-west".parse().expect("a project and an environment");
        assert_eq!(scope.project(), "billing");
        assert_eq!(scope.environment(), "eu-west");
    }

    #[test]
    fn a_scope_whose_halves_are_not_slugs_is_refused_locally() {
        // The server's path parameters and grant bodies are both validated
        // against the slug grammar, so `eu:west` is a 422 rather than a name.
        let scope: Scope = "billing:eu:west".parse().expect("splits on the first colon");
        let err = require_scope_slugs(&scope).expect_err("`eu:west` is not addressable");
        assert!(err.to_string().contains("eu:west"), "{err}");
    }

    #[test]
    fn the_three_scope_spellings_map_onto_the_three_grant_scopes() {
        for (spelling, expected) in [
            ("*:*", GrantScope::Global),
            ("billing:*", GrantScope::Project { project: "billing" }),
            (
                "billing:eu-west",
                GrantScope::Environment { project: "billing", environment: "eu-west" },
            ),
        ] {
            let scope: Scope = spelling.parse().expect("a scope");
            require_scope_slugs(&scope).expect("the halves are slugs");
            assert_eq!(GrantScope::from_scope(&scope).expect("a grantable scope"), expected);
        }
    }

    #[test]
    fn revocation_finds_the_one_grant_that_matches_the_subject_and_scope() {
        let grants = [
            grant("ci@example.com", "global", None, None),
            grant("ci@example.com", "environment", Some("billing"), Some("eu-west")),
            grant("ada@example.com", "environment", Some("billing"), Some("eu-west")),
        ];

        let scope: Scope = "billing:eu-west".parse().expect("a scope");
        let found = find_grant(&grants, "ci@example.com", &scope).expect("one match");
        assert_eq!(found.id, "grant-ci@example.com-environment");

        let global: Scope = "*:*".parse().expect("a scope");
        assert_eq!(
            find_grant(&grants, "ci@example.com", &global).expect("one match").id,
            "grant-ci@example.com-global"
        );
    }

    #[test]
    fn revoking_a_grant_nobody_holds_says_where_to_look() {
        let grants = [grant("ci@example.com", "global", None, None)];
        let scope: Scope = "billing:eu-west".parse().expect("a scope");

        let err = find_grant(&grants, "ci@example.com", &scope).expect_err("no such grant");
        assert!(err.to_string().contains("prk access list"), "{err}");
        // "No grant" must not be read as "no access": the role may be held
        // through a group, which this route does not list and cannot revoke.
        assert!(err.to_string().contains("group"), "{err}");
    }

    #[test]
    fn an_expiry_is_sent_as_an_absolute_deadline_in_the_future() {
        let deadline = expires_at_from_now(30).expect("a deadline");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_millis();

        let now = i64::try_from(now).expect("a plausible clock");
        assert!(deadline > now, "an expiry must be in the future");
        // 30 days, in milliseconds, with a second of slack for a slow test.
        assert!((deadline - now - 30 * 24 * 60 * 60 * 1000).abs() < 1000);
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
