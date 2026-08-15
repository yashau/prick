//! Integration tests for starting a real child process.
//!
//! These are the only verification this crate's `unsafe` gets. miri covers
//! `prick-core` and cannot execute a process, a signal handler or an FFI call,
//! so everything interesting here is out of its reach by construction. That is
//! a reason for these tests to be thorough, not a reason to claim coverage
//! elsewhere.
//!
//! Every test drives the `prick-exec-child` fixture as a subprocess. On Unix
//! `prick_exec::run` replaces the calling process, so a test that called it
//! directly would have no harness left to assert with.

use std::ffi::OsStr;
use std::process::{Command, Output};

/// The fixture binary, located by cargo rather than guessed at.
const CHILD: &str = env!("CARGO_BIN_EXE_prick-exec-child");

/// Runs the fixture and captures what it produced.
fn fixture<I, S>(args: I) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new(CHILD).args(args).output().expect("the fixture binary must be runnable")
}

/// Splits `--print-argv` output back into arguments.
fn split_argv(stdout: &[u8]) -> Vec<Vec<u8>> {
    if stdout.is_empty() {
        return Vec::new();
    }
    stdout.split(|byte| *byte == 0).map(<[u8]>::to_vec).collect()
}

#[test]
fn an_exit_code_reaches_the_caller_unchanged() {
    for code in [0, 1, 2, 42] {
        let out = fixture(["--", CHILD, "--exit-code", &code.to_string()]);
        assert_eq!(out.status.code(), Some(code), "exit code {code} was not preserved");
    }
}

#[test]
fn a_missing_program_exits_127_like_a_shell() {
    let out = fixture(["--", "prick-no-such-program-anywhere"]);
    assert_eq!(out.status.code(), Some(127));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("prick-no-such-program-anywhere"), "unhelpful message: {stderr}");
}

#[test]
fn argv_survives_the_launch_exactly() {
    // Nothing is ever joined into a command line on Unix, and the Windows
    // batch path is escaped to reconstruct these byte for byte. Both are
    // asserted by the same test.
    let arguments = [
        "plain",
        "with space",
        "quote\"inside",
        "amp&ersand",
        "pipe|char",
        "back\\slash",
        "trailing\\",
        "dollar$sign",
        "backtick`char",
        "paren(s)",
        "semi;colon",
        "star*",
        "-leading-dash",
        "--flag=value",
    ];

    let mut args: Vec<&str> = vec!["--", CHILD, "--print-argv"];
    args.extend_from_slice(&arguments);
    let out = fixture(args);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let received = split_argv(&out.stdout);
    let expected: Vec<Vec<u8>> = arguments.iter().map(|a| a.as_bytes().to_vec()).collect();
    assert_eq!(received, expected);
}

#[test]
fn an_empty_argument_is_not_dropped() {
    let out = fixture(["--", CHILD, "--print-argv", "before", "", "after"]);
    assert!(out.status.success());
    let received = split_argv(&out.stdout);
    assert_eq!(received.len(), 3, "an empty argument disappeared: {received:?}");
    assert!(received[1].is_empty());
}

#[test]
fn a_secret_reaches_the_child_environment() {
    let out = fixture([
        "--set",
        "PRICK_TEST_SECRET=s3cr3t-value",
        "--",
        CHILD,
        "--print-env",
        "PRICK_TEST_SECRET",
    ]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "s3cr3t-value");
}

#[test]
fn a_loader_controlled_secret_stops_the_launch_before_it_starts() {
    let out = fixture(["--set", "LD_PRELOAD=/tmp/evil.so", "--", CHILD, "--exit-code", "0"]);

    assert_ne!(out.status.code(), Some(0), "the child must not have run at all");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("LD_PRELOAD"), "stderr: {stderr}");
    assert!(stderr.contains("--allow-unsafe-env"), "stderr: {stderr}");
}

#[test]
fn the_opt_in_lets_a_loader_controlled_secret_through() {
    let out = fixture([
        "--allow-unsafe-env",
        "--set",
        "NODE_OPTIONS=--max-old-space-size=100",
        "--",
        CHILD,
        "--print-env",
        "NODE_OPTIONS",
    ]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "--max-old-space-size=100");
}

#[test]
fn a_refused_launch_never_prints_the_value_it_refused() {
    let out =
        fixture(["--set", "LD_PRELOAD=hunter2-would-be-a-leak", "--", CHILD, "--exit-code", "0"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("hunter2-would-be-a-leak"),
        "the refusal message leaked the value: {stderr}"
    );
}

#[test]
fn a_secret_never_reaches_a_variable_it_was_not_named_for() {
    let out = fixture([
        "--set",
        "PRICK_TEST_SECRET=value",
        "--",
        CHILD,
        "--print-env",
        "PRICK_TEST_OTHER",
    ]);
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}
