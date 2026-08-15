//! Turning an [`Explanation`] into output.
//!
//! Split from the module that fetches and reads it, along the same seam the
//! server splits `core/permissions.ts` on: everything there answers "what does
//! the access graph say", everything here answers "how does a human read it".
//! It is also what keeps either file well clear of the 1000-line cap, which is
//! the point at which the next comment gets deleted rather than written.
//!
//! # The one thing this must never do
//!
//! Print every source the same. The role alone is what `prk access list`
//! already gives; the reason this command exists is that the server says which
//! grant or group conferred it, and a renderer that flattened that would have
//! thrown away the whole answer while still looking like output.

use serde_json::Value;

use super::{Entry, Explanation, GroupRef, Source};
use crate::cli::GlobalArgs;
use crate::output::Output;

/// The marker in front of the source that set the role.
const DECISIVE: &str = "  -> ";

/// The same width, for the ones that did not. ASCII and fixed-width, for the
/// reason `prk doctor`'s markers are: this output gets pasted into issue
/// trackers and terminals with every imaginable font configuration.
const CONTRIBUTING: &str = "     ";

/// Prints the explanation.
pub fn report(explanation: &Explanation, global: &GlobalArgs, out: Output) {
    if global.json {
        out.json(&json(explanation));
        return;
    }

    for line in human_lines(explanation) {
        out.data(&line);
    }

    if explanation.scopes.is_empty() {
        out.note(
            "No role at any scope you administer -- no grant, no group grant, and not named in \
             BOOTSTRAP_ADMINS.",
        );
    }

    // Said every time. This listing IS complete for group-held roles, which is
    // the whole reason it exists -- but it is narrowed to what the caller
    // administers, and a project admin reading it as the whole graph would draw
    // the same wrong conclusion `prk access list` warns about.
    out.note(
        "Includes roles held through a group, which `prk access list` does not. Entries are \
         narrowed to the scopes you administer, so a global administrator sees more here.",
    );
}

/// The human-mode rendering, as lines.
///
/// Separate from [`report`] so the shape of the output is a value a test can
/// assert on. A renderer that printed every source identically would be a
/// renderer that had lost the only thing this route adds.
fn human_lines(explanation: &Explanation) -> Vec<String> {
    let disabled = if explanation.disabled { "\tDISABLED" } else { "" };
    let mut lines = vec![format!("{}\t{}{disabled}", explanation.subject, explanation.kind)];

    let groups = if explanation.groups.is_empty() {
        "none".to_owned()
    } else {
        explanation.groups.iter().map(|group| group.slug.clone()).collect::<Vec<_>>().join(", ")
    };
    lines.push(format!("groups\t{groups}"));

    if explanation.bootstrap {
        // No row anywhere backs this one, so an operator who goes looking in the
        // database for what to revoke will not find it.
        lines.push(
            "bootstrap\tnamed in BOOTSTRAP_ADMINS, which confers global admin with no grant row \
             behind it"
                .to_owned(),
        );
    }

    for entry in &explanation.scopes {
        lines.push(format!(
            "{}\t{}\t{}",
            entry.scope(),
            entry.role.as_deref().unwrap_or("none"),
            attribution(entry, explanation.disabled)
        ));

        for source in &entry.sources {
            let marker = if source.decisive { DECISIVE } else { CONTRIBUTING };
            lines.push(format!(
                "{marker}{}\t{}\ton `{}`",
                source.role,
                source.origin(),
                source.scope()
            ));
        }
    }

    lines
}

/// Why this entry has the role it has, in one clause.
fn attribution(entry: &Entry, disabled: bool) -> String {
    if let Some(source) = entry.decisive() {
        return format!("via {} on `{}`", source.origin(), source.scope());
    }

    if disabled {
        // The kill switch outranks every grant, so nothing below is in force.
        // The sources are still listed: an operator deciding whether it is safe
        // to re-enable this identity needs to see what would come back.
        return "nothing is in force while the identity is disabled".to_owned();
    }

    // The response schema marks exactly one source decisive per entry. Neither
    // "none" nor "several" is a state the server can be in, so it is reported
    // rather than resolved by picking one and sounding certain.
    "no single source is marked decisive, which the server should not do".to_owned()
}

/// The `--json` document.
fn json(explanation: &Explanation) -> Value {
    serde_json::json!({
        "identity": {
            "id": explanation.identity_id,
            "kind": explanation.kind,
            "subject": explanation.subject,
            "display_name": explanation.display_name,
            "disabled": explanation.disabled,
            "last_seen_at": explanation.last_seen_at,
        },
        "bootstrap": explanation.bootstrap,
        "groups": explanation.groups.iter().map(group_json).collect::<Vec<_>>(),
        "scopes": explanation.scopes.iter().map(entry_json).collect::<Vec<_>>(),
    })
}

/// One scope entry, as a JSON document.
fn entry_json(entry: &Entry) -> Value {
    serde_json::json!({
        "scope_type": entry.scope_type,
        "scope": entry.scope(),
        "project": entry.project,
        "environment": entry.environment,
        "role": entry.role,
        "sources": entry.sources.iter().map(source_json).collect::<Vec<_>>(),
    })
}

/// One source, as a JSON document.
fn source_json(source: &Source) -> Value {
    serde_json::json!({
        "via": source.via,
        "grant_id": source.grant_id,
        "role": source.role,
        "scope_type": source.scope_type,
        "scope": source.scope(),
        "project": source.project,
        "environment": source.environment,
        "group": source.group.as_ref().map(group_json),
        "expires_at": source.expires_at,
        "decisive": source.decisive,
    })
}

/// One group reference, as a JSON document.
fn group_json(group: &GroupRef) -> Value {
    serde_json::json!({ "id": group.id, "slug": group.slug, "name": group.name })
}

#[cfg(test)]
mod tests {
    use super::super::{parse, parsed, through_a_group};
    use super::*;

    #[test]
    fn the_headline_names_the_group_that_conferred_the_role() {
        // "Bob can read production" is half an answer. "because he is in the
        // `platform` group" is the half an incident needs.
        let lines = human_lines(&parsed());
        let headline =
            lines.iter().find(|line| line.starts_with("billing:production")).expect("an entry");

        assert!(headline.contains("\tadmin\t"), "{headline}");
        assert!(headline.contains("group `platform`"), "{headline}");
        assert!(headline.contains("billing:*"), "the grant sits on the project: {headline}");
        assert!(
            !headline.contains("a direct grant"),
            "the reader grant did not confer admin: {headline}"
        );
    }

    #[test]
    fn exactly_one_source_line_is_marked_and_it_is_the_decisive_one() {
        // A renderer that printed every source identically would have lost the
        // only thing this route adds over `prk access list`.
        let lines = human_lines(&parsed());
        let sources: Vec<&String> = lines
            .iter()
            .filter(|line| line.starts_with(DECISIVE) || line.starts_with(CONTRIBUTING))
            .collect();
        assert_eq!(sources.len(), 2, "both sources are listed: {lines:?}");

        let marked: Vec<&&String> =
            sources.iter().filter(|line| line.starts_with(DECISIVE)).collect();
        assert_eq!(marked.len(), 1, "exactly one line carries the marker: {sources:?}");
        assert!(marked[0].contains("group `platform`"), "{}", marked[0]);
        assert!(marked[0].contains("admin"), "{}", marked[0]);

        let unmarked: Vec<&&String> =
            sources.iter().filter(|line| line.starts_with(CONTRIBUTING)).collect();
        assert_eq!(unmarked.len(), 1);
        assert!(unmarked[0].contains("a direct grant"), "{}", unmarked[0]);
        assert!(unmarked[0].contains("reader"), "{}", unmarked[0]);
    }

    #[test]
    fn the_two_markers_are_different_and_the_same_width() {
        // Equal width keeps the columns aligned; different content is the whole
        // signal. If these ever became equal, every assertion above would still
        // pass while the output said nothing.
        assert_ne!(DECISIVE, CONTRIBUTING);
        assert_eq!(DECISIVE.len(), CONTRIBUTING.len());
        assert!(DECISIVE.is_ascii() && CONTRIBUTING.is_ascii());
    }

    #[test]
    fn every_source_reaches_the_output_including_the_ones_that_lost() {
        // "What do I remove" needs the whole list, not just the winner.
        let lines = human_lines(&parsed()).join("\n");
        assert!(lines.contains("billing:production"), "{lines}");
        assert!(lines.contains("billing:*"), "{lines}");
        assert!(lines.contains("reader"), "{lines}");
        assert!(lines.contains("admin"), "{lines}");
    }

    #[test]
    fn a_bootstrap_admin_is_said_to_be_one() {
        let mut document = through_a_group();
        document["bootstrap"] = Value::Bool(true);
        let lines = human_lines(&parse(&document).expect("the shape matches")).join("\n");

        assert!(lines.contains("BOOTSTRAP_ADMINS"), "{lines}");
        assert!(lines.contains("no grant row"), "an operator will go looking for one: {lines}");
    }

    #[test]
    fn a_disabled_identity_reports_no_role_and_nothing_decisive() {
        let mut document = through_a_group();
        document["identity"]["disabled"] = Value::Bool(true);
        document["scopes"][0]["role"] = Value::Null;
        for index in 0..2 {
            document["scopes"][0]["sources"][index]["decisive"] = Value::Bool(false);
        }

        let explanation = parse(&document).expect("the shape matches");
        let lines = human_lines(&explanation).join("\n");

        assert!(lines.contains("DISABLED"), "{lines}");
        assert!(lines.contains("\tnone\t"), "the effective role is none: {lines}");
        assert!(lines.contains("disabled"), "{lines}");
        assert!(
            !lines.contains(DECISIVE),
            "nothing is deciding anything while the kill switch is on: {lines}"
        );
        // The sources are still there: re-enabling would restore them, and that
        // is what the operator is deciding about.
        assert!(lines.contains("group `platform`"), "{lines}");
    }

    #[test]
    fn a_server_that_marks_no_source_decisive_is_reported_rather_than_guessed_at() {
        let mut document = through_a_group();
        document["scopes"][0]["sources"][1]["decisive"] = Value::Bool(false);

        let lines = human_lines(&parse(&document).expect("the shape matches")).join("\n");
        assert!(lines.contains("no single source is marked decisive"), "{lines}");
        assert!(!lines.contains("via group"), "no attribution may be invented: {lines}");
    }

    #[test]
    fn a_server_that_marks_two_sources_decisive_is_reported_too() {
        let mut document = through_a_group();
        document["scopes"][0]["sources"][0]["decisive"] = Value::Bool(true);

        let entry = &parse(&document).expect("the shape matches").scopes[0];
        assert!(entry.decisive().is_none(), "`several` has no more answer than `none` does");
        assert!(
            human_lines(&parse(&document).expect("the shape matches"))
                .join("\n")
                .contains("no single source is marked decisive")
        );
    }

    #[test]
    fn an_identity_in_no_groups_says_so_rather_than_printing_an_empty_column() {
        let mut document = through_a_group();
        document["groups"] = Value::Array(Vec::new());

        let lines = human_lines(&parse(&document).expect("the shape matches"));
        assert!(lines.iter().any(|line| line == "groups\tnone"), "{lines:?}");
    }

    // -----------------------------------------------------------------------
    // --json
    // -----------------------------------------------------------------------

    #[test]
    fn the_json_document_carries_the_provenance_and_the_flag() {
        let document = json(&parsed());

        assert_eq!(document["identity"]["subject"], "bob@example.com");
        assert_eq!(document["bootstrap"], false);
        assert_eq!(document["groups"][1]["slug"], "platform");

        let entry = &document["scopes"][0];
        assert_eq!(entry["scope"], "billing:production");
        assert_eq!(entry["scope_type"], "environment");
        assert_eq!(entry["role"], "admin");

        // The losing source is present and is not marked.
        assert_eq!(entry["sources"][0]["via"], "direct");
        assert_eq!(entry["sources"][0]["decisive"], false);
        assert_eq!(entry["sources"][0]["group"], Value::Null);

        // The winning one names the group and the scope the grant sits at.
        assert_eq!(entry["sources"][1]["via"], "group");
        assert_eq!(entry["sources"][1]["decisive"], true);
        assert_eq!(entry["sources"][1]["group"]["slug"], "platform");
        assert_eq!(entry["sources"][1]["scope"], "billing:*");
        assert_eq!(entry["sources"][1]["grant_id"], "00000000-0000-7000-8000-000000000011");
    }

    #[test]
    fn the_json_keys_are_the_snake_case_ones_the_other_commands_emit() {
        // `prk access list` emits `scope_type`, `scope`, `project`,
        // `environment`, `expires_at`. A second spelling for the same field in
        // a sibling command is a thing every script has to special-case.
        let document = json(&parsed());
        let source = &document["scopes"][0]["sources"][0];

        for key in [
            "via",
            "grant_id",
            "role",
            "scope_type",
            "scope",
            "project",
            "environment",
            "group",
            "expires_at",
            "decisive",
        ] {
            assert!(source.get(key).is_some(), "`{key}` is missing from a source");
        }
        assert!(source.get("grantId").is_none(), "the camel-case spelling must not leak through");
        assert!(document["identity"].get("displayName").is_none());
        assert!(document["identity"].get("display_name").is_some());
    }

    #[test]
    fn an_identity_with_no_entries_is_an_empty_list_rather_than_an_absent_one() {
        let mut document = through_a_group();
        document["scopes"] = Value::Array(Vec::new());

        let explanation = parse(&document).expect("no access is a valid answer");
        assert!(explanation.scopes.is_empty());
        assert_eq!(json(&explanation)["scopes"], serde_json::json!([]));
    }
}
