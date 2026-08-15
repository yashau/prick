//! Resolving the program, building the environment, and starting the child.
//!
//! # Unix replaces, Windows supervises
//!
//! On Unix `prk run` calls `execvp` and **becomes** the child. Nothing forwards
//! signals, nothing translates exit codes, and `SIGTSTP`/`SIGCONT` job control
//! works because there is no longer a `prk` in the process tree to get it
//! wrong. The only correctness work is in what is inherited across the
//! `exec` -- see [`crate::signal`].
//!
//! Windows has no `exec`, so there `prk` spawns and waits. That reintroduces
//! the two problems Unix does not have, and both are handled explicitly:
//! orphaned grandchildren (a job object with `KILL_ON_JOB_CLOSE`) and Ctrl-C
//! arriving at `prk` rather than at the child (a console control handler).
//!
//! # Argv is never a string
//!
//! `clap`'s `trailing_var_arg` hands over a `Vec<OsString>` and it reaches
//! `Command::args` unchanged, which passes it to `execvp` as a vector. There is
//! no command line to quote and none to parse back, so the entire class of
//! shell-quoting bugs is structurally absent and non-UTF-8 arguments survive
//! byte for byte.
//!
//! The one exception is a Windows batch shim, where `cmd.exe` genuinely does
//! interpose a string. That is [`crate::cmdline`], and it is the only place in
//! this crate where an argument is escaped rather than passed.

use std::convert::Infallible;
use std::ffi::{OsStr, OsString};
use std::io::Write as _;
use std::path::Path;

use secrecy::{ExposeSecret as _, SecretString};

use prick_core::keyname;

use crate::error::LaunchError;
use crate::guard::EnvGuard;

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

/// Everything needed to start a child process.
///
/// Secret values are held as [`SecretString`] right up to the moment they are
/// handed to the process API, so no intermediate copy is formattable and the
/// derived `Debug` prints the redaction rather than the value.
#[derive(Debug)]
pub struct LaunchSpec {
    argv: Vec<OsString>,
    env: Vec<(String, SecretString)>,
}

impl LaunchSpec {
    /// Builds a spec from a captured argv.
    ///
    /// # Errors
    ///
    /// Returns [`LaunchError::NoProgram`] if `argv` is empty.
    pub fn new(argv: Vec<OsString>) -> Result<Self, LaunchError> {
        if argv.is_empty() {
            return Err(LaunchError::NoProgram);
        }
        Ok(Self { argv, env: Vec::new() })
    }

    /// Adds secrets to the child's environment, applying the guard first.
    ///
    /// Every name is validated with [`prick_core::keyname::validate`] and then
    /// checked against `guard`. The whole launch fails on the first refusal
    /// rather than dropping the offending variable: a child started with a
    /// silently missing variable is a debugging problem, and a child started
    /// with a silently *present* one is a breach.
    ///
    /// # Errors
    ///
    /// Returns [`LaunchError::InvalidKey`] for a name that is not usable as an
    /// environment variable, and [`LaunchError::Guard`] for one the dynamic
    /// loader or a language runtime interprets.
    pub fn with_secrets(
        mut self,
        guard: EnvGuard,
        secrets: impl IntoIterator<Item = (String, SecretString)>,
    ) -> Result<Self, LaunchError> {
        for (key, value) in secrets {
            keyname::validate(&key)
                .map_err(|source| LaunchError::InvalidKey { key: key.clone(), source })?;
            guard.check(&key)?;
            self.env.push((key, value));
        }
        Ok(self)
    }

    /// The program to run, as the user wrote it.
    pub fn program(&self) -> &OsStr {
        // `new` rejects an empty argv, so this cannot be absent.
        self.argv.first().map_or(OsStr::new(""), OsString::as_os_str)
    }

    /// The program's arguments, excluding the program itself.
    pub fn args(&self) -> &[OsString] {
        self.argv.get(1..).unwrap_or(&[])
    }

    /// The names of the variables that will be added to the environment.
    ///
    /// Names are plaintext by design and safe to show; values are not exposed.
    pub fn env_names(&self) -> impl Iterator<Item = &str> {
        self.env.iter().map(|(key, _)| key.as_str())
    }

    /// Applies the environment to a command.
    ///
    /// The single point at which a secret is exposed, and the last thing that
    /// happens before the process API takes ownership of it.
    fn apply_env(&self, command: &mut std::process::Command) {
        for (key, value) in &self.env {
            command.env(key, value.expose_secret());
        }
    }
}

/// Flushes both standard streams.
///
/// On Unix the process is about to be replaced, so anything still sitting in a
/// userspace buffer would be lost outright. On Windows the child is about to
/// write to the same console, so an unflushed buffer would appear after the
/// child's output rather than before it.
fn flush_streams() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
}

/// Becomes the child. **Never returns on success.**
///
/// On Unix that is literally true: `execvp` replaces the process image, so the
/// only way out is an error. On Windows there is no `exec`, so this waits for
/// the child and then exits with its status -- which makes the two platforms
/// indistinguishable to a caller, and is why the success type is
/// [`Infallible`].
///
/// The alternative -- returning the status for the caller to propagate -- looks
/// tidier and is not: the caller would have to reproduce the exit status
/// exactly through its own error type, and any mapping that cannot represent
/// 126, 127 or a status above 255 silently changes what a script sees.
///
/// # Errors
///
/// See [`LaunchError`]. The three cases a caller is expected to distinguish are
/// [`LaunchError::NotFound`] (exit 127), [`LaunchError::PermissionDenied`] and
/// [`LaunchError::NoExecFormat`] (both exit 126).
pub fn run(spec: &LaunchSpec) -> Result<Infallible, LaunchError> {
    flush_streams();
    run_platform(spec)
}

#[cfg(unix)]
fn run_platform(spec: &LaunchSpec) -> Result<Infallible, LaunchError> {
    use std::os::unix::process::CommandExt as _;

    let mut command = std::process::Command::new(spec.program());
    command.args(spec.args());
    spec.apply_env(&mut command);

    // SAFETY: the closure runs in the forked child, between `fork` and `exec`,
    // where only async-signal-safe calls are permitted. It calls exactly
    // `signal(2)` and `sigprocmask(2)`, both of which are on the POSIX
    // async-signal-safe list, and it allocates nothing, locks nothing and
    // formats nothing.
    //
    // The `io::Error` it can return is constructed from `errno` by
    // `last_os_error`, which is a read of thread-local storage; std itself
    // relies on that being safe in the same position.
    unsafe {
        command.pre_exec(crate::signal::restore_default_dispositions);
    }

    // `exec` only returns on failure.
    let failure = command.exec();
    Err(LaunchError::from_io(spec.program(), failure))
}

#[cfg(windows)]
fn run_platform(spec: &LaunchSpec) -> Result<Infallible, LaunchError> {
    use std::os::windows::io::AsRawHandle as _;
    use std::os::windows::process::CommandExt as _;

    let program = spec.program();

    // PATHEXT-aware, so `npm` resolves to `npm.cmd`. std's own resolution only
    // ever appends `.exe`, which is why `Command::new("npm")` fails outright.
    let resolved = which::which(program)
        .map_err(|_| LaunchError::NotFound { program: program.to_string_lossy().into_owned() })?;

    let mut command = if is_batch_target(resolved.as_os_str()) {
        let line = batch_command_line(&resolved, spec.args())?;
        let mut command = std::process::Command::new(comspec());
        // Raw, because the string is already escaped for cmd.exe's parser and
        // re-quoting it for the argv parser would break both.
        command.raw_arg(&line);
        command
    } else {
        let mut command = std::process::Command::new(&resolved);
        command.args(spec.args());
        command
    };
    spec.apply_env(&mut command);

    // Installed before the spawn so a Ctrl-C during startup is already handled.
    crate::winjob::install_console_ctrl_handler()
        .map_err(|source| LaunchError::Io { program: "prk".to_owned(), source })?;

    let job = crate::winjob::Job::create_kill_on_close()
        .map_err(|source| LaunchError::Io { program: "prk".to_owned(), source })?;

    let mut child =
        command.spawn().map_err(|source| LaunchError::from_io(resolved.as_os_str(), source))?;

    // There is a window between spawn and assignment in which the child could
    // create a grandchild outside the job. Closing it needs CREATE_SUSPENDED
    // and a handle to the initial thread, which std does not expose. The
    // exposure is microseconds at process start, before the child's own `main`
    // has run.
    // SAFETY: `child` owns the process handle and is alive across the call, so
    // the handle is live and carries the access rights a `spawn` produces.
    let assigned = unsafe { job.assign(child.as_raw_handle()) };
    if let Err(source) = assigned {
        let _ = child.kill();
        return Err(LaunchError::Io { program: "prk".to_owned(), source });
    }

    let status =
        child.wait().map_err(|source| LaunchError::from_io(resolved.as_os_str(), source))?;

    // Dropping `job` closes the last handle, which terminates anything the
    // child left behind. That is the whole point of KILL_ON_JOB_CLOSE.
    drop(job);
    flush_streams();

    // Exiting here rather than returning the status is what makes this platform
    // behave like the Unix one. `clippy::exit` is denied workspace-wide so that
    // destructors run and a token buffer is zeroized on the way out -- and this
    // is the one place that reasoning does not apply, because the Unix path
    // reaches the same point by calling `execvp`, which does not run
    // destructors either. Behaving differently on Windows would be the bug.
    //
    // A Windows exit status is a full u32 and can exceed 255, so it is passed
    // through as the OS reported it rather than narrowed.
    #[allow(
        clippy::exit,
        reason = "the Unix path reaches this point via execvp, which likewise never returns"
    )]
    std::process::exit(crate::signal::child_exit_status(status.code(), None));
}

/// The `cmd.exe` to run a batch shim with.
///
/// Deliberately not `%COMSPEC%`. That variable is writable by anything in the
/// process's environment, and this is a secrets manager launching a child with
/// secrets in its environment; taking the interpreter from an attacker-writable
/// variable would hand over the whole point of the guard in [`crate::guard`].
#[cfg(windows)]
fn comspec() -> OsString {
    std::env::var_os("SystemRoot").map_or_else(
        || OsString::from(r"C:\Windows\System32\cmd.exe"),
        |mut path| {
            path.push(r"\System32\cmd.exe");
            path
        },
    )
}

/// Builds the raw `cmd.exe` argument string for a batch shim.
#[cfg(windows)]
fn batch_command_line(script: &Path, args: &[OsString]) -> Result<OsString, LaunchError> {
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

    let script: Vec<u16> = script.as_os_str().encode_wide().collect();
    let args: Vec<Vec<u16>> = args.iter().map(|arg| arg.encode_wide().collect()).collect();
    let line = crate::cmdline::batch_command_line(&script, &args)?;
    Ok(OsString::from_wide(&line))
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn an_empty_argv_is_refused_rather_than_producing_an_empty_program() {
        assert!(matches!(LaunchSpec::new(Vec::new()), Err(LaunchError::NoProgram)));
    }

    #[test]
    fn argv_is_split_into_a_program_and_its_arguments() {
        let spec =
            LaunchSpec::new(vec!["npm".into(), "test".into(), "--json".into()]).expect("non-empty");
        assert_eq!(spec.program(), OsStr::new("npm"));
        assert_eq!(spec.args(), [OsString::from("test"), OsString::from("--json")]);
    }

    #[test]
    fn a_program_with_no_arguments_has_an_empty_argument_slice() {
        let spec = LaunchSpec::new(vec!["true".into()]).expect("non-empty");
        assert!(spec.args().is_empty());
    }

    #[test]
    fn secrets_reach_the_environment_by_name() {
        let spec = LaunchSpec::new(vec!["true".into()])
            .expect("non-empty")
            .with_secrets(
                EnvGuard::strict(),
                [
                    ("DATABASE_URL".to_owned(), SecretString::from("postgres://x")),
                    ("API_KEY".to_owned(), SecretString::from("k")),
                ],
            )
            .expect("both names are safe");

        assert_eq!(spec.env_names().collect::<Vec<_>>(), ["DATABASE_URL", "API_KEY"]);
    }

    #[test]
    fn a_loader_controlled_name_fails_the_whole_launch() {
        let err = LaunchSpec::new(vec!["true".into()])
            .expect("non-empty")
            .with_secrets(
                EnvGuard::strict(),
                [
                    ("SAFE".to_owned(), SecretString::from("a")),
                    ("LD_PRELOAD".to_owned(), SecretString::from("/tmp/evil.so")),
                ],
            )
            .expect_err("LD_PRELOAD must be refused");

        assert!(matches!(err, LaunchError::Guard(_)));
        assert!(err.to_string().contains("LD_PRELOAD"));
    }

    #[test]
    fn the_opt_in_lets_a_loader_controlled_name_through() {
        let spec = LaunchSpec::new(vec!["true".into()])
            .expect("non-empty")
            .with_secrets(
                EnvGuard::permissive(),
                [("LD_PRELOAD".to_owned(), SecretString::from("/tmp/x.so"))],
            )
            .expect("permissive guard allows it");
        assert_eq!(spec.env_names().collect::<Vec<_>>(), ["LD_PRELOAD"]);
    }

    #[test]
    fn a_name_a_shell_could_not_use_is_refused_before_the_guard_sees_it() {
        let err = LaunchSpec::new(vec!["true".into()])
            .expect("non-empty")
            .with_secrets(
                EnvGuard::permissive(),
                [("NOT A NAME".to_owned(), SecretString::from("v"))],
            )
            .expect_err("an invalid name must be refused even when the guard is permissive");
        assert!(matches!(err, LaunchError::InvalidKey { .. }));
    }

    #[test]
    fn the_debug_rendering_never_contains_a_value() {
        let spec = LaunchSpec::new(vec!["true".into()])
            .expect("non-empty")
            .with_secrets(EnvGuard::strict(), [("TOKEN".to_owned(), SecretString::from("hunter2"))])
            .expect("safe name");

        let rendered = format!("{spec:?}");
        assert!(rendered.contains("TOKEN"), "the key is plaintext and should be visible");
        assert!(!rendered.contains("hunter2"), "a value leaked through Debug: {rendered}");
    }

    #[cfg(windows)]
    #[test]
    fn the_interpreter_comes_from_the_system_directory_not_comspec() {
        let resolved = comspec().to_string_lossy().to_lowercase();
        assert!(resolved.ends_with(r"\system32\cmd.exe"), "unexpected interpreter: {resolved}");
    }
}
