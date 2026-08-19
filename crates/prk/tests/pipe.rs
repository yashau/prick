//! What happens when the thing reading `prk` stops reading.
//!
//! `prk completions bash | head -2` is a shell idiom, and until this test
//! existed it was an unhandled panic: `println!` panics when the write fails,
//! and the completion script is far larger than a pipe buffer, so the reader is
//! always gone before the last byte is written.
//!
//! Under the `dist` profile -- `panic = "abort"` -- that panic became a
//! `__fastfail` exiting `0xC0000409`, whose low byte is **9**: the number the
//! taxonomy gives to `UNREPRESENTABLE_OUTPUT`. A crash is bad; a crash wearing
//! another failure's number sends whoever debugs it to the wrong page of the
//! documentation.
//!
//! These tests drive the real binary, because that is the only place the
//! behaviour exists: it is a property of a process whose stdout is a pipe, and
//! no unit test can hold one that closes early.

use std::io::Read as _;
use std::process::{Command, Stdio};

/// Runs `prk` with a reader that gives up after the first read.
///
/// Returns the exit code and stderr. Dropping the pipe is what makes the child
/// see a closed reader -- `head -2` differs only in doing it on purpose.
fn hang_up_on(args: &[&str]) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prk"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary under test must be runnable");

    {
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let mut first = [0_u8; 64];
        let _ = stdout.read(&mut first);
        // The reader goes away here, part way through a script that is well
        // over a pipe buffer in size.
    }

    let mut stderr = String::new();
    if let Some(mut stream) = child.stderr.take() {
        let _ = stream.read_to_string(&mut stderr);
    }

    let status = child.wait().expect("the child must be reapable");
    (status.code(), stderr)
}

#[test]
fn a_reader_that_hangs_up_does_not_crash_the_process() {
    let (code, stderr) = hang_up_on(&["completions", "bash"]);

    assert!(!stderr.contains("panicked"), "the process panicked:\n{stderr}");
    assert!(!stderr.contains("stack backtrace"), "the process panicked:\n{stderr}");
    // Not 9 in particular: that is `UNREPRESENTABLE_OUTPUT`, and a completion
    // script that a reader stopped reading is not an unencodable value.
    assert_ne!(code, Some(9), "a broken pipe reported itself as unrepresentable output");
    assert_ne!(code, Some(101), "a broken pipe reported itself as a panic");
}

#[test]
fn a_reader_that_hangs_up_on_ordinary_output_is_a_success() {
    let (code, stderr) = hang_up_on(&["completions", "bash"]);

    // `head` got what it asked for. There is nothing to report, and the stream
    // that would carry the report is the one that closed.
    assert_eq!(code, Some(0), "stderr said:\n{stderr}");
    assert!(stderr.is_empty(), "a quiet exit still said something:\n{stderr}");
}
