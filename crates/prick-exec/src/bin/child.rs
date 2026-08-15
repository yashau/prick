//! A test fixture: the smallest possible caller of [`prick_exec::run`].
//!
//! # Why a separate binary
//!
//! On Unix `prick_exec::run` **replaces the calling process**. A test harness
//! cannot call it directly and then go on to assert anything, because there is
//! no longer a harness. So the assertions live in `tests/`, and this is the
//! process that gets replaced.
//!
//! It is a real `[[bin]]` target rather than an example so that cargo exports
//! `CARGO_BIN_EXE_prick-exec-child` to the integration tests. Nothing guesses
//! at a path under `target/`.
//!
//! # Usage
//!
//! ```text
//! prick-exec-child [--set KEY=VALUE]... [--allow-unsafe-env] [--] <program> [args...]
//! prick-exec-child --print-argv [args...]
//! prick-exec-child --print-env NAME
//! prick-exec-child --exit-code N
//! ```
//!
//! The three reporting modes exist so the fixture can be both the launcher and
//! the launched: a test runs `prick-exec-child -- prick-exec-child
//! --print-argv ...` and compares what came out the far side with what went in.
//!
//! Output goes through `io::Write` rather than `println!`: `print_stdout` and
//! `print_stderr` are denied workspace-wide, and a test fixture does not get an
//! exception.

use std::ffi::OsString;
use std::io::Write as _;
use std::process::ExitCode;

use secrecy::SecretString;

use prick_exec::{EnvGuard, LaunchSpec};

/// Separates arguments in `--print-argv` output.
///
/// A NUL, because it is the one byte an argument provably cannot contain: the
/// process APIs on both platforms use it as their own terminator.
const SEPARATOR: u8 = 0;

fn main() -> ExitCode {
    match dispatch() {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(message) => {
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(stderr, "prick-exec-child: {message}");
            ExitCode::from(2)
        }
    }
}

fn dispatch() -> Result<i32, String> {
    let mut secrets: Vec<(String, SecretString)> = Vec::new();
    let mut guard = EnvGuard::strict();
    let mut argv: Vec<OsString> = Vec::new();

    let mut remaining = std::env::args_os().skip(1);
    while let Some(arg) = remaining.next() {
        match arg.to_str() {
            Some("--set") => {
                let pair = remaining.next().ok_or("--set needs KEY=VALUE")?;
                let pair = pair.to_string_lossy().into_owned();
                let (key, value) = pair.split_once('=').ok_or("--set needs KEY=VALUE")?;
                secrets.push((key.to_owned(), SecretString::from(value)));
            }
            Some("--allow-unsafe-env") => guard = EnvGuard::permissive(),
            Some("--print-argv") => return print_argv(remaining),
            Some("--print-env") => {
                let name = remaining.next().ok_or("--print-env needs NAME")?;
                return print_env(&name);
            }
            Some("--exit-code") => {
                let code = remaining.next().ok_or("--exit-code needs N")?;
                return code.to_string_lossy().parse::<i32>().map_err(|err| err.to_string());
            }
            Some("--") => {
                argv.extend(remaining);
                break;
            }
            _ => {
                argv.push(arg);
                argv.extend(remaining);
                break;
            }
        }
    }

    let spec = LaunchSpec::new(argv)
        .and_then(|spec| spec.with_secrets(guard, secrets))
        .map_err(|err| err.to_string())?;

    // `run` never returns on success: on Unix it becomes the child, on Windows
    // it exits with the child's status. Only the failure arm is reachable, and
    // the compiler knows it.
    match prick_exec::run(&spec) {
        Err(err) => {
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(stderr, "prick-exec-child: {err}");
            Ok(err.exit_code())
        }
    }
}

/// Writes every remaining argument to stdout, NUL-separated.
///
/// Bytes are written as the operating system supplied them wherever that is
/// possible, so a non-UTF-8 argument is reported as a non-UTF-8 argument rather
/// than as a row of replacement characters.
fn print_argv(args: impl Iterator<Item = OsString>) -> Result<i32, String> {
    let mut stdout = std::io::stdout().lock();
    for (index, arg) in args.enumerate() {
        if index > 0 {
            stdout.write_all(&[SEPARATOR]).map_err(|err| err.to_string())?;
        }
        stdout.write_all(&os_bytes(&arg)).map_err(|err| err.to_string())?;
    }
    stdout.flush().map_err(|err| err.to_string())?;
    Ok(0)
}

/// Writes one environment variable's value to stdout.
fn print_env(name: &OsString) -> Result<i32, String> {
    let value = std::env::var_os(name).unwrap_or_default();
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&os_bytes(&value)).map_err(|err| err.to_string())?;
    stdout.flush().map_err(|err| err.to_string())?;
    Ok(0)
}

#[cfg(unix)]
fn os_bytes(value: &OsString) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt as _;
    value.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn os_bytes(value: &OsString) -> Vec<u8> {
    // Windows arguments are UTF-16, and there is no lossless byte form. The
    // tests that care about byte fidelity are the Unix ones.
    value.to_string_lossy().into_owned().into_bytes()
}
