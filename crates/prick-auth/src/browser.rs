//! Opening the system browser.
//!
//! # Detached, always
//!
//! The launcher is not waited on. On Windows the default handler is invoked
//! through a helper process that exits immediately, on Linux `xdg-open` may or
//! may not fork depending on the desktop, and on macOS `open` returns at once.
//! Waiting for any of them would either return instantly or block until the
//! user closed their browser, and there is no way to tell in advance which.
//!
//! # A failure here is not fatal
//!
//! On a headless machine there is no browser, and that has to remain
//! recoverable: the caller prints the URL and the listener keeps waiting, so a
//! login started over SSH can be finished by pasting the URL into a browser on
//! the local machine. That is why [`open`] returns a `Result` the caller may
//! choose to downgrade to a warning rather than something that ends the run.

use crate::error::AuthError;

/// Opens a URL in the system browser, without waiting for it.
///
/// # Errors
///
/// [`AuthError::Browser`] if no handler could be started. The caller is
/// expected to fall back to printing the URL rather than abandoning the login.
pub fn open(url: &str) -> Result<(), AuthError> {
    // A URL this process just built from a discovered endpoint, not something
    // read from a response body: nothing user-controlled reaches the launcher.
    open::that_detached(url).map_err(|err| AuthError::Browser { reason: err.to_string() })
}

/// Whether this environment plausibly has a browser to open.
///
/// A best-effort check used to decide whether to *try* opening one or to print
/// the URL straight away. It is deliberately not consulted for correctness: a
/// wrong answer costs a redundant message, not a failed login.
pub fn is_available() -> bool {
    if cfg!(windows) || cfg!(target_os = "macos") {
        return true;
    }
    // On Unix, a session with neither an X display nor a Wayland one has
    // nothing that can render a login page. This is also the SSH case, which is
    // the one that matters.
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_leaves_a_way_to_finish_the_login() {
        // Not driven through `open` itself: every platform's launcher reports
        // success for a target it merely handed to a helper process, so a test
        // that tried to provoke a real failure would assert nothing on some
        // platforms and hang on others. What matters is that the failure the
        // caller receives is recoverable, which is a property of the error.
        let err = AuthError::Browser { reason: "no display".to_owned() };

        let hint = err.hint().expect("this failure must be actionable");
        assert!(hint.contains("manually"), "{hint}");
        assert!(hint.contains("PRK_ACCESS_CLIENT_ID"), "{hint}");
        assert!(err.to_string().contains("no display"));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn a_desktop_platform_always_reports_a_browser() {
        assert!(is_available());
    }
}
