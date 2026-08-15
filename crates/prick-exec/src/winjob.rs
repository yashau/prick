//! Windows job objects and console control handling.
//!
//! Windows has no `exec`, so `prk run` supervises rather than becomes the
//! child. That reintroduces two problems Unix does not have.
//!
//! # Orphans
//!
//! Killing a process on Windows does not kill what it started. `prk run -- npm
//! test` is `cmd.exe` running `node` running a test runner running browsers; if
//! `prk` dies, everything below `cmd.exe` keeps running, holding ports and
//! file locks with no parent left to reap it.
//!
//! A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` fixes this
//! structurally: the whole tree is terminated when the last handle to the job
//! closes, which happens when `prk` exits **for any reason**, including being
//! killed itself. There is no cleanup path to forget to write.
//!
//! # Ctrl-C
//!
//! A console control event is delivered to every process attached to the
//! console, so the child already receives it. Without a handler `prk` would
//! also take the default action -- terminate immediately -- and the caller
//! would see `prk`'s status rather than the child's, and would see it before
//! the child had finished shutting down.
//!
//! So the handler returns `TRUE` for `CTRL_C_EVENT` and `CTRL_BREAK_EVENT`,
//! meaning "handled, do not run the default action". `prk` then simply
//! continues waiting, and reports whatever the child decided to exit with. It
//! returns `FALSE` for close, logoff and shutdown, because those are not the
//! child's to interpret and the job object is what cleans up.

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, TRUE};
use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, SetConsoleCtrlHandler};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

/// A job object that terminates its members when the last handle closes.
///
/// Not `Clone`: duplicating the handle would defeat the kill-on-close
/// guarantee, because the job survives until *every* handle is gone.
#[derive(Debug)]
pub struct Job {
    handle: HANDLE,
}

// The handle is an opaque kernel object reference, not a pointer into this
// process's address space. Moving it between threads is what the Windows API
// expects; the raw pointer type is the only reason this is not automatic.
//
// SAFETY: every use goes through a Win32 call that is documented as
// thread-safe, and `Drop` closes the handle exactly once because `Job` is not
// `Clone` and does not expose the raw handle.
unsafe impl Send for Job {}

impl Job {
    /// Creates an anonymous job object with `KILL_ON_JOB_CLOSE` set.
    ///
    /// # Errors
    ///
    /// Whatever `CreateJobObjectW` or `SetInformationJobObject` reported.
    pub fn create_kill_on_close() -> io::Result<Self> {
        // SAFETY: both pointer arguments are null, which the API documents as
        // "default security attributes" and "unnamed". The returned handle is
        // checked for null before being stored, and ownership of it passes to
        // the `Job` returned here, whose `Drop` closes it exactly once.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };

        // SAFETY: `zeroed` is a valid value for this struct -- every field is
        // an integer or a pointer, and all-zero means "no limit" for each of
        // them. The struct is fully owned by this frame and outlives the call.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(|_| io::Error::other("job object limit structure is implausibly large"))?;

        // SAFETY: `job.handle` is a live job handle. The pointer refers to the
        // `limits` value above, which is alive for the duration of the call,
        // and `size` is its exact size, which is what the information class
        // requires.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size,
            )
        };
        if ok == FALSE {
            return Err(io::Error::last_os_error());
        }

        Ok(job)
    }

    /// Adds a process to the job.
    ///
    /// # Safety
    ///
    /// `process` must be a live process handle with `PROCESS_SET_QUOTA` and
    /// `PROCESS_TERMINATE` access, and must stay live for the duration of the
    /// call. In practice it comes from `Child::as_raw_handle`, whose `Child`
    /// outlives the call.
    ///
    /// # Errors
    ///
    /// Whatever `AssignProcessToJobObject` reported. The common failure is a
    /// process that already belongs to a job that forbids nesting, which only
    /// happens on Windows 7 and earlier.
    pub unsafe fn assign(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: `self.handle` is a live job handle owned by `self`, and
        // `process` is live for the duration of the call by this function's
        // own safety contract.
        let ok = unsafe { AssignProcessToJobObject(self.handle, process) };
        if ok == FALSE {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: `self.handle` was returned by `CreateJobObjectW` and has not
        // been closed, because `Job` is not `Clone`, does not hand out the raw
        // handle, and this is the only place that closes it.
        //
        // Closing the last handle is what terminates the job's members. That is
        // the intended effect, not a side effect to guard against.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// Installs the console control handler, once per process.
///
/// # Errors
///
/// Whatever `SetConsoleCtrlHandler` reported.
pub fn install_console_ctrl_handler() -> io::Result<()> {
    use std::sync::OnceLock;

    static INSTALLED: OnceLock<Result<(), i32>> = OnceLock::new();

    let outcome = INSTALLED.get_or_init(|| {
        // SAFETY: `handler` is a real `extern "system"` function with the
        // signature the API requires, and it has `'static` lifetime because it
        // is an item. `TRUE` means "add", so nothing is removed.
        let ok = unsafe { SetConsoleCtrlHandler(Some(handler), TRUE) };
        if ok == FALSE {
            Err(io::Error::last_os_error().raw_os_error().unwrap_or(0))
        } else {
            Ok(())
        }
    });

    outcome.map_err(io::Error::from_raw_os_error)
}

/// Claims Ctrl-C and Ctrl-Break so the child decides what they mean.
///
/// Runs on a thread the operating system creates for the purpose, concurrently
/// with everything else in the process, so it does exactly one thing: return a
/// constant. Anything that took a lock here could deadlock against the main
/// thread at the worst possible moment.
extern "system" fn handler(event: u32) -> windows_sys::core::BOOL {
    match event {
        // Handled: the child received the same event and gets to decide.
        CTRL_C_EVENT | CTRL_BREAK_EVENT => TRUE,
        // Not ours. Default handling runs, the process exits, the last job
        // handle closes, and the job terminates whatever is left.
        _ => FALSE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_can_be_created_and_dropped() {
        let job = Job::create_kill_on_close().expect("creating a job object must succeed");
        drop(job);
    }

    #[test]
    fn the_handler_claims_interrupts_and_declines_shutdown() {
        use windows_sys::Win32::System::Console::{
            CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
        };

        assert_eq!(handler(CTRL_C_EVENT), TRUE, "Ctrl-C must not kill prk before the child");
        assert_eq!(handler(CTRL_BREAK_EVENT), TRUE);

        for event in [CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT] {
            assert_eq!(handler(event), FALSE, "event {event} must fall through to the default");
        }
    }

    #[test]
    fn installing_the_handler_is_idempotent() {
        install_console_ctrl_handler().expect("first install");
        install_console_ctrl_handler().expect("second install must be a no-op");
    }
}
