//! Exit codes, signals and job control.
//!
//! # Status
//!
//! Skeleton. The exit-code mapping is implemented; the signal handling is not.
//!
//! # The `SIGPIPE` regression
//!
//! The Rust runtime sets `SIGPIPE` to `SIG_IGN` before `main` runs, because a
//! Rust program would rather see `EPIPE` from a write than die. That setting is
//! inherited across `exec`, so a child launched by `prk run` starts with
//! `SIGPIPE` ignored -- which is not what it was written to expect.
//!
//! Concretely, `prk run -- yes | head -1` **hangs forever**: `head` exits, the
//! pipe closes, and `yes` never receives the signal that would stop it.
//!
//! The fix is to reset `SIGPIPE` to `SIG_DFL` immediately before `exec`, inside
//! `CommandExt::pre_exec`. That is a named regression test, not a comment.
//!
//! TODO:
//!
//! - `pre_exec` hook restoring `SIGPIPE` to `SIG_DFL` (this is the `unsafe`).
//! - Windows: `SetConsoleCtrlHandler` plus a job object with
//!   `KILL_ON_JOB_CLOSE`, so Ctrl-C reaches the whole tree and nothing is
//!   orphaned when `prk` dies.
//! - Integration tests: exit codes preserved, `SIGTERM` producing 143,
//!   `SIGINT` producing 130, argv preserved byte for byte including non-UTF-8,
//!   `yes | head -1` terminating, and `npm.cmd --version` working on Windows.

/// The offset a shell adds to a signal number to form an exit status.
pub const SIGNAL_EXIT_BASE: i32 = 128;

/// `SIGINT`, the signal Ctrl-C sends.
pub const SIGINT: i32 = 2;

/// `SIGPIPE`, which the Rust runtime ignores and which must be restored.
pub const SIGPIPE: i32 = 13;

/// `SIGTERM`, the default `kill` signal.
pub const SIGTERM: i32 = 15;

/// The exit status a shell reports for a process killed by a signal.
///
/// `prk run` must reproduce this exactly, so that a caller cannot tell whether
/// the command ran under `prk run` or directly. Anything else breaks scripts
/// that branch on `$?`.
pub fn exit_status_for_signal(signal: i32) -> i32 {
    SIGNAL_EXIT_BASE + signal
}

/// Maps a child's outcome to the status `prk` should exit with.
///
/// `None` means the child was killed by a signal rather than exiting normally.
pub fn child_exit_status(code: Option<i32>, signal: Option<i32>) -> i32 {
    match (code, signal) {
        (Some(code), _) => code,
        (None, Some(signal)) => exit_status_for_signal(signal),
        // A child that neither exited nor was signalled is not a state the OS
        // reports; treat it as a generic failure rather than inventing a code.
        (None, None) => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_exit_statuses_match_the_shell_convention() {
        assert_eq!(exit_status_for_signal(SIGINT), 130);
        assert_eq!(exit_status_for_signal(SIGTERM), 143);
        assert_eq!(exit_status_for_signal(SIGPIPE), 141);
    }

    #[test]
    fn a_normal_exit_code_passes_through_unchanged() {
        for code in [0, 1, 2, 42, 255] {
            assert_eq!(child_exit_status(Some(code), None), code);
        }
    }

    #[test]
    fn a_signalled_child_reports_the_shell_status() {
        assert_eq!(child_exit_status(None, Some(SIGTERM)), 143);
        assert_eq!(child_exit_status(None, Some(SIGINT)), 130);
    }

    #[test]
    fn an_exit_code_wins_over_a_signal() {
        // Both present is contradictory; the code is the more specific fact.
        assert_eq!(child_exit_status(Some(3), Some(SIGTERM)), 3);
    }

    #[test]
    fn an_unknown_outcome_is_a_generic_failure_not_a_success() {
        assert_eq!(child_exit_status(None, None), 1);
    }
}
