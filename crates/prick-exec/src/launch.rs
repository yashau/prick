//! Resolving the program and building the child process.
//!
//! # Status
//!
//! Skeleton. The Windows hazard is documented and its detection is
//! implemented; nothing spawns yet.
//!
//! TODO:
//!
//! - Unix: `Command::args()` with the captured `Vec<OsString>`, then
//!   `CommandExt::exec()`. Replacing the process rather than spawning and
//!   forwarding makes exit codes and signals correct by construction, job
//!   control included.
//! - Windows: resolve through `which` (PATHEXT-aware), spawn into a job object
//!   with `KILL_ON_JOB_CLOSE` so no orphan survives, and install a
//!   `SetConsoleCtrlHandler`.
//!
//! # The Windows hazard
//!
//! Since the fix for CVE-2024-24576, `std::process::Command` **refuses to
//! execute `.bat` and `.cmd` files** unless the caller opts in with `raw_arg`.
//! `npm`, `pnpm`, `npx`, `yarn` and `tsc` are all `.cmd` shims on Windows, so
//! `prk run -- npm test` fails out of the box on the platform this project is
//! developed on.
//!
//! The fix is to detect a batch target with [`is_batch_target`], resolve it via
//! `PATHEXT`, and build a correctly quoted `cmd.exe /d /s /c` command line.
//! `cmd.exe` quoting is genuinely different from `CommandLineToArgvW` quoting
//! -- `^` escapes, `%VAR%` expands, and `"` nests differently -- so that
//! builder gets unit tests against adversarial arguments before it is trusted.

use std::ffi::OsStr;
use std::path::Path;

/// Executable extensions that `cmd.exe` must interpret rather than the loader.
pub const BATCH_EXTENSIONS: [&str; 2] = ["bat", "cmd"];

/// Whether a resolved program path must be run through `cmd.exe`.
///
/// The comparison is case-insensitive: Windows filesystems are, and `NPM.CMD`
/// is the same shim as `npm.cmd`.
pub fn is_batch_target(program: &OsStr) -> bool {
    Path::new(program)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| BATCH_EXTENSIONS.iter().any(|b| ext.eq_ignore_ascii_case(b)))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn batch_shims_are_detected() {
        for program in [r"C:\Program Files\nodejs\npm.cmd", r"C:\tools\build.bat", "pnpm.CMD"] {
            assert!(is_batch_target(&OsString::from(program)), "{program} not detected");
        }
    }

    #[test]
    fn real_executables_are_not() {
        for program in [r"C:\Windows\System32\where.exe", "/usr/bin/node", "node", "npm"] {
            assert!(!is_batch_target(&OsString::from(program)), "{program} falsely detected");
        }
    }

    #[test]
    fn detection_is_case_insensitive_like_the_filesystem() {
        assert!(is_batch_target(&OsString::from("npm.CMD")));
        assert!(is_batch_target(&OsString::from("npm.Cmd")));
        assert!(is_batch_target(&OsString::from("build.BAT")));
    }

    #[test]
    fn a_dot_in_a_directory_name_does_not_trigger_detection() {
        assert!(!is_batch_target(&OsString::from("/opt/my.cmd.tools/node")));
    }
}
