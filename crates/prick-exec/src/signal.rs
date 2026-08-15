//! Exit codes, signals and job control.
//!
//! # The `SIGPIPE` regression
//!
//! The Rust runtime sets `SIGPIPE` to `SIG_IGN` before `main` runs, because a
//! Rust program would rather see `EPIPE` from a write than die. That setting is
//! inherited across `exec`, so a child launched by `prk run` starts with
//! `SIGPIPE` ignored -- which is not what it was written to expect.
//!
//! Concretely, `prk run -- yes | head -1` **hangs forever**: `head` exits, the
//! pipe closes, and `yes` never receives the signal that would stop it. Every
//! program in a pipeline that relies on `SIGPIPE` to know when to stop is
//! affected, which is most of them.
//!
//! The fix is [`restore_default_dispositions`], called from `pre_exec`
//! immediately before the image is replaced. Its regression test is
//! `tests/unix_exec.rs::yes_piped_into_head_terminates_rather_than_hanging`.
//!
//! # The signal mask
//!
//! Blocked signals are also inherited across `exec`, and a blocked signal is
//! not something the child can discover or undo before it matters. `prk` does
//! not block anything itself, but it may have been started by something that
//! did, so the mask is cleared rather than assumed empty.

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

/// Restores the signal state a freshly-started program expects.
///
/// Runs in the child, between `fork` and `exec`, so **every call in here must
/// be async-signal-safe**. `signal` and `sigprocmask` both are; allocating,
/// locking, or formatting a string would not be.
///
/// Returns an error rather than aborting so the caller can report it; a failure
/// here is not recoverable, but it is diagnosable.
///
/// # Errors
///
/// Whatever `signal(2)` or `sigprocmask(2)` reported.
#[cfg(unix)]
pub fn restore_default_dispositions() -> std::io::Result<()> {
    // SAFETY: `signal` with SIG_DFL takes no pointer arguments and cannot fail
    // for a valid signal number other than by returning SIG_ERR, which is
    // checked. SIGPIPE is a valid signal number on every Unix.
    //
    // This runs after fork in the child, so the only thread in the process is
    // this one and there is no lock to contend for.
    let previous = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    if previous == libc::SIG_ERR {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: `sigemptyset` writes through a pointer to a `sigset_t` this
    // function owns and keeps alive for the duration of both calls.
    // `sigprocmask` reads through that same pointer and is passed a null
    // `oldset`, which the API documents as "do not report the previous mask".
    //
    // `sigset_t` has no invalid bit patterns, so the zeroed value handed to
    // `sigemptyset` is sound to construct even before it initialises it.
    unsafe {
        let mut empty: libc::sigset_t = std::mem::zeroed();
        if libc::sigemptyset(&raw mut empty) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::sigprocmask(libc::SIG_SETMASK, &raw const empty, std::ptr::null_mut()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }

    Ok(())
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

    #[cfg(unix)]
    #[test]
    fn the_signal_numbers_match_the_platforms() {
        assert_eq!(SIGINT, libc::SIGINT);
        assert_eq!(SIGPIPE, libc::SIGPIPE);
        assert_eq!(SIGTERM, libc::SIGTERM);
    }

    #[cfg(unix)]
    #[test]
    fn restoring_dispositions_succeeds_and_actually_changes_sigpipe() {
        // Runs in the test process rather than after a fork, which is the only
        // way to observe the result. The disposition is put back afterwards so
        // the rest of the suite still sees the runtime's setting.
        //
        // SAFETY: reading and restoring a signal disposition in a single-
        // threaded observation window; no pointers are involved.
        let original = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
        assert_ne!(original, libc::SIG_ERR);

        restore_default_dispositions().expect("restoring dispositions must succeed");

        // SAFETY: as above. Reads back what the call above installed.
        let now = unsafe { libc::signal(libc::SIGPIPE, original) };
        assert_eq!(now, libc::SIG_DFL, "SIGPIPE was not restored to its default disposition");
    }

    #[cfg(unix)]
    #[test]
    fn restoring_dispositions_clears_the_signal_mask() {
        // A blocked signal is inherited across exec, and the child has no way
        // to discover that it was blocked before the fact matters.
        //
        // SAFETY: `blocked` and `current` are live locals for the duration of
        // every call that writes through them, and the null `oldset` /
        // `set` arguments are the documented "do not report" and "query only"
        // forms.
        let still_blocked = unsafe {
            let mut blocked: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&raw mut blocked);
            libc::sigaddset(&raw mut blocked, libc::SIGUSR1);
            libc::sigprocmask(libc::SIG_BLOCK, &raw const blocked, std::ptr::null_mut());

            restore_default_dispositions().expect("restoring dispositions must succeed");

            let mut current: libc::sigset_t = std::mem::zeroed();
            libc::sigprocmask(libc::SIG_SETMASK, std::ptr::null(), &raw mut current);
            libc::sigismember(&raw const current, libc::SIGUSR1)
        };

        assert_eq!(still_blocked, 0, "the signal mask was not cleared");
    }
}
