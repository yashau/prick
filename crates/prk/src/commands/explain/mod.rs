//! `prk access explain` -- why an identity has what it has.
//!
//! # The question this answers, and why `prk access list` cannot
//!
//! `prk access list` reads `GET /grants`, which is **direct** grants only. With
//! roles arriving through groups, that listing is half the picture, and the half
//! it shows looks complete. This command reads
//! `GET /identities/{id}/effective-permissions` instead, which is the route that
//! answers the whole question.
//!
//! The value of that route is not the role. It is the **provenance**: every
//! entry carries the rows that reach it -- a grant on the environment, a grant
//! on its project, a global grant, any of those held by a group, or
//! `BOOTSTRAP_ADMINS`, which has no row behind it at all -- with exactly one
//! marked `decisive`. So this renderer never prints a role on its own. It prints
//! the role, then what conferred it, and marks the one that actually won.
//!
//! "Bob can read production **because he is in the `platform` group**" is the
//! sentence an incident needs. A listing that answered only the first half would
//! leave "what do I remove" exactly as hard as it was.
//!
//! # `decisive` is read, never inferred
//!
//! The server sorts `sources` strongest first, so the decisive source is the
//! first one today. This module does not rely on that: it reads the flag. An
//! inference that happens to agree with the server is a second implementation of
//! the resolution rule, and the two would drift silently -- the failure would be
//! a confident sentence naming the wrong group, which is worse than no sentence.
//!
//! # Its own module, in two files
//!
//! Not a section of `access.rs`, which is already 570 lines of command surface
//! and the comment that asked for this one. `lint:loc` caps a source file at
//! 1000 lines, and the cap exists because a file nobody reads end to end is
//! where a subtle change hides -- which for an authorization explanation is
//! exactly the code where it matters.
//!
//! The rendering lives in [`render`] for the same reason and along the same
//! seam the server splits `core/permissions.ts` on: this file answers "what
//! does the access graph say", that one answers "how does a human read it".
//!
//! # Where the route lives
//!
//! In [`prick_api::ops::explain_identity_permissions`], by the rule in that
//! crate's own documentation: a route is a fact about the server, not about the
//! terminal. Nothing here builds a URL, and that is what puts this request in
//! front of `crates/prick-api/tests/contract.rs`, which calls every op against
//! a mock server and compares the requests that arrive with
//! `docs/openapi.json`. A request built in this crate would be invisible to it
//! -- so the route is checked by the mechanism that exists to check routes,
//! rather than by a second copy of that check living next to the one caller.
//!
//! What is left here is reading the answer, which the op deliberately does not
//! do: see its documentation for why the document arrives as a
//! [`serde_json::Value`] and is refused by [`parse`] rather than by `serde`.

use prick_api::ops;
use serde_json::Value;

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;

mod render;

pub use render::report;

/// The spelling used for a scope half the grant does not name.
///
/// The same one [`prick_api::models::Grant::scope`] uses, so a scope printed
/// here can be pasted straight into `prk access revoke --scope`.
const WILDCARD: &str = "*";

/// A group, as the server names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRef {
    /// UUIDv7.
    pub id: String,
    /// The URL-safe short name humans and scripts address the group by.
    pub slug: String,
    /// The display name.
    pub name: String,
}

/// One thing that confers a role at a scope.
///
/// A `grants` row, a `group_grants` row reached through membership, or the
/// `BOOTSTRAP_ADMINS` variable -- which is the one source an operator cannot
/// find by searching the database, and therefore the one most worth printing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    /// `direct`, `group` or `bootstrap`.
    pub via: String,
    /// The grant's own id, or `None` for `bootstrap`, which has no row.
    pub grant_id: Option<String>,
    /// The role this source carries.
    pub role: String,
    /// `global`, `project` or `environment`. **Where the grant sits**, which may
    /// be broader than the entry it explains.
    pub scope_type: String,
    /// The project slug the grant names, if any.
    pub project: Option<String>,
    /// The environment slug the grant names, if any.
    pub environment: Option<String>,
    /// The group this came through, or `None` for a direct or bootstrap source.
    pub group: Option<GroupRef>,
    /// Absolute expiry in epoch milliseconds, or `None`.
    pub expires_at: Option<i64>,
    /// The source that set the effective role. Exactly one per entry, unless the
    /// identity is disabled, in which case none is.
    pub decisive: bool,
}

impl Source {
    /// The scope this grant sits at, spelled the way the CLI spells one.
    pub fn scope(&self) -> String {
        scope_of(self.project.as_deref(), self.environment.as_deref())
    }

    /// What this source *is*, in the words an operator would use.
    ///
    /// The group's slug is named rather than counted: "a group" is not an
    /// answer to "what do I remove".
    pub fn origin(&self) -> String {
        match self.via.as_str() {
            "group" => match self.group.as_ref() {
                Some(group) => format!("group `{}`", group.slug),
                // The schema pairs `via: "group"` with a group; saying so is
                // better than printing a source with no attribution at all.
                None => "a group the server did not name".to_owned(),
            },
            "direct" => "a direct grant".to_owned(),
            "bootstrap" => "BOOTSTRAP_ADMINS".to_owned(),
            other => format!("`{other}`"),
        }
    }
}

/// One scope, the role held there, and everything that reaches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `global`, `project` or `environment`.
    pub scope_type: String,
    /// The project slug, for a project- or environment-scoped entry.
    pub project: Option<String>,
    /// The environment slug, for an environment-scoped entry.
    pub environment: Option<String>,
    /// The effective role here. `None` only for a disabled identity.
    pub role: Option<String>,
    /// Every live grant that reaches this scope, strongest first.
    pub sources: Vec<Source>,
}

impl Entry {
    /// The scope, spelled the way the CLI spells one.
    pub fn scope(&self) -> String {
        scope_of(self.project.as_deref(), self.environment.as_deref())
    }

    /// The source the server marked `decisive`, if there is exactly one.
    ///
    /// `None` covers both the honest case -- a disabled identity, where nothing
    /// is deciding anything -- and the impossible one, where the server marked
    /// none or several. The renderer distinguishes them; this does not, because
    /// "which single row won" has no answer in either.
    pub fn decisive(&self) -> Option<&Source> {
        let mut marked = self.sources.iter().filter(|source| source.decisive);
        let first = marked.next()?;
        if marked.next().is_some() {
            return None;
        }
        Some(first)
    }
}

/// Everything the server knows about why one identity has what it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Explanation {
    /// UUIDv7.
    pub identity_id: String,
    /// `user` or `service`.
    pub kind: String,
    /// An email address for a user, a `common_name` for a service token.
    pub subject: String,
    /// An administrator-supplied label, or `None`.
    pub display_name: Option<String>,
    /// The kill switch. A disabled identity holds nothing, whatever its grants
    /// say -- and every entry then reports no role, with the sources still
    /// listed so an operator can see what re-enabling would restore.
    pub disabled: bool,
    /// When this subject last authenticated, in epoch milliseconds.
    pub last_seen_at: Option<i64>,
    /// True when this subject is named in `BOOTSTRAP_ADMINS`.
    pub bootstrap: bool,
    /// The groups this identity is in, **whether or not they confer anything**.
    /// "Bob is in `contractors`, and `contractors` has no grants" is an answer
    /// an access review asks for.
    pub groups: Vec<GroupRef>,
    /// One entry per scope some grant names. Never the cross product of every
    /// project and environment.
    pub scopes: Vec<Entry>,
}

/// Runs `prk access explain`.
///
/// # Errors
///
/// [`CliError::Other`] when no identity has that subject, or when the server's
/// answer is not the document the spec declares, and [`CliError::Api`] for
/// anything the server reported.
pub fn run(
    context: &Context,
    subject: &str,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    // The route takes an identity id. Resolving the subject here is what keeps
    // the workflow "paste the subject you saw get a 403" rather than "find the
    // uuid first" -- the same resolution `prk access grant` performs.
    let identity = super::access::resolve_identity(context, subject)?;
    let client = context.client();

    let document = context.block_on(ops::explain_identity_permissions(client, &identity.id))?;
    let explanation = parse(&document)?;
    report(&explanation, global, out);

    Ok(())
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/// Reads the document the route returns.
///
/// # Errors
///
/// [`CliError::Other`] when a field the response schema marks required is
/// absent. Refused rather than defaulted: an absent `scopes` renders as "no
/// access anywhere", which is the one wrong answer this command must never
/// give.
pub fn parse(document: &Value) -> Result<Explanation, CliError> {
    let identity = document
        .get("identity")
        .filter(|value| value.is_object())
        .ok_or_else(|| missing("identity"))?;
    let groups =
        document.get("groups").and_then(Value::as_array).ok_or_else(|| missing("groups"))?;
    let bootstrap =
        document.get("bootstrap").and_then(Value::as_bool).ok_or_else(|| missing("bootstrap"))?;
    let scopes =
        document.get("scopes").and_then(Value::as_array).ok_or_else(|| missing("scopes"))?;

    Ok(Explanation {
        identity_id: text(identity, "id"),
        kind: text(identity, "kind"),
        subject: text(identity, "subject"),
        display_name: maybe_text(identity, "displayName"),
        disabled: flag(identity, "disabled"),
        last_seen_at: maybe_int(identity, "lastSeenAt"),
        bootstrap,
        groups: groups.iter().map(parse_group).collect(),
        scopes: scopes.iter().map(parse_entry).collect::<Result<Vec<_>, _>>()?,
    })
}

/// The refusal an answer missing a required field gets.
fn missing(field: &str) -> CliError {
    CliError::Other(format!(
        "the server's effective-permissions answer carries no `{field}`, so it is not the \
         document this route is specified to return; refusing to render it, because a missing \
         field here reads as `no access` and that is the one wrong answer this command must not \
         give"
    ))
}

/// One scope entry.
fn parse_entry(value: &Value) -> Result<Entry, CliError> {
    let sources = value
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| missing("scopes[].sources"))?;

    Ok(Entry {
        scope_type: text(value, "scopeType"),
        project: maybe_text(value, "projectSlug"),
        environment: maybe_text(value, "environmentSlug"),
        role: maybe_text(value, "role"),
        sources: sources.iter().map(parse_source).collect(),
    })
}

/// One source. Infallible: an entry that reached here already has its list, and
/// a source missing a field is rendered as what it says rather than refused.
fn parse_source(value: &Value) -> Source {
    Source {
        via: text(value, "via"),
        grant_id: maybe_text(value, "grantId"),
        role: text(value, "role"),
        scope_type: text(value, "scopeType"),
        project: maybe_text(value, "projectSlug"),
        environment: maybe_text(value, "environmentSlug"),
        group: value.get("group").filter(|group| group.is_object()).map(parse_group),
        expires_at: maybe_int(value, "expiresAt"),
        decisive: flag(value, "decisive"),
    }
}

/// One group reference.
fn parse_group(value: &Value) -> GroupRef {
    GroupRef { id: text(value, "id"), slug: text(value, "slug"), name: text(value, "name") }
}

/// A string field, or the empty string.
fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// A nullable string field.
fn maybe_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

/// A nullable integer field.
fn maybe_int(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

/// A boolean field. Absent is false.
fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `project:environment`, with `*` for whichever half is not named.
fn scope_of(project: Option<&str>, environment: Option<&str>) -> String {
    format!("{}:{}", project.unwrap_or(WILDCARD), environment.unwrap_or(WILDCARD))
}
/// The document the route returns for an identity whose production admin
/// comes through a group -- the case this command exists for.
///
/// The decisive source is deliberately **not** the first element. The server
/// sorts strongest first, so agreeing with the flag by accident is easy; a
/// fixture that puts them in different places is what makes every assertion
/// about `decisive` mean something. Shared with `render`, whose tests assert
/// on what this renders as.
#[cfg(test)]
fn through_a_group() -> Value {
    serde_json::json!({
        "identity": {
            "id": "00000000-0000-7000-8000-000000000001",
            "kind": "user",
            "subject": "bob@example.com",
            "displayName": null,
            "disabled": false,
            "lastSeenAt": 1_760_000_000_000_i64,
        },
        "groups": [
            { "id": "00000000-0000-7000-8000-00000000000a", "slug": "contractors",
              "name": "Contractors" },
            { "id": "00000000-0000-7000-8000-00000000000b", "slug": "platform",
              "name": "Platform" },
        ],
        "bootstrap": false,
        "scopes": [{
            "scopeType": "environment",
            "projectSlug": "billing",
            "environmentSlug": "production",
            "role": "admin",
            "sources": [
                {
                    "via": "direct", "grantId": "00000000-0000-7000-8000-000000000010",
                    "role": "reader", "scopeType": "environment",
                    "projectSlug": "billing", "environmentSlug": "production",
                    "group": null, "expiresAt": null, "decisive": false,
                },
                {
                    "via": "group", "grantId": "00000000-0000-7000-8000-000000000011",
                    "role": "admin", "scopeType": "project",
                    "projectSlug": "billing", "environmentSlug": null,
                    "group": { "id": "00000000-0000-7000-8000-00000000000b",
                               "slug": "platform", "name": "Platform" },
                    "expiresAt": null, "decisive": true,
                },
            ],
        }],
    })
}

/// The fixture, parsed.
#[cfg(test)]
fn parsed() -> Explanation {
    parse(&through_a_group()).expect("the fixture is the documented shape")
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Reading the answer
    // -----------------------------------------------------------------------

    #[test]
    fn the_servers_camel_case_answer_is_read_whole() {
        let explanation = parsed();

        assert_eq!(explanation.subject, "bob@example.com");
        assert_eq!(explanation.kind, "user");
        assert_eq!(explanation.last_seen_at, Some(1_760_000_000_000));
        assert!(!explanation.disabled);
        assert!(!explanation.bootstrap);
        assert_eq!(
            explanation.groups.iter().map(|group| group.slug.as_str()).collect::<Vec<_>>(),
            ["contractors", "platform"],
            "a group that confers nothing still belongs in the answer"
        );
        assert_eq!(explanation.scopes.len(), 1);
        assert_eq!(explanation.scopes[0].sources.len(), 2);
    }

    #[test]
    fn a_scope_is_spelled_the_way_the_cli_spells_one() {
        // So it can be pasted into `prk access revoke --scope`.
        let entry = |scope_type: &str, project: Option<&str>, environment: Option<&str>| Entry {
            scope_type: scope_type.to_owned(),
            project: project.map(ToOwned::to_owned),
            environment: environment.map(ToOwned::to_owned),
            role: None,
            sources: Vec::new(),
        };

        assert_eq!(entry("global", None, None).scope(), "*:*");
        assert_eq!(entry("project", Some("billing"), None).scope(), "billing:*");
        assert_eq!(
            entry("environment", Some("billing"), Some("production")).scope(),
            "billing:production"
        );
    }

    #[test]
    fn a_source_scope_is_the_grants_own_and_may_be_broader_than_the_entry() {
        // The whole point: the entry is the environment, the source that
        // explains it is a grant on the project.
        let explanation = parsed();
        let entry = &explanation.scopes[0];

        assert_eq!(entry.scope(), "billing:production");
        assert_eq!(entry.sources[1].scope(), "billing:*");
        assert_eq!(entry.sources[1].scope_type, "project");
    }

    #[test]
    fn an_answer_missing_a_required_field_is_refused_rather_than_read_as_no_access() {
        for absent in ["identity", "groups", "bootstrap", "scopes"] {
            let mut document = through_a_group();
            document.as_object_mut().expect("an object").remove(absent);

            let err = parse(&document).unwrap_err();
            assert!(err.to_string().contains(absent), "{absent}: {err}");
            assert_eq!(err.code(), "ERROR");
        }
    }

    #[test]
    fn an_entry_without_a_sources_array_is_refused_too() {
        // An entry carrying a role and no explanation is precisely the useless
        // answer this route exists to avoid.
        let mut document = through_a_group();
        document["scopes"][0].as_object_mut().expect("an object").remove("sources");

        let err = parse(&document).unwrap_err();
        assert!(err.to_string().contains("sources"), "{err}");
    }

    // -----------------------------------------------------------------------
    // The decisive source
    // -----------------------------------------------------------------------

    #[test]
    fn the_decisive_source_is_the_flagged_one_not_the_first_one() {
        let explanation = parsed();
        let decisive = explanation.scopes[0].decisive().expect("one source is marked decisive");

        assert_eq!(decisive.via, "group");
        assert_eq!(decisive.group.as_ref().map(|group| group.slug.as_str()), Some("platform"));
        assert!(
            !explanation.scopes[0].sources[0].decisive,
            "the fixture puts the decisive source second on purpose"
        );
    }

    #[test]
    fn a_bootstrap_source_is_named_because_no_row_backs_it() {
        let source = Source {
            via: "bootstrap".to_owned(),
            grant_id: None,
            role: "admin".to_owned(),
            scope_type: "global".to_owned(),
            project: None,
            environment: None,
            group: None,
            expires_at: None,
            decisive: true,
        };
        assert_eq!(source.origin(), "BOOTSTRAP_ADMINS");
        assert_eq!(source.scope(), "*:*");
    }
}
