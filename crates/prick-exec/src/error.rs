//! Why a launch failed, and what the shell would have exited with.
//!
//! The exit codes here are **not** from the API taxonomy in
//! [`prick_core::classify`]. They are the shell convention for a command that
//! could not be started, and they are what a caller of `prk run` already
//! branches on:
//!
//! | Code | Meaning |
//! |---|---|
//! | 126 | Found, but could not be executed |
//! | 127 | Not found |
//!
//! Reproducing them exactly is the point of `prk run`: a script must not be
//! able to tell whether a command ran under `prk run` or directly.

use std::ffi::OsStr;
use std::io;

use prick_core::keyname::KeyNameError;

use crate::guard::GuardError;

/// The status a shell reports when a command was found but cannot be run.
pub const EXIT_NOT_EXECUTABLE: i32 = 126;

/// The status a shell reports when a command was not found.
pub const EXIT_NOT_FOUND: i32 = 127;

/// A launch that did not happen.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum LaunchError {
    /// No program was given.
    #[error("no command was given to run")]
    NoProgram,

    /// The program does not exist on `PATH`.
    #[error("command not found: {program}")]
    NotFound {
        /// The program as the user wrote it.
        program: String,
    },

    /// The program exists but is not executable by this user.
    #[error("permission denied: {program}")]
    PermissionDenied {
        /// The resolved program path.
        program: String,
    },

    /// The file exists and is executable but is not a program image.
    ///
    /// Almost always a script whose shebang line is missing, misspelled, or
    /// carries a CRLF line ending that makes the interpreter path unresolvable.
    #[error("{program} is not an executable format")]
    NoExecFormat {
        /// The resolved program path.
        program: String,
    },

    /// A secret's name is not usable as an environment variable.
    #[error("cannot inject `{key}` into the child environment: {source}")]
    InvalidKey {
        /// The offending name.
        key: String,
        /// Why it was rejected.
        source: KeyNameError,
    },

    /// A secret's name is one the loader or a language runtime interprets.
    #[error(transparent)]
    Guard(#[from] GuardError),

    /// An argument cannot be carried through `cmd.exe` to a batch shim.
    #[error(transparent)]
    CommandLine(#[from] crate::cmdline::CmdLineError),

    /// The launch failed for a reason the operating system reported.
    #[error("could not run {program}: {source}")]
    Io {
        /// The program that was being launched.
        program: String,
        /// The underlying failure.
        source: io::Error,
    },
}

impl LaunchError {
    /// The status `prk` should exit with for this failure.
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::NotFound { .. } => EXIT_NOT_FOUND,
            Self::PermissionDenied { .. } | Self::NoExecFormat { .. } => EXIT_NOT_EXECUTABLE,
            // Refusing to launch is a rejection of the request, not a failure
            // of the command, so it does not borrow the shell's codes.
            Self::NoProgram
            | Self::InvalidKey { .. }
            | Self::Guard(_)
            | Self::CommandLine(_)
            | Self::Io { .. } => i32::from(prick_core::classify::EXIT_FAILURE),
        }
    }

    /// The actionable next step, for the structured help channel.
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::NotFound { .. } => Some(
                "Check the spelling and that the program is on PATH. `prk run` never invokes a \
                 shell, so shell builtins and aliases are not available; write `prk run -- sh -c \
                 '...'` if you need one.",
            ),
            Self::PermissionDenied { .. } => {
                Some("The file exists but is not executable. On Unix, check its mode bits.")
            }
            // The single most common cause, and invisible in a directory
            // listing, so it is worth naming outright.
            Self::NoExecFormat { .. } => Some(
                "The file is not a program image. If it is a script, check that its first line is \
                 a shebang such as `#!/usr/bin/env node` and that the file has Unix line endings \
                 -- a CRLF makes the interpreter path unresolvable.",
            ),
            Self::Guard(_) => Some(
                "Rename the secret, or pass --allow-unsafe-env if the child really is meant to be \
                 configured this way.",
            ),
            Self::CommandLine(_) => Some(
                "The program is a .cmd or .bat shim, so its arguments pass through cmd.exe, which \
                 cannot carry a line break. Pass the value through a file or an environment \
                 variable instead.",
            ),
            Self::NoProgram | Self::InvalidKey { .. } | Self::Io { .. } => None,
        }
    }

    /// Classifies an [`io::Error`] from a failed launch.
    ///
    /// The three interesting cases each have a distinct exit code and a
    /// distinct fix, and all three arrive as the same `io::Error` type.
    pub fn from_io(program: &OsStr, source: io::Error) -> Self {
        let program = program.to_string_lossy().into_owned();
        match source.kind() {
            io::ErrorKind::NotFound => Self::NotFound { program },
            io::ErrorKind::PermissionDenied => Self::PermissionDenied { program },
            _ => {
                if is_exec_format_error(&source) {
                    Self::NoExecFormat { program }
                } else {
                    Self::Io { program, source }
                }
            }
        }
    }
}

/// Whether an error is `ENOEXEC`, which has no `io::ErrorKind` of its own.
#[cfg(unix)]
fn is_exec_format_error(source: &io::Error) -> bool {
    source.raw_os_error() == Some(libc::ENOEXEC)
}

/// Windows reports a file that is not a runnable image under two codes.
///
/// `ERROR_BAD_EXE_FORMAT` is the one a malformed or 16-bit image gets.
/// `ERROR_EXE_MACHINE_TYPE_MISMATCH` covers an image built for another machine,
/// and is also what `CreateProcess` reports for a file whose contents are not an
/// image at all -- a script saved as `.exe`, say. Both mean the file was found
/// and cannot be executed here, which is what a shell exits 126 for.
#[cfg(windows)]
fn is_exec_format_error(source: &io::Error) -> bool {
    /// `ERROR_BAD_EXE_FORMAT`.
    const ERROR_BAD_EXE_FORMAT: i32 = 193;
    /// `ERROR_EXE_MACHINE_TYPE_MISMATCH`.
    const ERROR_EXE_MACHINE_TYPE_MISMATCH: i32 = 216;
    matches!(source.raw_os_error(), Some(ERROR_BAD_EXE_FORMAT | ERROR_EXE_MACHINE_TYPE_MISMATCH))
}

#[cfg(not(any(unix, windows)))]
fn is_exec_format_error(_source: &io::Error) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn a_missing_command_exits_127_like_a_shell() {
        let err = LaunchError::from_io(
            &OsString::from("nosuchprogram"),
            io::Error::new(io::ErrorKind::NotFound, "not found"),
        );
        assert!(matches!(err, LaunchError::NotFound { .. }));
        assert_eq!(err.exit_code(), 127);
    }

    #[test]
    fn an_unexecutable_command_exits_126_like_a_shell() {
        let err = LaunchError::from_io(
            &OsString::from("/etc/hosts"),
            io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
        );
        assert!(matches!(err, LaunchError::PermissionDenied { .. }));
        assert_eq!(err.exit_code(), 126);
    }

    #[cfg(unix)]
    #[test]
    fn enoexec_is_recognised_and_points_at_the_shebang() {
        let err = LaunchError::from_io(
            &OsString::from("./script"),
            io::Error::from_raw_os_error(libc::ENOEXEC),
        );
        assert!(matches!(err, LaunchError::NoExecFormat { .. }));
        assert_eq!(err.exit_code(), 126);
        assert!(err.hint().is_some_and(|h| h.contains("shebang")));
    }

    #[cfg(windows)]
    #[test]
    fn a_non_image_file_is_recognised_and_points_at_the_shebang() {
        let err =
            LaunchError::from_io(&OsString::from("script.txt"), io::Error::from_raw_os_error(193));
        assert!(matches!(err, LaunchError::NoExecFormat { .. }));
        assert_eq!(err.exit_code(), 126);
        assert!(err.hint().is_some_and(|h| h.contains("shebang")));
    }

    /// The code a file that is not an image at all actually arrives with, so a
    /// `.exe` holding anything else exits 126 rather than falling through to
    /// the generic 1.
    #[cfg(windows)]
    #[test]
    fn an_image_this_machine_cannot_run_is_recognised_too() {
        let err =
            LaunchError::from_io(&OsString::from("script.exe"), io::Error::from_raw_os_error(216));
        assert!(matches!(err, LaunchError::NoExecFormat { .. }));
        assert_eq!(err.exit_code(), 126);
    }

    #[test]
    fn the_message_names_the_program_but_never_a_value() {
        let err = LaunchError::NotFound { program: "npm".to_owned() };
        assert!(err.to_string().contains("npm"));
    }

    #[test]
    fn a_guard_refusal_keeps_its_own_message_and_hint() {
        let err = LaunchError::from(GuardError::LoaderControlled { name: "LD_PRELOAD".to_owned() });
        assert!(err.to_string().contains("LD_PRELOAD"));
        assert!(err.hint().is_some_and(|h| h.contains("--allow-unsafe-env")));
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn an_unrepresentable_argument_reports_which_one() {
        let err = LaunchError::from(crate::cmdline::CmdLineError::LineBreak { index: 2 });
        assert!(err.to_string().contains("argument 2"));
        assert!(err.hint().is_some());
    }

    #[test]
    fn an_invalid_key_names_the_key_and_the_reason() {
        let err = LaunchError::InvalidKey {
            key: "A-B".to_owned(),
            source: KeyNameError::InvalidCharacter { name: "A-B".to_owned(), ch: '-' },
        };
        let message = err.to_string();
        assert!(message.contains("A-B"));
        assert!(message.contains('-'));
    }
}
