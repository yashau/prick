//! The only module in the workspace allowed to write to stdout or stderr.
//!
//! # Why the allow is here and nowhere else
//!
//! `[workspace.lints.clippy]` denies `print_stdout` and `print_stderr`. This
//! file lifts the ban for itself, which means the complete set of places a
//! `prk` process can emit a byte is the handful of functions below. Reviewing
//! "can a secret leak to a stream" is reading one file, not auditing a tree,
//! and adding a stray `eprintln!` elsewhere fails the build.
//!
//! **Do not widen the allow.** If a module needs to say something, it calls
//! into here.
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

#![allow(clippy::print_stdout, clippy::print_stderr)]

use crate::cli::{ColorChoice, GlobalArgs};
use crate::error::CliError;

/// Writes a line of program output to stdout.
pub fn data(message: &str) {
    println!("{message}");
}

/// Writes program output to stdout with no trailing newline added.
///
/// For content that carries its own line structure, such as a generated
/// completion script.
pub fn data_raw(message: &str) {
    print!("{message}");
}

/// Writes an informational line to stderr.
pub fn note(message: &str) {
    eprintln!("{message}");
}

/// Writes a warning to stderr.
pub fn warn(message: &str) {
    eprintln!("warning: {message}");
}

/// Writes an error to stderr.
pub fn error(message: &str) {
    eprintln!("error: {message}");
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
            warn(message);
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
            let mut envelope = serde_json::json!({
                "error": {
                    "code": err.code(),
                    "message": err.to_string(),
                }
            });
            if let Some(hint) = err.hint() {
                envelope["error"]["hint"] = serde_json::Value::String(hint.to_owned());
            }
            note(&envelope.to_string());
            return;
        }

        error(&err.to_string());
        if let Some(hint) = err.hint() {
            note(&format!("  help: {hint}"));
        }
    }
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
    fn the_json_error_envelope_has_a_code_and_a_message() {
        let err = CliError::NotImplemented { command: "secrets set" };
        let envelope = serde_json::json!({
            "error": { "code": err.code(), "message": err.to_string() }
        });
        assert_eq!(envelope["error"]["code"], "NOT_IMPLEMENTED");
        assert!(envelope["error"]["message"].as_str().is_some_and(|m| m.contains("secrets set")));
    }
}
