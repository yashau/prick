//! `prk doctor`.
//!
//! # It never stops at the first failure
//!
//! The value of a diagnostic command is the whole picture. "Cannot reach the
//! server" and "your token file is world-readable" are both worth knowing, and
//! a command that reported the first and exited would hide the second behind
//! however long it takes to fix the first.
//!
//! So every check runs, each records a status, and the exit code is decided at
//! the end.

use prick_auth::{StorageBackend, TokenStore};

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;

/// How a single check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Working.
    Ok,
    /// Working, but worth knowing about.
    Warn,
    /// Not working.
    Fail,
    /// Not applicable, or not checked because a prerequisite failed.
    Skip,
}

impl Status {
    /// The marker printed in front of the check's name.
    ///
    /// ASCII rather than symbols: this output gets pasted into issue trackers
    /// and terminals with every imaginable font configuration.
    pub fn marker(self) -> &'static str {
        match self {
            Self::Ok => "ok  ",
            Self::Warn => "warn",
            Self::Fail => "FAIL",
            Self::Skip => "skip",
        }
    }

    /// The machine-readable name emitted under `--json`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
            Self::Skip => "skip",
        }
    }

    /// Whether this status should make the command exit non-zero.
    ///
    /// A warning does not: `prk doctor` is run to find out what is wrong, and
    /// a non-zero exit for "you installed this through npm" would make it
    /// useless in a health check.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Fail)
    }
}

/// One line of the report.
#[derive(Debug, Clone)]
pub struct Check {
    /// What was checked.
    pub name: &'static str,
    /// How it came out.
    pub status: Status,
    /// What was found. Never a credential.
    pub detail: String,
}

impl Check {
    fn new(name: &'static str, status: Status, detail: impl Into<String>) -> Self {
        Self { name, status, detail: detail.into() }
    }
}

/// Runs every check and reports.
///
/// # How the verdict is delivered
///
/// In human mode a failed check makes the command exit non-zero, so
/// `prk doctor && deploy` works.
///
/// Under `--json` the verdict is the `ok` field of the document instead, and
/// the command exits zero. That is deliberate: the `--json` contract says a
/// failed run leaves **stdout empty**, and a diagnostic report that disappears
/// exactly when there is something to diagnose would be worse than useless. The
/// report is the answer to the question that was asked; whether the news is
/// good is a field in it.
///
/// # Errors
///
/// [`CliError::Other`] when at least one check failed and `--json` was not
/// given. The report itself is always printed first.
pub fn run(global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut checks: Vec<Check> = Vec::new();

    // 1. Where are we pointed, and did that come from a flag or a login.
    let context = match Context::new(global) {
        Ok(context) => {
            let source = if global.api_url.is_some() {
                "from --api-url or PRK_API_URL"
            } else {
                "from the stored login"
            };
            checks.push(Check::new(
                "server url",
                Status::Ok,
                format!("{} ({source})", context.api_url()),
            ));
            Some(context)
        }
        Err(err) => {
            checks.push(Check::new("server url", Status::Fail, err.to_string()));
            None
        }
    };

    // 2. Token storage, whether or not the server is reachable.
    checks.push(token_file_check());

    // 3. Reachability and identity, which need the server.
    if let Some(mut context) = context {
        checks.extend(server_checks(&mut context, out));
    } else {
        checks.push(Check::new("reachability", Status::Skip, "no server url to test"));
    }

    // 4. How this binary was installed.
    checks.push(installation_check());

    let failed = checks.iter().any(|check| check.status.is_failure());
    report(&checks, failed, global, out);

    if failed && !global.json {
        return Err(CliError::Other("one or more checks failed".to_owned()));
    }
    Ok(())
}

/// Checks the credentials file's permissions.
///
/// A token readable by group or other is a finding on Unix; on Windows the
/// equivalent is a DACL that grants anyone but the owner, which is what
/// `prick_exec::winsec` verifies.
fn token_file_check() -> Check {
    let store = match TokenStore::new(StorageBackend::File) {
        Ok(store) => store,
        Err(err) => return Check::new("token storage", Status::Fail, err.to_string()),
    };

    let path = store.path();
    if !path.exists() {
        return Check::new(
            "token storage",
            Status::Skip,
            format!("{} does not exist", path.display()),
        );
    }

    match store.is_owner_only() {
        Ok(true) => {
            Check::new("token storage", Status::Ok, format!("{} is owner-only", path.display()))
        }
        Ok(false) => Check::new(
            "token storage",
            Status::Fail,
            format!(
                "{} is readable by more than its owner; delete it and run `prk login` again",
                path.display()
            ),
        ),
        Err(err) => Check::new("token storage", Status::Warn, err.to_string()),
    }
}

/// Everything that needs to talk to the server.
fn server_checks(context: &mut Context, out: Output) -> Vec<Check> {
    let mut checks = Vec::new();

    // Unauthenticated first: the probe is the only thing that can tell an
    // unprotected server from a protected one, and it must run before any
    // credential is sent.
    match context.block_on(prick_auth::discovery::probe(context.client())) {
        Ok(probe) => {
            let check = match &probe {
                prick_auth::Probe::ManagedOAuth { .. } => Check::new(
                    "access",
                    Status::Ok,
                    "Cloudflare Access with managed OAuth is in front of this server",
                ),
                prick_auth::Probe::ManagedOAuthDisabled => Check::new(
                    "access",
                    Status::Fail,
                    "Cloudflare Access is in front, but managed OAuth is not enabled, so \
                     `prk login` cannot complete",
                ),
                prick_auth::Probe::Unprotected => Check::new(
                    "access",
                    Status::Fail,
                    prick_auth::discovery::UNPROTECTED_WARNING.to_owned(),
                ),
            };
            checks.push(check);
        }
        Err(err) => {
            checks.push(Check::new("reachability", Status::Fail, err.to_string()));
            return checks;
        }
    }

    // Then with a credential, if there is one.
    match context.authenticate(out) {
        Ok(()) => {
            let url = context.client().url(&["whoami"]);
            match context.block_on(context.client().get_json::<prick_api::models::Whoami>(&url)) {
                Ok(identity) => checks.push(Check::new(
                    "identity",
                    Status::Ok,
                    format!("{} ({})", identity.subject, identity.kind),
                )),
                Err(err) => {
                    let request_id =
                        err.request_id().map(|id| format!(" [request {id}]")).unwrap_or_default();
                    checks.push(Check::new("identity", Status::Fail, format!("{err}{request_id}")));
                }
            }
        }
        Err(err) => checks.push(Check::new("credentials", Status::Warn, err.to_string())),
    }

    checks
}

/// Notes when the binary is being run through the npm shim.
///
/// The shim routes every call through Node, which costs 30-40 ms and keeps a
/// Node parent alive for the child's lifetime during `prk run` -- defeating the
/// point of replacing the process. It is inherent to npm's `bin` mechanism, so
/// this is mentioned once, as a warning rather than a failure.
fn installation_check() -> Check {
    let via_npm = std::env::var_os("npm_execpath").is_some()
        || std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.join("node_modules").is_dir()))
            .unwrap_or(false);

    if via_npm {
        Check::new(
            "installation",
            Status::Warn,
            "running through the npm shim, which adds a Node process to every invocation; \
             a direct install (cargo binstall, Homebrew, Scoop, or a release tarball) avoids it",
        )
    } else {
        Check::new("installation", Status::Ok, "running as a native binary")
    }
}

/// Prints the report.
fn report(checks: &[Check], failed: bool, global: &GlobalArgs, out: Output) {
    if global.json {
        let rows: Vec<serde_json::Value> = checks
            .iter()
            .map(|check| {
                serde_json::json!({
                    "name": check.name,
                    "status": check.status.as_str(),
                    "detail": check.detail,
                })
            })
            .collect();
        out.json(&serde_json::json!({ "ok": !failed, "checks": rows }));
        return;
    }

    for check in checks {
        out.data(&format!("{} {:<14} {}", check.status.marker(), check.name, check.detail));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_failure_makes_the_command_exit_non_zero() {
        assert!(Status::Fail.is_failure());
        assert!(!Status::Warn.is_failure(), "a warning must not break a health check");
        assert!(!Status::Ok.is_failure());
        assert!(!Status::Skip.is_failure());
    }

    #[test]
    fn every_status_has_a_distinct_marker_and_name() {
        let all = [Status::Ok, Status::Warn, Status::Fail, Status::Skip];

        let mut markers: Vec<&str> = all.iter().map(|s| s.marker()).collect();
        markers.sort_unstable();
        markers.dedup();
        assert_eq!(markers.len(), all.len());

        let mut names: Vec<&str> = all.iter().map(|s| s.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), all.len());
    }

    #[test]
    fn the_markers_are_ascii_so_they_survive_any_terminal() {
        for status in [Status::Ok, Status::Warn, Status::Fail, Status::Skip] {
            assert!(status.marker().is_ascii(), "{status:?} uses a non-ASCII marker");
        }
    }

    #[test]
    fn an_unprotected_server_is_a_failure_rather_than_a_note() {
        // The single most important thing this command can report.
        let check = Check::new(
            "access",
            Status::Fail,
            prick_auth::discovery::UNPROTECTED_WARNING.to_owned(),
        );
        assert!(check.status.is_failure());
        assert!(check.detail.contains("NOT protected"));
    }

    #[test]
    fn a_missing_token_file_is_skipped_rather_than_failed() {
        // Not being logged in is a normal state, not a finding.
        let check = Check::new("token storage", Status::Skip, "does not exist");
        assert!(!check.status.is_failure());
    }

    #[test]
    fn the_npm_shim_is_a_warning_and_names_the_alternatives() {
        let check = installation_check();
        if check.status == Status::Warn {
            assert!(check.detail.contains("binstall") || check.detail.contains("Homebrew"));
        }
        assert!(!check.status.is_failure(), "how prk was installed is never a failure");
    }
}
