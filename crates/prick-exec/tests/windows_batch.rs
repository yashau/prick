//! Windows-only behaviour: the `.cmd` shim path, exercised against the real
//! `cmd.exe`.
//!
//! [`prick_exec::cmdline`]'s unit tests assert what the escaper produces.
//! These assert what `cmd.exe` does with it, which is the only thing that
//! actually matters -- the escaping exists to survive a parser nobody has a
//! specification for.
//!
//! The fixture is a shim in the shape of the real ones: `npm.cmd`, `pnpm.cmd`
//! and `tsc.cmd` are all `@echo off` followed by a program invoked with `%*`,
//! and `%*` is exactly where CVE-2024-24576 lived.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The fixture binary, located by cargo rather than guessed at.
const CHILD: &str = env!("CARGO_BIN_EXE_prick-exec-child");

/// Writes a `.cmd` shim that forwards its arguments the way `npm.cmd` does.
fn write_shim(dir: &Path, stem: &str) -> PathBuf {
    let path = dir.join(format!("{stem}.cmd"));
    // CRLF: cmd.exe's parser genuinely misbehaves on LF-terminated batch files,
    // which is also why .gitattributes keeps .cmd out of the LF rule.
    let body = format!("@echo off\r\n\"{CHILD}\" --print-argv %*\r\n");
    std::fs::write(&path, body).expect("writing the shim must succeed");
    path
}

/// Runs the fixture with `dir` prepended to `PATH`.
fn fixture_with_path(dir: &Path, args: &[&str]) -> Output {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut search = std::ffi::OsString::from(dir);
    search.push(";");
    search.push(existing);

    Command::new(CHILD)
        .args(args)
        .env("PATH", search)
        .output()
        .expect("the fixture binary must be runnable")
}

/// Splits `--print-argv` output back into arguments.
fn split_argv(stdout: &[u8]) -> Vec<String> {
    if stdout.is_empty() {
        return Vec::new();
    }
    stdout.split(|byte| *byte == 0).map(|part| String::from_utf8_lossy(part).into_owned()).collect()
}

#[test]
fn a_shim_is_found_without_naming_its_extension() {
    // `Command::new("npm")` fails on Windows because std's resolution only ever
    // appends `.exe`. This is the whole reason `which` is a dependency.
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickshim");

    let out = fixture_with_path(dir.path(), &["--", "prickshim", "hello"]);

    assert!(
        out.status.success(),
        "resolving a .cmd shim failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(split_argv(&out.stdout), ["hello"]);
}

#[test]
fn std_alone_cannot_find_the_shim_which_is_why_this_module_exists() {
    // Pins the premise. If this ever starts succeeding, std learned PATHEXT
    // resolution and the `which` dependency can be revisited.
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickshim2");

    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut search = std::ffi::OsString::from(dir.path());
    search.push(";");
    search.push(existing);

    let direct = Command::new("prickshim2").env("PATH", search).output();
    assert!(direct.is_err(), "std resolved a .cmd without help; the workaround may be obsolete");
}

#[test]
fn adversarial_arguments_reach_the_shim_unchanged() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickargs");

    // Every one of these is a documented way to break out of a cmd.exe command
    // line. They must arrive as data.
    let adversarial = [
        r#"a"b"#,
        "a&b",
        "%PATH%",
        "!DELAYED!",
        "a b",
        "a^b",
        "a|b",
        "a>b",
        "a<b",
        "a&&echo pwned",
        "(paren)",
        r"back\slash",
        "100%",
        "%%",
        "plain",
    ];

    let mut args: Vec<&str> = vec!["--", "prickargs"];
    args.extend_from_slice(&adversarial);
    let out = fixture_with_path(dir.path(), &args);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let received = split_argv(&out.stdout);
    assert_eq!(received, adversarial, "cmd.exe altered at least one argument");
}

#[test]
fn a_variable_reference_arrives_as_text_rather_than_its_value() {
    // The sharpest single case: %PATH% is guaranteed to be set, so an expansion
    // would be unmistakable rather than an empty string that looks like a pass.
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickvar");

    let out = fixture_with_path(dir.path(), &["--", "prickvar", "%PATH%", "%USERPROFILE%"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(split_argv(&out.stdout), ["%PATH%", "%USERPROFILE%"]);
}

#[test]
fn a_separator_does_not_become_a_second_command() {
    // CVE-2024-24576 in one assertion: if `&` escaped the argument, `echo`
    // would run and its output would appear in the captured stream.
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickinj");

    let out = fixture_with_path(dir.path(), &["--", "prickinj", "x&echo INJECTED"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains("INJECTED\r\n"), "a second command ran: {stdout}");
    assert_eq!(split_argv(&out.stdout), ["x&echo INJECTED"]);
}

#[test]
fn an_empty_argument_is_not_dropped_by_cmd() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickempty");

    let out = fixture_with_path(dir.path(), &["--", "prickempty", "before", "", "after"]);

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(split_argv(&out.stdout), ["before", "", "after"]);
}

#[test]
fn an_argument_containing_a_line_break_is_refused_rather_than_truncated() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    write_shim(dir.path(), "prickbreak");

    let out = fixture_with_path(dir.path(), &["--", "prickbreak", "first\nsecond"]);

    assert_ne!(out.status.code(), Some(0), "an unrepresentable argument must not be truncated");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("line break"), "stderr: {stderr}");
}

#[test]
fn a_shim_exit_code_reaches_the_caller() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("prickexit.cmd");
    std::fs::write(&path, "@echo off\r\nexit /b 42\r\n").expect("write");

    let out = fixture_with_path(dir.path(), &["--", "prickexit"]);
    assert_eq!(out.status.code(), Some(42));
}

#[test]
fn a_secret_reaches_a_shim_through_the_environment() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("prickenv.cmd");
    let body = format!("@echo off\r\n\"{CHILD}\" --print-env PRICK_TEST_SECRET\r\n");
    std::fs::write(&path, body).expect("write");

    let out = fixture_with_path(
        dir.path(),
        &["--set", "PRICK_TEST_SECRET=through-cmd", "--", "prickenv"],
    );

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), "through-cmd");
}

#[test]
fn a_real_executable_does_not_go_through_cmd_at_all() {
    // The batch path is the exception, not the rule. An .exe is launched
    // directly, so nothing quotes or re-parses its arguments.
    let out = Command::new(CHILD)
        .args(["--", CHILD, "--print-argv", "a&b", "%PATH%", r#"a"b"#])
        .output()
        .expect("the fixture binary must be runnable");

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(split_argv(&out.stdout), ["a&b", "%PATH%", r#"a"b"#]);
}
