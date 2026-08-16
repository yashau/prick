//! `prk access disable`, `enable` and `rename` -- the kill switch, and the
//! label that makes an access list readable.
//!
//! # Why the kill switch is a command rather than a hunt
//!
//! A compromised identity is disabled with one write. `disabled` is checked
//! **before** grants are resolved, so it outranks every grant at every scope,
//! `BOOTSTRAP_ADMINS` included -- there is no list of rows to find and no risk
//! of missing one held through a group. That is also why the route wants
//! **global** admin: an administrator of one project flipping it would be
//! revoking access to projects they have nothing to do with.
//!
//! Incident response is exactly when somebody is at a terminal, which is the
//! whole argument for these existing here at all rather than only in the admin
//! UI.
//!
//! # Renaming is not cosmetic
//!
//! A service token's subject is `e367826f93b8d71185e03fe518aff3b4.access`. An
//! access list of those is unreadable, and a stale token survives three audits
//! because nobody could say what it was for. The label is what turns revoking
//! it into a decision somebody can take.
//!
//! # Three subcommands rather than one with flags
//!
//! `PATCH /identities/{id}` can change both fields in one request, and this
//! deliberately never does. The body is built from what the caller set, so a
//! combined command would need a tri-state for the name and a tri-state for the
//! switch, and the failure it would eventually produce is a `disabled: false`
//! riding along on a rename -- silently re-enabling an identity somebody killed
//! during an incident. Split, each command's request cannot carry a field its
//! name does not mention, and there is nothing to get wrong.
//!
//! # Saying which of two things just happened
//!
//! "Disabled `bob@example.com`" and "`bob@example.com` was already disabled"
//! are different facts, and during an incident the difference is whether
//! somebody else got there first. The subject has already been resolved to an
//! identity row by the time the request goes out, so the prior state is in
//! hand; the state afterwards is read off the row the server answers with,
//! never off what was asked for.

use prick_api::models::Identity;
use prick_api::ops::{self, DisplayNameChange, IdentityUpdate};

use crate::cli::GlobalArgs;
use crate::commands::{Context, access, projects::confirm};
use crate::error::CliError;
use crate::output::Output;

/// Runs `prk access disable` / `prk access enable`.
///
/// # Errors
///
/// [`CliError::Other`] when no identity has that subject, when the operator
/// declines the confirmation, or when the server answers with a state that is
/// not the one that was asked for, and [`CliError::Api`] for anything the
/// server reported.
pub fn set_disabled(
    context: &Context,
    subject: &str,
    disabled: bool,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    // The route takes an identity id. Resolving the subject here is the same
    // resolution `prk access grant` and `prk access explain` perform, and it is
    // what lets an operator paste the subject they saw in an alert.
    let identity = access::resolve_identity(context, subject)?;
    let was = identity.disabled;

    // Disabling is destructive in effect -- it removes every role the identity
    // holds, at every scope, at once -- so it confirms exactly as `prk access
    // revoke` and `prk secrets rm` do. Enabling does not, for the same reason
    // `prk access grant` does not: restoring access is the reversible half.
    if disabled && !confirm(global, out, &format!("Disable `{subject}`"))? {
        return Err(CliError::Other("cancelled".to_owned()));
    }

    // Sent even when the stored flag already matches. The read above and the
    // write are two requests, so treating "it already looks disabled" as a
    // reason to skip would make the command's effect depend on a value that
    // could have changed in between -- and would leave no audit row from the
    // person who ran it.
    let update = disable_update(disabled);
    let updated =
        context.block_on(ops::update_identity(context.client(), &identity.id, &update))?;

    // Both the rendering and `changed` read the row the server answered with,
    // never the flag that was asked for. `require_state` has already refused
    // the case where those disagree, so this cannot report a state that is not
    // the stored one -- and it does not have to be trusted not to.
    require_state(subject, disabled, updated.disabled)?;
    let lines = disabled_lines(subject, was, updated.disabled);
    report(&updated, was != updated.disabled, global, out, &lines);
    Ok(())
}

/// Runs `prk access rename`.
///
/// `name` is the label to store, or `None` to clear it.
///
/// # Errors
///
/// [`CliError::Other`] when no identity has that subject, and
/// [`CliError::Api`] for anything the server reported.
pub fn rename(
    context: &Context,
    subject: &str,
    name: Option<&str>,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let identity = access::resolve_identity(context, subject)?;
    let was = identity.display_name.clone();

    let update = rename_update(name);
    let updated =
        context.block_on(ops::update_identity(context.client(), &identity.id, &update))?;

    // The stored label, off the answer, rather than the one that was typed.
    // They agree today; reporting the request back would be reporting something
    // this command did not verify.
    let now = updated.display_name.as_deref();
    let lines = rename_lines(subject, was.as_deref(), now);
    report(&updated, was.as_deref() != now, global, out, &lines);
    Ok(())
}

/// The patch a rename sends.
///
/// A function rather than a literal at the call site so that a test drives the
/// real thing: `disabled: None` is what keeps a rename from moving the kill
/// switch, and a test that rebuilt the struct itself would agree with the bug
/// rather than catch it.
fn rename_update(name: Option<&str>) -> IdentityUpdate<'_> {
    IdentityUpdate {
        // An absent NAME is `--clear`, which the API sends as an explicit
        // `null`; it is never "say nothing", which would make the command a
        // silent no-op.
        display_name: name.map_or(DisplayNameChange::Clear, DisplayNameChange::Set),
        // Not named, therefore not sent, therefore this request cannot re-enable
        // an identity somebody killed. That is the whole reason renaming is its
        // own command.
        disabled: None,
    }
}

/// The patch a kill-switch change sends.
///
/// The mirror of [`rename_update`]: the label is not named, so throwing the
/// switch cannot erase the one thing that makes an access list readable.
fn disable_update(disabled: bool) -> IdentityUpdate<'static> {
    IdentityUpdate { display_name: DisplayNameChange::Keep, disabled: Some(disabled) }
}

/// Refuses an answer that does not carry the state that was requested.
///
/// A kill switch that reports success while the identity is still live is the
/// one failure this command must not have. The server has no path that answers
/// `200` without applying the patch, so this never fires in practice -- which
/// is exactly why it is cheap to keep, and why it is an error rather than a
/// note.
///
/// # Errors
///
/// [`CliError::Other`] naming both states.
fn require_state(subject: &str, wanted: bool, got: bool) -> Result<(), CliError> {
    if wanted == got {
        return Ok(());
    }

    let verb = if wanted { "disable" } else { "enable" };
    let state = if got { "disabled" } else { "enabled" };
    Err(CliError::Other(format!(
        "asked the server to {verb} `{subject}`, and it answered with an identity that is still \
         {state}; treat `{subject}` as {state} and check the admin UI"
    )))
}

/// The human-mode rendering of a kill-switch change.
///
/// A value rather than a series of `out.data` calls, so a test can assert that
/// the two outcomes read differently. "Disabled `bob@example.com`" and
/// "`bob@example.com` was already disabled" must not be confusable by somebody
/// reading a terminal at speed.
fn disabled_lines(subject: &str, was: bool, now: bool) -> Vec<String> {
    if was == now {
        let state = if now { "disabled" } else { "enabled" };
        return vec![format!(
            "`{subject}` was already {state}; nothing changed. Somebody may have got here first."
        )];
    }

    if now {
        return vec![
            format!("Disabled `{subject}`."),
            format!(
                "It now resolves to no role at any scope, whatever its grants say -- including \
                 BOOTSTRAP_ADMINS. Re-enable with `prk access enable {subject}`."
            ),
        ];
    }

    vec![
        format!("Enabled `{subject}`."),
        format!(
            "Its grants are in force again; `prk access explain {subject}` shows exactly what that \
             restored."
        ),
    ]
}

/// The human-mode rendering of a rename.
fn rename_lines(subject: &str, was: Option<&str>, now: Option<&str>) -> Vec<String> {
    match (was, now) {
        (Some(was), Some(now)) if was == now => {
            vec![format!("`{subject}` is already named `{now}`; nothing changed.")]
        }
        (None, None) => vec![format!("`{subject}` has no display name; nothing changed.")],
        // The old label is named on the way out. It is the only record of what
        // the token was for, and an operator who cleared the wrong one needs to
        // be able to put it back.
        (Some(was), None) => {
            vec![format!("Cleared the display name on `{subject}`; it was `{was}`.")]
        }
        (None, Some(now)) => vec![format!("Named `{subject}` `{now}`.")],
        (Some(was), Some(now)) => {
            vec![format!("Renamed `{subject}` from `{was}` to `{now}`.")]
        }
    }
}

/// Prints the identity the server answered with.
///
/// Under `--json` it is the same document `prk access identities` emits, plus
/// `changed` -- the machine-readable form of the distinction the human lines
/// make in words. A script that has to diff two runs to notice a no-op is a
/// script that will not notice one.
fn report(identity: &Identity, changed: bool, global: &GlobalArgs, out: Output, lines: &[String]) {
    if global.json {
        let mut document = access::identity_json(identity);
        document["changed"] = serde_json::Value::Bool(changed);
        out.json(&document);
        return;
    }

    // The first line is the answer and goes to stdout; what follows is context
    // and goes to stderr, so `prk access disable X | …` carries the fact and
    // not the advice.
    let mut lines = lines.iter();
    if let Some(headline) = lines.next() {
        out.data(headline);
    }
    for line in lines {
        out.note(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An identity row in the shape the server sends one.
    ///
    /// Deserialised rather than constructed: `Identity` is `#[non_exhaustive]`,
    /// so going through serde means a field the server renames breaks these
    /// tests instead of quietly rendering a default.
    fn identity(subject: &str, display_name: Option<&str>, disabled: bool) -> Identity {
        serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-7000-8000-000000000001",
            "kind": "service",
            "subject": subject,
            "displayName": display_name,
            "disabled": disabled,
            "lastSeenAt": 1_760_000_000_000_i64,
        }))
        .expect("the shape matches the server's identity row")
    }

    // -----------------------------------------------------------------------
    // Now, versus already was
    // -----------------------------------------------------------------------

    #[test]
    fn a_disable_that_changed_something_does_not_read_like_one_that_did_not() {
        // The sentence somebody reads during an incident. If these two were
        // confusable, "we killed it" and "somebody else killed it ten minutes
        // ago" would look the same on a terminal.
        let fresh = disabled_lines("bob@example.com", false, true);
        let already = disabled_lines("bob@example.com", true, true);

        assert_ne!(fresh, already);
        assert_eq!(fresh[0], "Disabled `bob@example.com`.");
        assert!(already[0].contains("was already disabled"), "{already:?}");
        assert!(already[0].contains("nothing changed"), "{already:?}");
        // "Disabled X" must not be a substring of the no-op line, or a reader
        // grepping for it finds both.
        assert!(!already[0].starts_with("Disabled "), "{already:?}");
    }

    #[test]
    fn an_enable_that_changed_something_does_not_read_like_one_that_did_not() {
        let fresh = disabled_lines("bob@example.com", true, false);
        let already = disabled_lines("bob@example.com", false, false);

        assert_ne!(fresh, already);
        assert_eq!(fresh[0], "Enabled `bob@example.com`.");
        assert!(already[0].contains("was already enabled"), "{already:?}");
    }

    #[test]
    fn disabling_and_enabling_do_not_read_alike_either() {
        // A renderer that emitted one constant would pass every assertion above
        // that only looks at one call.
        let off = disabled_lines("bob@example.com", false, true);
        let on = disabled_lines("bob@example.com", true, false);
        assert_ne!(off, on);
        assert!(off[0].starts_with("Disabled"), "{off:?}");
        assert!(on[0].starts_with("Enabled"), "{on:?}");
    }

    #[test]
    fn a_disable_says_that_it_outranks_every_grant() {
        // "Disabled" alone leaves the operator wondering whether the grants
        // still have to be revoked one by one. They do not, and that is the
        // point of the switch.
        let lines = disabled_lines("bob@example.com", false, true).join("\n");
        assert!(lines.contains("BOOTSTRAP_ADMINS"), "{lines}");
        assert!(lines.contains("prk access enable bob@example.com"), "{lines}");
    }

    // -----------------------------------------------------------------------
    // Renaming
    // -----------------------------------------------------------------------

    #[test]
    fn every_rename_outcome_reads_differently() {
        let subject = "e367826f93b8d71185e03fe518aff3b4.access";
        let named = rename_lines(subject, None, Some("staging deploy job"));
        let renamed = rename_lines(subject, Some("old"), Some("staging deploy job"));
        let same = rename_lines(subject, Some("staging deploy job"), Some("staging deploy job"));
        let cleared = rename_lines(subject, Some("staging deploy job"), None);
        let nothing = rename_lines(subject, None, None);

        let rendered = [&named, &renamed, &same, &cleared, &nothing];
        let unique: std::collections::BTreeSet<String> =
            rendered.iter().map(|lines| lines.join("\n")).collect();
        assert_eq!(unique.len(), rendered.len(), "two outcomes render the same: {rendered:?}");

        assert!(same[0].contains("already named"), "{same:?}");
        assert!(nothing[0].contains("no display name"), "{nothing:?}");
    }

    #[test]
    fn clearing_a_name_says_what_it_was() {
        // The label is the only record of what a service token was for; an
        // operator who cleared the wrong one has to be able to put it back.
        let lines = rename_lines("abc.access", Some("staging deploy job"), None).join("\n");
        assert!(lines.contains("Cleared"), "{lines}");
        assert!(lines.contains("staging deploy job"), "{lines}");
    }

    #[test]
    fn a_rename_names_both_the_old_label_and_the_new_one() {
        let lines = rename_lines("abc.access", Some("old"), Some("new")).join("\n");
        assert!(lines.contains("`old`"), "{lines}");
        assert!(lines.contains("`new`"), "{lines}");
    }

    // -----------------------------------------------------------------------
    // The request
    // -----------------------------------------------------------------------

    #[test]
    fn a_rename_builds_an_update_that_names_no_kill_switch() {
        // The hazard this command is split out to make impossible: a rename
        // carrying `disabled: false` re-enables an identity somebody killed.
        // `prick_api::ops` proves the body follows from the update; this proves
        // the update this command builds asks for nothing else.
        for name in [Some("staging deploy job"), None] {
            assert_eq!(
                rename_update(name).disabled,
                None,
                "a rename must say nothing about the kill switch"
            );
        }

        assert_eq!(
            rename_update(Some("staging deploy job")).display_name,
            DisplayNameChange::Set("staging deploy job")
        );
        assert_eq!(
            rename_update(None).display_name,
            DisplayNameChange::Clear,
            "an absent NAME is the clear, not a no-op"
        );
    }

    #[test]
    fn a_kill_switch_builds_an_update_that_names_no_display_name() {
        for disabled in [true, false] {
            let update = disable_update(disabled);
            assert_eq!(
                update.display_name,
                DisplayNameChange::Keep,
                "disabling an identity must not erase the label that identifies it"
            );
            assert_eq!(update.disabled, Some(disabled), "the flag must be sent, not inferred");
        }
    }

    // -----------------------------------------------------------------------
    // Refusing a state the server did not apply
    // -----------------------------------------------------------------------

    #[test]
    fn a_server_that_did_not_apply_the_kill_switch_is_an_error_rather_than_a_success() {
        let err = require_state("bob@example.com", true, false).expect_err("still enabled");
        let message = err.to_string();
        assert!(message.contains("bob@example.com"), "{message}");
        assert!(message.contains("still enabled"), "{message}");

        let err = require_state("bob@example.com", false, true).expect_err("still disabled");
        assert!(err.to_string().contains("still disabled"), "{err}");
    }

    #[test]
    fn a_state_that_matches_is_accepted_without_comment() {
        require_state("bob@example.com", true, true).expect("disabled, as asked");
        require_state("bob@example.com", false, false).expect("enabled, as asked");
    }

    // -----------------------------------------------------------------------
    // --json
    // -----------------------------------------------------------------------

    #[test]
    fn the_json_document_carries_the_row_and_whether_anything_changed() {
        let mut document = access::identity_json(&identity("abc.access", Some("CI"), true));
        document["changed"] = serde_json::Value::Bool(false);

        assert_eq!(document["subject"], "abc.access");
        assert_eq!(document["display_name"], "CI");
        assert_eq!(document["disabled"], true);
        assert_eq!(document["changed"], false);
        // The same snake-case spelling `prk access identities` emits, so a
        // script reading both does not special-case one of them.
        assert!(document.get("displayName").is_none());
        assert!(document.get("lastSeenAt").is_none());
        assert!(document.get("last_seen_at").is_some());
    }
}
