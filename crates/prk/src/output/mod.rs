//! The only module in the workspace allowed to write to stdout or stderr.
//!
//! # Why every byte comes through here
//!
//! `[workspace.lints.clippy]` denies `print_stdout` and `print_stderr`, which
//! means the complete set of places a `prk` process can emit a byte is the
//! handful of functions below. Reviewing "can a secret leak to a stream" is
//! reading one file, not auditing a tree, and adding a stray `eprintln!`
//! elsewhere fails the build.
//!
//! **Do not reach for a stream elsewhere.** If a module needs to say
//! something, it calls into here.
//!
//! # The stream contract
//!
//! - [`data`] writes to **stdout**. It is the answer to the question that was
//!   asked, and nothing else ever goes there.
//! - [`note`], [`warn`] and [`error`] write to **stderr**. Progress,
//!   diagnostics and failures.
//!
//! Under `--json` the split becomes strict: exactly one document on stdout on
//! success with stderr empty, and exactly one envelope on stderr on failure
//! with stdout empty. That is what makes `prk secrets download --json > f`
//! safe -- a failed run cannot leave a truncated file that parses.
//!
//! # Colour is a property of stderr, and only of stderr
//!
//! [`warn`] and [`error`] colourise their prefix. Nothing on stdout is ever
//! styled, under any `--color` setting, including `always`.
//!
//! That is not timidity about escape sequences. stdout is the answer to the
//! question that was asked, and it is read by `diff`, by `$(...)`, by a JSON
//! parser and by a redirect into a file that a later process reads back.
//! `--format json` promises byte-determinism so that
//! `prk secrets download --format json | diff` is meaningful, and a colour
//! setting that could alter those bytes would make the promise conditional on
//! an environment variable. `--color always` exists so a terminal recording or
//! a CI log renders the diagnostics in colour; it is not a request to corrupt a
//! pipeline.
//!
//! So `--color` decides one thing: whether the `error:` and `warning:` prefixes
//! on stderr carry SGR codes.
//!
//! # A closed reader is not a crash
//!
//! `println!` **panics** when the write fails, and `prk completions bash |
//! head -2` closes the reader while the script is still being written. That
//! turned a routine shell idiom into an unhandled panic -- and under the `dist`
//! profile, which is `panic = "abort"`, into a `__fastfail` whose `0xC0000409`
//! exit status truncates to **9**, the code the taxonomy already gives to
//! `UNREPRESENTABLE_OUTPUT`. A crash wearing another failure's number is worse
//! than a crash.
//!
//! So nothing here uses the `print!` family. Every byte goes through
//! `write_stdout`, which keeps the error and records it for [`crate::run`] to
//! act on once the command has returned:
//!
//! - The reader closed the pipe on ordinary output: exit 0, say nothing. The
//!   stream that would carry the complaint is the one that closed.
//! - The reader closed the pipe part way through **secret material**, or the
//!   write failed for some reason other than a reader hanging up: loud, with
//!   its own exit code. A half-written `.env` on the far side of a pipe must
//!   never be mistaken for a whole one.
//!
//! Which of the two a payload is, is the caller's to declare: [`Output::data`]
//! and its siblings are for ordinary output, [`Output::secret_data`] and its
//! siblings for anything carrying a value.
//!
//! There is no `#![allow(clippy::print_stdout)]` here any more, because there is
//! nothing left to allow: the ban now holds in every file in the workspace
//! without exception, and this module reaches the streams through their handles
//! instead.

use std::io::{IsTerminal as _, Write as _};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};

use crate::cli::{ColorChoice, GlobalArgs};
use crate::error::CliError;

/// Bold red, for `error:`.
const RED: &str = "\u{1b}[1;31m";

/// Bold yellow, for `warning:`.
const YELLOW: &str = "\u{1b}[1;33m";

/// Back to the terminal's own colours.
const RESET: &str = "\u{1b}[0m";

/// Whether stderr should carry SGR codes, under a given policy.
///
/// `auto` asks the two questions a terminal answers: is stderr a terminal, and
/// has the user asked for no colour. [`NO_COLOR`](https://no-color.org) is
/// honoured on presence and non-emptiness -- `NO_COLOR=` exported empty is how
/// a shell says "unset" often enough that treating it as a request would be
/// wrong.
///
/// `always` skips both questions, which is the point of it: a recorded terminal
/// session and a CI log are not terminals and are still read by people.
fn styled(choice: ColorChoice) -> bool {
    match choice {
        ColorChoice::Never => false,
        ColorChoice::Always => true,
        ColorChoice::Auto => {
            let suppressed = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
            !suppressed && std::io::stderr().is_terminal()
        }
    }
}

/// Wraps a prefix in an SGR pair, or leaves it alone.
fn paint(text: &str, colour: &str, styled: bool) -> String {
    if styled { format!("{colour}{text}{RESET}") } else { text.to_owned() }
}

/// How much of the answer reached stdout.
///
/// The three states are ordered by how much has to be said about them, which is
/// what lets the latch below be a `fetch_max`: whatever order the writes happen
/// in, the run reports the worst thing that happened to the stream, and nothing
/// can downgrade what was already recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdoutOutcome {
    /// Everything written reached the other end.
    Whole,

    /// The reader closed the pipe while ordinary output was being written.
    ///
    /// `prk completions bash | head -2` is this, and it is not a failure.
    ReaderGone,

    /// stdout could not be written in full, and somebody has to be told.
    ///
    /// Either the payload carried secret material, or the write failed for a
    /// reason that is not a reader hanging up -- a full disk on a redirect,
    /// say, which is a truncated file rather than a satisfied reader.
    Truncated,
}

impl StdoutOutcome {
    /// The latch's representation. Higher is worse; see the type's docs.
    fn code(self) -> u8 {
        match self {
            Self::Whole => 0,
            Self::ReaderGone => 1,
            Self::Truncated => 2,
        }
    }

    /// The outcome a latch value stands for.
    ///
    /// Anything unrecognised reads as [`Self::Truncated`]: for a value that
    /// cannot occur, the safe direction is the loud one.
    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Whole,
            1 => Self::ReaderGone,
            _ => Self::Truncated,
        }
    }
}

/// The worst thing that has happened to stdout so far.
static STDOUT: AtomicU8 = AtomicU8::new(0);

/// The first stdout failure, in the stream's own words.
///
/// First rather than last: it is the one that says why the stream stopped
/// taking bytes, and every write after it fails for the same reason.
static STDOUT_FAILURE: OnceLock<String> = OnceLock::new();

/// What has happened to stdout over this run.
pub fn stdout_outcome() -> StdoutOutcome {
    StdoutOutcome::from_code(STDOUT.load(Ordering::Relaxed))
}

/// Why stdout stopped taking bytes, if it did.
pub fn stdout_failure() -> Option<&'static str> {
    STDOUT_FAILURE.get().map(String::as_str)
}

/// Whether a payload carries secret material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Payload {
    /// Nothing a reader could not ask for again.
    Public,

    /// A value, or a document rendered out of values.
    Secret,
}

/// Writes to stdout, recording a failure rather than panicking on one.
///
/// Flushed on every call. `LineWriter` would flush each line by itself, but the
/// content that matters most here -- a rendered `.env` handed over whole by
/// [`data_raw`] -- carries its own line structure and can end without a
/// newline, and a broken pipe left to the runtime's flush at exit is discovered
/// after the last moment anyone could be told about it.
///
/// Once stdout has failed the stream is left alone. Pushing the rest of a
/// document into a pipe nobody is reading achieves nothing, and rediscovering
/// the same error once per row is how one dead reader becomes a thousand.
fn write_stdout(message: &str, newline: bool, payload: Payload) {
    if stdout_outcome() != StdoutOutcome::Whole {
        return;
    }

    let mut stream = std::io::stdout().lock();
    let written = if newline { writeln!(stream, "{message}") } else { write!(stream, "{message}") }
        .and_then(|()| stream.flush());

    let Err(err) = written else { return };

    let _ = STDOUT_FAILURE.set(err.to_string());
    STDOUT.fetch_max(outcome_for(err.kind(), payload).code(), Ordering::Relaxed);
}

/// What a failed stdout write means, given what was being written.
///
/// The one place the policy lives, as a function of two values, so that it can
/// be read and tested without a broken stream to hand.
///
/// A broken pipe is the reader's decision and only the reader's: `head -2` got
/// what it asked for. Any other error is the machine failing to do what it was
/// told -- a full disk on a redirect leaves a truncated file, not a satisfied
/// reader -- and secret material is truncated loudly whatever the reason,
/// because the caller on the other side cannot tell a short `.env` from a
/// complete one.
fn outcome_for(kind: std::io::ErrorKind, payload: Payload) -> StdoutOutcome {
    match (kind, payload) {
        (std::io::ErrorKind::BrokenPipe, Payload::Public) => StdoutOutcome::ReaderGone,
        _ => StdoutOutcome::Truncated,
    }
}

/// Writes a line to stderr, and gives up quietly if it cannot.
///
/// There is nowhere to report a failure to write to the place failures are
/// reported, and panicking over one would be the same defect this module exists
/// to keep off stdout.
fn write_stderr(message: &str) {
    let mut stream = std::io::stderr().lock();
    let _ = writeln!(stream, "{message}").and_then(|()| stream.flush());
}

/// Writes a line of program output to stdout.
pub fn data(message: &str) {
    write_stdout(message, true, Payload::Public);
}

/// Writes program output to stdout with no trailing newline added.
///
/// For content that carries its own line structure, such as a generated
/// completion script.
pub fn data_raw(message: &str) {
    write_stdout(message, false, Payload::Public);
}

/// Writes an informational line to stderr.
pub fn note(message: &str) {
    write_stderr(message);
}

/// Writes a warning to stderr, deciding colour from the environment.
///
/// For callers outside a command, such as `xtask`, which have no resolved
/// [`Output`] to ask.
pub fn warn(message: &str) {
    warn_styled(message, styled(ColorChoice::Auto));
}

/// Writes a warning to stderr.
fn warn_styled(message: &str, styled: bool) {
    write_stderr(&format!("{} {message}", paint("warning:", YELLOW, styled)));
}

/// Writes an error to stderr, deciding colour from the environment.
pub fn error(message: &str) {
    error_styled(message, styled(ColorChoice::Auto));
}

/// Writes an error to stderr.
fn error_styled(message: &str, styled: bool) {
    write_stderr(&format!("{} {message}", paint("error:", RED, styled)));
}

/// Verbosity and format settings, resolved once from the global flags.
///
/// Passed by value into every command. It is `Copy`, so threading it through
/// costs nothing and there is no ambient global to make output depend on
/// something other than its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Output {
    json: bool,
    quiet: bool,
    verbose: u8,
    color: ColorChoice,
}

impl Output {
    /// Builds an output handle from resolved settings.
    pub fn new(json: bool, quiet: bool, verbose: u8, color: ColorChoice) -> Self {
        Self { json, quiet, verbose, color }
    }

    /// Whether machine-readable output was requested.
    pub fn is_json(self) -> bool {
        self.json
    }

    /// The requested colour policy.
    pub fn color(self) -> ColorChoice {
        self.color
    }

    /// Whether this run styles its stderr prefixes.
    ///
    /// Never consulted for stdout; see this module's header for why.
    pub fn is_styled(self) -> bool {
        styled(self.color)
    }

    /// Whether diagnostics above the given verbosity level should be emitted.
    pub fn is_verbose(self, level: u8) -> bool {
        !self.quiet && self.verbose >= level
    }

    /// Emits program output on stdout.
    ///
    /// Never suppressed. `-q` silences diagnostics, not answers: a quiet run
    /// that also swallows the result would make `-q` useless in a pipeline.
    pub fn data(self, message: &str) {
        data(message);
    }

    /// Emits program output on stdout without adding a trailing newline.
    ///
    /// For content that carries its own line structure.
    pub fn data_raw(self, message: &str) {
        data_raw(message);
    }

    /// Emits a JSON document on stdout, as the sole output of the run.
    pub fn json(self, value: &serde_json::Value) {
        data(&value.to_string());
    }

    /// Emits program output that carries secret material.
    ///
    /// Byte for byte the same as [`Output::data`]; the difference is what
    /// happens if the write fails. A reader that hangs up on a listing has seen
    /// enough, and the run ends quietly. A reader that hangs up half way
    /// through a value leaves a caller holding something that looks like a
    /// value and is not one, and that ends the run loudly. See this module's
    /// header.
    pub fn secret_data(self, message: &str) {
        write_stdout(message, true, Payload::Secret);
    }

    /// Emits secret-bearing output without adding a trailing newline.
    pub fn secret_data_raw(self, message: &str) {
        write_stdout(message, false, Payload::Secret);
    }

    /// Emits a JSON document built out of secret material.
    pub fn secret_json(self, value: &serde_json::Value) {
        write_stdout(&value.to_string(), true, Payload::Secret);
    }

    /// Emits an informational line on stderr.
    ///
    /// Suppressed by `-q`, and by `--json` -- under `--json` a successful run
    /// must leave stderr byte-empty.
    pub fn note(self, message: &str) {
        if !self.quiet && !self.json {
            note(message);
        }
    }

    /// Emits a warning on stderr.
    ///
    /// Suppressed by `-q` but **not** by `--json`, unless the run succeeds.
    /// A warning is usually the most important thing the tool has to say --
    /// "this server answered `/health` unauthenticated", for instance.
    pub fn warn(self, message: &str) {
        if !self.quiet {
            warn_styled(message, self.is_styled());
        }
    }

    /// Emits a diagnostic on stderr when `-v` was given at least `level` times.
    pub fn debug(self, level: u8, message: &str) {
        if self.is_verbose(level) && !self.json {
            note(message);
        }
    }

    /// Renders a failure, honouring the `--json` contract.
    ///
    /// Everything goes to stderr; stdout is left untouched so a redirected
    /// file is either a complete document or empty.
    pub fn failure(self, err: &CliError) {
        if self.json {
            // Byte-exact, whatever `--color` says. The failure envelope is
            // stderr's one machine-readable document, and a caller parsing it
            // is as entitled to clean bytes as one parsing stdout.
            note(&envelope(err).to_string());
            return;
        }

        error_styled(&err.to_string(), self.is_styled());
        if let Some(hint) = err.hint() {
            note(&format!("  help: {hint}"));
        }
    }
}

/// The `--json` failure envelope, as a document.
///
/// Built here rather than inline so a test can read it. It carries no styling
/// under any `--color` setting: this is the one machine-readable thing stderr
/// ever emits, and a caller piping it into a JSON parser is as entitled to
/// clean bytes as one piping stdout.
fn envelope(err: &CliError) -> serde_json::Value {
    let mut envelope = serde_json::json!({
        "error": {
            "code": err.code(),
            "message": err.to_string(),
        }
    });
    if let Some(hint) = err.hint() {
        envelope["error"]["hint"] = serde_json::Value::String(hint.to_owned());
    }
    envelope
}

impl From<&GlobalArgs> for Output {
    fn from(args: &GlobalArgs) -> Self {
        Self::new(args.json, args.quiet, args.verbose, args.color)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_suppresses_notes_but_never_data() {
        let out = Output::new(false, true, 0, ColorChoice::Auto);
        assert!(!out.is_verbose(1));
        // `data` has no suppression path at all; asserting the settings that
        // would gate it is the closest a unit test gets without capturing fds.
        assert!(!out.is_json());
    }

    #[test]
    fn verbosity_levels_are_cumulative() {
        let out = Output::new(false, false, 2, ColorChoice::Auto);
        assert!(out.is_verbose(1));
        assert!(out.is_verbose(2));
        assert!(!out.is_verbose(3));
    }

    #[test]
    fn quiet_wins_over_verbose() {
        let out = Output::new(false, true, 3, ColorChoice::Auto);
        assert!(!out.is_verbose(1));
    }

    #[test]
    fn settings_are_carried_from_the_global_flags() {
        let args = GlobalArgs {
            json: true,
            color: ColorChoice::Never,
            quiet: false,
            verbose: 1,
            no_input: true,
            yes: false,
            api_url: None,
            access_client_id: None,
            access_client_secret: None,
            access_client_secret_file: None,
            project: None,
            env: None,
            timeout: 30,
        };
        let out = Output::from(&args);
        assert!(out.is_json());
        assert_eq!(out.color(), ColorChoice::Never);
        assert!(out.is_verbose(1));
    }

    #[test]
    fn never_and_always_do_not_ask_the_environment() {
        // The two explicit settings are answers, not preferences. A test
        // process has no terminal on stderr, so `always` returning true here is
        // the whole assertion: a recorded session and a CI log are not
        // terminals and are still read by people.
        assert!(!styled(ColorChoice::Never));
        assert!(styled(ColorChoice::Always));
    }

    #[test]
    fn auto_is_off_when_stderr_is_not_a_terminal() {
        // Which is what a test process, a pipe and a redirect all are.
        assert!(!styled(ColorChoice::Auto));
    }

    #[test]
    fn a_prefix_is_wrapped_only_when_styling_is_on() {
        assert_eq!(paint("error:", RED, false), "error:");

        let painted = paint("error:", RED, true);
        assert!(painted.starts_with(RED), "{painted:?}");
        assert!(painted.ends_with(RESET), "{painted:?}");
        assert!(painted.contains("error:"), "{painted:?}");
    }

    #[test]
    fn the_json_error_envelope_has_a_code_and_a_message() {
        let err = CliError::NotImplemented { command: "secrets set" };
        let envelope = envelope(&err);
        assert_eq!(envelope["error"]["code"], "NOT_IMPLEMENTED");
        assert!(envelope["error"]["message"].as_str().is_some_and(|m| m.contains("secrets set")));
    }

    #[test]
    fn the_json_envelope_carries_no_escape_sequence_under_any_colour_setting() {
        // The envelope is stderr's one machine-readable document. `--color
        // always` is a request about the `error:` prefix on a human-readable
        // failure, never a licence to put SGR codes inside JSON a caller is
        // about to parse.
        let err = CliError::NotImplemented { command: "secrets set" };
        let rendered = envelope(&err).to_string();
        assert!(!rendered.contains('\u{1b}'), "{rendered}");
    }

    #[test]
    fn a_worse_stdout_outcome_always_has_a_higher_code() {
        // The latch is a `fetch_max`, so this ordering is the whole mechanism:
        // a run that loses the reader and then fails to write a value must
        // report the value, whichever order the two writes happened in.
        assert!(StdoutOutcome::Whole.code() < StdoutOutcome::ReaderGone.code());
        assert!(StdoutOutcome::ReaderGone.code() < StdoutOutcome::Truncated.code());
    }

    #[test]
    fn every_outcome_survives_the_round_trip_through_the_latch() {
        for outcome in [StdoutOutcome::Whole, StdoutOutcome::ReaderGone, StdoutOutcome::Truncated] {
            assert_eq!(StdoutOutcome::from_code(outcome.code()), outcome);
        }
    }

    #[test]
    fn a_latch_value_that_cannot_occur_reads_as_the_loud_one() {
        // Nothing writes a 3, and if something ever did, the answer that costs
        // a spurious error is better than the one that hides a truncated value.
        assert_eq!(StdoutOutcome::from_code(3), StdoutOutcome::Truncated);
        assert_eq!(StdoutOutcome::from_code(u8::MAX), StdoutOutcome::Truncated);
    }

    #[test]
    fn a_reader_that_hangs_up_is_only_quiet_for_output_it_could_ask_for_again() {
        use std::io::ErrorKind;

        assert_eq!(
            outcome_for(ErrorKind::BrokenPipe, Payload::Public),
            StdoutOutcome::ReaderGone,
            "`prk completions bash | head -2` is a shell idiom, not a failure"
        );
        assert_eq!(
            outcome_for(ErrorKind::BrokenPipe, Payload::Secret),
            StdoutOutcome::Truncated,
            "a half-written value must never be mistaken for a whole one"
        );
    }

    #[test]
    fn a_write_that_failed_for_any_other_reason_is_always_loud() {
        use std::io::ErrorKind;

        // A redirect onto a full disk is not a reader that had seen enough.
        for kind in [ErrorKind::StorageFull, ErrorKind::PermissionDenied, ErrorKind::Other] {
            for payload in [Payload::Public, Payload::Secret] {
                assert_eq!(outcome_for(kind, payload), StdoutOutcome::Truncated, "{kind:?}");
            }
        }
    }

    #[test]
    fn a_run_that_has_written_nothing_reports_a_whole_stdout() {
        // The latch is process-wide and starts at `Whole`. This test asserts
        // the starting point rather than a transition, because a transition
        // would have to break a real stdout to arrange -- and the outcome of
        // one is asserted end to end by the pipe tests in `tests/pipe.rs`.
        assert_eq!(StdoutOutcome::from_code(0), StdoutOutcome::Whole);
    }
}
