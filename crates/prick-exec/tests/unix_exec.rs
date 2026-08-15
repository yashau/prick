//! Unix-only behaviour: signal dispositions, signal exit statuses, and the
//! fidelity that comes from replacing the process rather than supervising it.
//!
//! The first two tests are the regression tests for the `SIGPIPE` bug described
//! in `prick_exec::signal`. They are named for the symptom, not the mechanism,
//! because the symptom is what someone will search for.

#![cfg(unix)]

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::process::ExitStatusExt as _;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

// Signal numbers, named so the assertions read as intent rather than arithmetic.
const SIGINT: i32 = 2;
const SIGPIPE: i32 = 13;
const SIGTERM: i32 = 15;

/// Assert a process died from `signal`.
///
/// NOT `status.code() == Some(128 + signal)`. `128 + n` is the encoding a SHELL
/// reports in `$?`; `ExitStatus::code()` returns `None` for a signal death and
/// exposes the number through `signal()` instead. Asserting the shell's
/// convention against the API is how these three tests were originally written,
/// and they could not fail on the Windows dev machine because the whole module
/// is `#![cfg(unix)]` -- so the mistake survived until CI ran them on Linux.
///
/// This matters beyond the assertion: because `run()` execs rather than
/// supervises, the fixture process IS the child, so the signal that kills the
/// child kills the fixture. Observing the signal directly is what proves that.
#[track_caller]
fn assert_killed_by(status: ExitStatus, signal: i32, why: &str) {
    assert_eq!(status.signal(), Some(signal), "{why}");
    assert_eq!(
        status.code(),
        None,
        "a signal-killed process has no exit code of its own; {why}"
    );
}

/// The fixture binary, located by cargo rather than guessed at.
const CHILD: &str = env!("CARGO_BIN_EXE_prick-exec-child");

fn fixture<I, S>(args: I) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new(CHILD).args(args).output().expect("the fixture binary must be runnable")
}

/// Runs a shell snippet, failing the test rather than hanging if it does not
/// finish inside `limit`.
fn run_with_deadline(script: &str, limit: Duration) -> bool {
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("/bin/sh must be runnable");

    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait().expect("waiting on the child must succeed") {
            Some(_) => return true,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[test]
fn sigpipe_is_restored_to_its_default_disposition_before_exec() {
    // The Rust runtime sets SIGPIPE to SIG_IGN before main. Without the reset
    // in `pre_exec` the child inherits that, survives its own SIGPIPE, and
    // falls through to the `echo`.
    //
    // Deterministic, unlike the pipeline below: it does not depend on timing,
    // on a reader closing, or on anything being scheduled.
    let out = fixture(["--", "/bin/sh", "-c", "kill -PIPE $$; echo survived"]);

    assert!(
        out.stdout.is_empty(),
        "the child survived SIGPIPE, so its disposition was still SIG_IGN: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_killed_by(out.status, SIGPIPE, "the child must have died from SIGPIPE");
}

#[test]
fn yes_piped_into_head_terminates_rather_than_hanging() {
    // The named regression test. With SIGPIPE ignored, the producing side of
    // the pipe never learns the reader is gone: the write fails with EPIPE, the
    // shell loop ignores the failure, and the pipeline runs forever.
    //
    // A shell loop rather than `yes(1)`, because GNU coreutils checks its write
    // return value and would exit on EPIPE regardless, hiding the bug.
    let script = format!("{CHILD} -- /bin/sh -c 'while :; do echo x; done' | head -1");

    assert!(
        run_with_deadline(&script, Duration::from_secs(10)),
        "`prk run -- yes | head -1` hung: SIGPIPE was not reset to SIG_DFL before exec"
    );
}

#[test]
fn a_child_killed_by_sigterm_is_reported_as_a_signal_death() {
    let out = fixture(["--", "/bin/sh", "-c", "kill -TERM $$"]);
    assert_killed_by(out.status, SIGTERM, "SIGTERM must reach the exec'd process");
}

#[test]
fn a_child_killed_by_sigint_is_reported_as_a_signal_death() {
    let out = fixture(["--", "/bin/sh", "-c", "kill -INT $$"]);
    assert_killed_by(out.status, SIGINT, "Ctrl+C must reach the exec'd process");
}

#[test]
fn an_exit_code_is_the_childs_own_and_not_a_translation_of_it() {
    for code in [0, 1, 2, 42, 255] {
        let out = fixture(["--", "/bin/sh", "-c", &format!("exit {code}")]);
        assert_eq!(out.status.code(), Some(code), "exit code {code} was not preserved");
    }
}

#[test]
fn the_process_is_replaced_rather_than_forked() {
    // If `prk run` spawned and forwarded, the child's parent would be the
    // fixture. Because it execs, the fixture is gone: the child keeps its pid
    // and its parent is whatever started the fixture, which is this test.
    //
    // This is what makes job control correct. There is no intermediate process
    // to get SIGTSTP and SIGCONT wrong, because there is no intermediate
    // process.
    let out = fixture(["--", "/bin/sh", "-c", "echo $PPID"]);
    let reported: u32 =
        String::from_utf8_lossy(&out.stdout).trim().parse().expect("a numeric parent pid");
    assert_eq!(reported, std::process::id(), "the fixture was still in the process tree");
}

#[test]
fn a_non_utf8_argument_survives_byte_for_byte() {
    // Argv is a vector of byte strings all the way to execvp, so an argument
    // that is not valid UTF-8 is carried rather than replaced.
    let invalid = OsStr::from_bytes(b"caf\xe9-latin1");
    let out = fixture([OsStr::new("--"), OsStr::new(CHILD), OsStr::new("--print-argv"), invalid]);

    assert!(out.status.success());
    assert_eq!(out.stdout, b"caf\xe9-latin1", "the argument was mangled on the way through");
}

#[test]
fn an_unexecutable_file_exits_126() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("not-executable");
    std::fs::write(&path, b"#!/bin/sh\necho hi\n").expect("write");

    let out = fixture([OsStr::new("--"), path.as_os_str()]);
    assert_eq!(out.status.code(), Some(126), "stderr: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_secret_reaches_the_child_and_nothing_else_does() {
    let out = fixture([
        "--set",
        "PRICK_TEST_SECRET=through-exec",
        "--",
        "/bin/sh",
        "-c",
        "printf %s \"$PRICK_TEST_SECRET\"",
    ]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.stdout, b"through-exec");
}
