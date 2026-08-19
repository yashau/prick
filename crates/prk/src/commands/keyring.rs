//! `prk keyring`.
//!
//! # You drive the rotation
//!
//! A rekey advances one bounded page per call and reports how many rows are
//! left. That is the whole mechanism, on every transport: the settings screen
//! has a button, `POST /admin/rekey` takes one request, and `prk keyring rekey`
//! runs the loop for you. `--pages` is how many pages this invocation may move,
//! so an operator can bound a maintenance window rather than starting something
//! that finishes whenever it finishes.
//!
//! # Why the loop lives here rather than on the server
//!
//! A page is one D1 `batch()`, and D1 documents a ceiling on how long one may
//! take. A server-side "do it all" would either exceed that or split the work
//! across transactions, and splitting is the thing this design refuses
//! everywhere else: a failure in the second half would leave the first
//! committed. Repeating a bounded, resumable call is the shape that survives
//! being interrupted, and interrupting this is safe -- both keys stay loaded
//! until an operator removes one.
//!
//! # `status` is a readout, not a judgement
//!
//! [`ops::keyring_status`] counts live rows every time it is asked, so
//! `safe_to_remove_old_key` is computed rather than remembered. This command
//! renders that and adds nothing: the one irreversible mistake available in
//! this design is removing a retired key while a row still references it, and a
//! client that inferred "probably done" from a small number would be the way to
//! make it.

use clap::Subcommand;

use prick_api::REKEY_MAX_PAGE;
use prick_api::models::{KeyringStatus, RekeyProgress};
use prick_api::ops;

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;

/// How many pages `rekey` moves when `--pages` is not given.
///
/// One. The default has to be the one that cannot surprise: a rekey holds a
/// transaction per page and writes an audit row per page, and an operator
/// typing the command for the first time is finding out what it does.
const DEFAULT_PAGES: u32 = 1;

/// Key ring subcommands.
#[derive(Debug, Subcommand)]
pub enum KeyringCommand {
    /// Show every key id and how many rows still reference it.
    ///
    /// The counts cover history as well as current versions, and they are taken
    /// live rather than read from a stored figure.
    Status,

    /// Re-encrypt rows onto the active key, one page at a time.
    ///
    /// Resumable and repeatable: a page that already ran is not run again, and
    /// stopping part-way is safe because every key in the ring stays loaded
    /// until you remove one.
    Rekey(RekeyArgs),
}

impl KeyringCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::Status => "keyring status",
            Self::Rekey(_) => "keyring rekey",
        }
    }
}

/// Arguments to `prk keyring rekey`.
#[derive(Debug, Clone, clap::Args)]
pub struct RekeyArgs {
    /// How many rows to move per page.
    ///
    /// Capped at 100 by the server, because the page commits in one database
    /// transaction.
    #[arg(long, value_name = "ROWS", default_value_t = REKEY_MAX_PAGE)]
    pub limit: u32,

    /// How many pages this invocation may move.
    #[arg(long, value_name = "N", default_value_t = DEFAULT_PAGES, conflicts_with = "until_done")]
    pub pages: u32,

    /// Keep going until nothing is left under a retired key.
    ///
    /// The rotation is finished when `remaining` reaches zero; this runs pages
    /// until it does. Interrupting it leaves the rows already moved moved.
    #[arg(long, conflicts_with = "pages")]
    pub until_done: bool,
}

/// Runs a key ring subcommand.
///
/// # Errors
///
/// [`CliError::Auth`] if no credential is available, [`CliError::Api`] for
/// anything the server reported -- including `403` when the grant is admin at a
/// scope below global, and `500 UNKNOWN_KID` when a row names a key the ring no
/// longer holds.
pub fn run(command: &KeyringCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();

    match command {
        KeyringCommand::Status => {
            let status = context.block_on(ops::keyring_status(client))?;
            render_status(&status, global, out);
        }

        KeyringCommand::Rekey(args) => {
            check(args)?;
            let total = context.block_on(rekey(client, args, out))?;
            render_rekey(&total, global, out);
        }
    }

    Ok(())
}

/// Rejects a page size or a budget the server would refuse or that would do
/// nothing.
///
/// `--limit` is checked here rather than left to the server so the message is
/// about the flag that was typed. The server refuses an oversized limit rather
/// than clamping it, so a request that got through would be a 422 describing a
/// JSON field the operator never wrote.
///
/// # Errors
///
/// [`CliError::Other`] naming the flag and the bound it broke.
fn check(args: &RekeyArgs) -> Result<(), CliError> {
    if args.limit == 0 || args.limit > REKEY_MAX_PAGE {
        return Err(CliError::Other(format!(
            "--limit must be between 1 and {REKEY_MAX_PAGE}; a page commits in one database \
             transaction, so the ceiling is not negotiable"
        )));
    }
    if !args.until_done && args.pages == 0 {
        return Err(CliError::Other(
            "--pages must be at least 1; pass --until-done to run until nothing is left".to_owned(),
        ));
    }
    Ok(())
}

/// Runs pages until the budget is spent or nothing is left.
///
/// Returns the totals across every page it ran, so the summary is about the
/// invocation rather than about its last request.
async fn rekey(
    client: &prick_api::Client,
    args: &RekeyArgs,
    out: Output,
) -> Result<RekeyTotals, CliError> {
    let budget = if args.until_done { u32::MAX } else { args.pages };
    let mut totals = RekeyTotals { pages: 0, rekeyed: 0, remaining: 0, stalled: false };

    for page in 1..=budget {
        let progress: RekeyProgress = ops::rekey_page(client, args.limit).await?;

        totals.pages = page;
        totals.rekeyed += progress.rekeyed;
        totals.remaining = progress.remaining;

        out.debug(
            1,
            &format!(
                "page {page}: re-encrypted {}, {} row(s) remaining",
                progress.rekeyed, progress.remaining
            ),
        );

        if progress.remaining == 0 {
            break;
        }

        // A page that moved nothing while rows are still outstanding is not
        // progress, and `--until-done` would spin on it forever. The server as
        // written cannot produce this -- an empty page reports zero remaining
        // too -- so reaching here means the two numbers disagree, which is
        // worth stopping on and saying rather than retrying past.
        if progress.rekeyed == 0 {
            totals.stalled = true;
            break;
        }
    }

    Ok(totals)
}

/// What one invocation of `rekey` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RekeyTotals {
    /// Pages actually run.
    pages: u32,
    /// Rows re-encrypted across all of them.
    rekeyed: u64,
    /// Rows still under some other key id, as of the last page.
    remaining: u64,
    /// Whether a page moved nothing while rows were still outstanding.
    stalled: bool,
}

/// Renders `prk keyring status`.
fn render_status(status: &KeyringStatus, global: &GlobalArgs, out: Output) {
    if global.json {
        let entries: Vec<serde_json::Value> = status
            .entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "kid": entry.kid,
                    "status": entry.status,
                    "rows_remaining": entry.rows_remaining,
                    "last_rekey_at": entry.last_rekey_at,
                })
            })
            .collect();
        out.json(&serde_json::json!({
            "active_kid": status.active_kid,
            "entries": entries,
            "old_key_loaded": status.old_key_loaded,
            "safe_to_remove_old_key": status.safe_to_remove_old_key,
        }));
        return;
    }

    for entry in &status.entries {
        out.data(&format!("{}\t{}\t{} row(s)", entry.kid, entry.status, entry.rows_remaining));
    }

    out.note(removal_guidance(status.safe_to_remove_old_key, status.old_key_loaded));
}

/// What to do next, given the readiness signal.
///
/// The branches name an action. `safe_to_remove_old_key` is the one field in
/// this system an operator can act on unrecoverably -- removing a retired key
/// while a row still references it makes those values permanently
/// undecryptable -- so a readout that printed counts and left the reader to
/// draw the conclusion would be the wrong shape for exactly the case that
/// matters.
///
/// Which is also why `safe` alone does not earn the "you may remove it" line.
/// That field is a statement about rows, and on an install with no
/// `MASTER_KEY_OLD` and nothing stored it is vacuously true: there is no
/// non-active key id for a row to be stranded under. Printing the removal
/// instruction off it alone told every fresh install to go delete a secret it
/// never set, in the confident voice reserved for the one irreversible action
/// available here. `old_key_loaded` distinguishes "drained" from "never had
/// one", and the third arm exists solely to stop saying the first when the
/// truth is the second.
fn removal_guidance(safe: bool, old_key_loaded: bool) -> &'static str {
    match (safe, old_key_loaded) {
        (false, _) => {
            "Rows still reference a retired key. Do NOT remove `MASTER_KEY_OLD`: those values \
             would become permanently undecryptable. Run `prk keyring rekey --until-done`."
        }
        (true, true) => {
            "Nothing references a retired key. `MASTER_KEY_OLD` can be removed; redeploy \
             after you delete it."
        }
        (true, false) => {
            "No `MASTER_KEY_OLD` is set on this deployment, so there is nothing to remove \
             and no rotation is in progress."
        }
    }
}

/// Renders `prk keyring rekey`.
fn render_rekey(totals: &RekeyTotals, global: &GlobalArgs, out: Output) {
    if global.json {
        out.json(&serde_json::json!({
            "pages": totals.pages,
            "rekeyed": totals.rekeyed,
            "remaining": totals.remaining,
            "stalled": totals.stalled,
        }));
        return;
    }

    out.data(&format!(
        "Re-encrypted {} row(s) over {} page(s); {} remaining.",
        totals.rekeyed, totals.pages, totals.remaining
    ));

    if totals.remaining == 0 {
        out.note(
            "Nothing is left under a retired key. Confirm with `prk keyring status` before \
             removing `MASTER_KEY_OLD`.",
        );
    } else if totals.stalled {
        // "Run it again" would be advice to repeat something that just did
        // nothing, and under `--until-done` the operator would have watched it
        // do nothing already.
        out.warn(
            "The last page re-encrypted nothing while rows are still outstanding, so running it \
             again would do the same. Read `prk keyring status`: a key id listed as retired with \
             rows against it needs its key restored in `MASTER_KEY_OLD` before a rekey can move \
             those rows.",
        );
    } else {
        out.note("Run it again to move the next page.");
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use super::*;
    use crate::cli::{Cli, Command};

    fn parse(argv: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(argv)
    }

    fn rekey_args(invocation: &[&str]) -> RekeyArgs {
        let cli = parse(invocation).expect("the invocation parses");
        match cli.command {
            Command::Keyring(KeyringCommand::Rekey(args)) => args,
            other => panic!("`keyring rekey` parsed as {other:?}"),
        }
    }

    #[test]
    fn both_subcommands_parse_and_report_a_path() {
        for argv in [
            vec!["prk", "keyring", "status"],
            vec!["prk", "keyring", "rekey"],
            vec!["prk", "keyring", "rekey", "--until-done"],
            vec!["prk", "keyring", "rekey", "--limit", "25", "--pages", "10"],
        ] {
            let cli = parse(&argv).expect("the invocation parses");
            assert!(cli.command.path().starts_with("keyring "), "{argv:?}");
        }
    }

    #[test]
    fn the_defaults_move_exactly_one_page() {
        // Typing the command for the first time is finding out what it does, so
        // the default cannot be "keep going until it stops".
        let args = rekey_args(&["prk", "keyring", "rekey"]);
        assert_eq!(args.pages, DEFAULT_PAGES);
        assert_eq!(args.limit, REKEY_MAX_PAGE);
        assert!(!args.until_done);
        assert!(check(&args).is_ok());
    }

    #[test]
    fn a_page_budget_and_until_done_are_mutually_exclusive() {
        // "Ten pages, but also all of them" has no meaning, and resolving it
        // by precedence would silently ignore one of the two flags typed.
        assert!(parse(&["prk", "keyring", "rekey", "--pages", "3", "--until-done"]).is_err());
    }

    #[test]
    fn an_oversized_page_is_refused_locally_and_names_the_flag() {
        // The server refuses rather than clamps, so letting this through would
        // produce a 422 about a JSON field the operator never wrote.
        let args = rekey_args(&["prk", "keyring", "rekey", "--limit", "1000"]);
        let message = check(&args).expect_err("1000 is over the ceiling").to_string();
        assert!(message.contains("--limit"), "{message}");
        assert!(message.contains(&REKEY_MAX_PAGE.to_string()), "{message}");
    }

    #[test]
    fn a_zero_budget_is_refused_rather_than_doing_nothing_and_reporting_success() {
        for argv in [
            vec!["prk", "keyring", "rekey", "--pages", "0"],
            vec!["prk", "keyring", "rekey", "--limit", "0"],
        ] {
            assert!(check(&rekey_args(&argv)).is_err(), "{argv:?} was accepted");
        }
    }

    #[test]
    fn until_done_needs_no_page_budget() {
        let args = rekey_args(&["prk", "keyring", "rekey", "--until-done"]);
        assert!(args.until_done);
        assert!(check(&args).is_ok());
    }

    #[test]
    fn the_readout_names_a_next_step_on_every_branch() {
        // `safeToRemoveOldKey` is the one field in this system an operator can
        // act on unrecoverably. A readout that printed counts and left the
        // reader to draw the conclusion would be wrong for exactly that case.
        assert!(removal_guidance(true, true).contains("can be removed"));

        for unsafe_guidance in [removal_guidance(false, true), removal_guidance(false, false)] {
            assert!(unsafe_guidance.contains("Do NOT remove"), "{unsafe_guidance}");
            assert!(unsafe_guidance.contains("prk keyring rekey"), "{unsafe_guidance}");
        }
    }

    #[test]
    fn a_fresh_install_is_not_told_to_remove_a_key_it_never_set() {
        // THE REGRESSION. `safe_to_remove_old_key` is vacuously true with no
        // old key and nothing stored -- no non-active kid exists to strand a
        // row -- so gating the removal line on it alone told every fresh
        // install to go delete `MASTER_KEY_OLD`, in the one voice this tool
        // reserves for an unrecoverable action.
        let guidance = removal_guidance(true, false);

        assert!(!guidance.contains("can be removed"), "{guidance}");
        assert!(guidance.contains("nothing to remove"), "{guidance}");

        // And it must not overcorrect into an alarm: nothing is wrong on a
        // fresh install, so the destructive wording belongs to the hazard.
        assert!(!guidance.contains("Do NOT remove"), "{guidance}");
    }
}
