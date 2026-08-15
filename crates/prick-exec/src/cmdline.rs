//! Building a `cmd.exe` command line for a batch shim.
//!
//! # Why this module has to exist at all
//!
//! `npm`, `pnpm`, `npx`, `yarn` and `tsc` are `.cmd` files on Windows, not
//! executables. Two separate things then go wrong:
//!
//! 1. `std::process::Command`'s program resolution only ever appends `.exe`, so
//!    `Command::new("npm")` does not find `npm.cmd` and fails with "not found".
//!    [`crate::launch`] resolves through `which`, which honours `PATHEXT`.
//! 2. A batch file is not executed by the loader; `cmd.exe` interprets it. That
//!    means the arguments are parsed **twice** -- once when `cmd.exe` reads the
//!    command line we hand it, and again inside the script when `%*` is
//!    substituted into a line and that line is re-parsed. Getting this wrong is
//!    CVE-2024-24576: an argument containing `&` becomes a second command.
//!
//! # The algorithm
//!
//! This mirrors the escaping the Rust standard library adopted for the
//! CVE-2024-24576 fix, which is the only construction that is known to survive
//! both parses. Reimplementing it here rather than deferring to std is what
//! lets `prk run -- npm test` work: std applies it only when *it* resolved the
//! program to a `.bat`/`.cmd`, and it never resolves `npm` to `npm.cmd` at all.
//!
//! The pieces, each of which is load-bearing:
//!
//! | Piece | Defeats |
//! |---|---|
//! | Wrap the whole command in one outer quote pair | `cmd.exe`'s argument splitting |
//! | `/s` | The conditional "should I strip the outer quotes" rule, which is genuinely hard to predict |
//! | `/d` | An `AutoRun` registry value running before the command |
//! | `/v:OFF` | `!DELAYED!` expansion |
//! | `/e:ON` | Needed for the `%` construction below to evaluate |
//! | Quote any argument that is not purely alphanumeric | `& \| < > ( ) ^` and whitespace splitting |
//! | Double an inner `"` rather than backslash-escaping it | A `\"` would end the quoted region as far as `cmd.exe` is concerned, exposing everything after it |
//! | Replace `%` with `%%cd:~,%` | `%PATH%` expanding to its value |
//!
//! The `%` construction deserves a sentence. `%cd:~,%` is a substring of the
//! built-in `cd` variable with an empty start and end index, so it expands to
//! nothing. Splicing that no-op in front of every `%` leaves the text unchanged
//! but leaves `cmd.exe` with no `%NAME%` pair to match, so nothing expands.
//!
//! # What cannot be escaped
//!
//! `\r` and `\n` terminate a `cmd.exe` command line; there is no encoding that
//! carries them through. They are rejected rather than silently dropped --
//! silently dropping half an argument is how a `prk run` invocation quietly
//! does something other than what it was asked to.
//!
//! # Portability of this module
//!
//! Everything here operates on UTF-16 code units and is compiled on every
//! platform, so the adversarial-argument tests run on Linux and macOS CI too.
//! Only [`crate::launch`] restricts its use to Windows.

use std::fmt;

/// Switches passed to `cmd.exe` ahead of the command itself.
///
/// See the module documentation for what each one defeats. The order matches
/// what `cmd.exe` documents.
pub const CMD_SWITCHES: &str = "/d /e:ON /v:OFF /s /c";

/// An argument that cannot be carried through `cmd.exe` at all.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum CmdLineError {
    /// The argument contained a carriage return or line feed.
    ///
    /// Both terminate a `cmd.exe` command line. There is no quoting or escape
    /// that survives, so the argument is refused rather than truncated.
    #[error(
        "argument {index} cannot be passed to a .cmd or .bat file: it contains a line break, \
         which terminates a cmd.exe command line"
    )]
    LineBreak {
        /// Position of the offending argument, counting the program as 0.
        index: usize,
    },

    /// The argument contained a NUL, which no Windows API accepts.
    #[error("argument {index} contains a NUL byte")]
    Nul {
        /// Position of the offending argument, counting the program as 0.
        index: usize,
    },

    /// The resolved script path cannot be quoted unambiguously.
    ///
    /// A Windows file name cannot contain `"`, and one ending in `\` would
    /// escape the closing quote of its own quote pair.
    #[error("the script path contains a quote or ends with a backslash, so it cannot be quoted")]
    ScriptPath,
}

/// UTF-16 code units for the characters this module has to reason about.
mod unit {
    /// `"`
    pub(super) const QUOTE: u16 = b'"' as u16;
    /// `\`
    pub(super) const BACKSLASH: u16 = b'\\' as u16;
    /// `%`
    pub(super) const PERCENT: u16 = b'%' as u16;
    /// Carriage return.
    pub(super) const CR: u16 = b'\r' as u16;
    /// Line feed.
    pub(super) const LF: u16 = b'\n' as u16;
    /// NUL.
    pub(super) const NUL: u16 = 0;
    /// Space.
    pub(super) const SPACE: u16 = b' ' as u16;
}

/// Characters that are safe unquoted in both `cmd.exe` parses.
///
/// Deliberately an allowlist. Enumerating the characters that *must* be quoted
/// means being wrong the moment `cmd.exe` grows another metacharacter; an
/// allowlist of the ones known to be inert is wrong only in the direction of
/// quoting something unnecessarily.
const UNQUOTED_PUNCTUATION: &str = r"#$*+-./:?@\_";

/// The no-op substring expansion spliced in front of every `%`.
///
/// `%cd:~,%` is the current directory with an empty start and end index, so it
/// contributes nothing. Its purpose is to leave `cmd.exe` without a `%NAME%`
/// pair to match.
const PERCENT_GUARD: &str = "%%cd:~,";

/// Whether an argument has to be wrapped in quotes.
fn needs_quoting(arg: &[u16]) -> bool {
    if arg.is_empty() {
        // An empty argument would otherwise vanish entirely.
        return true;
    }
    if arg.last() == Some(&unit::BACKSLASH) {
        // A trailing backslash would escape the closing quote of a `"%~1"` in
        // the script, so force quoting and let the doubling below handle it.
        return true;
    }

    arg.iter().any(|&unit| {
        // `u8::try_from` is not an ASCII test: it succeeds for the whole
        // Latin-1 range, which would classify `é` as punctuation that needs
        // quoting. The bound has to be 0x80.
        let Some(ch) = u8::try_from(unit).ok().filter(u8::is_ascii).map(char::from) else {
            // Non-ASCII. Quote anything in a Unicode control block; leave the
            // rest, which `cmd.exe` does not interpret.
            return char::from_u32(u32::from(unit)).is_some_and(char::is_control);
        };
        !(ch.is_ascii_alphanumeric() || UNQUOTED_PUNCTUATION.contains(ch))
    })
}

/// Appends one escaped argument to a `cmd.exe` command line.
///
/// # Errors
///
/// Returns [`CmdLineError::LineBreak`] or [`CmdLineError::Nul`] for an argument
/// that cannot be represented on a `cmd.exe` command line at all.
pub fn append_argument(out: &mut Vec<u16>, arg: &[u16], index: usize) -> Result<(), CmdLineError> {
    if arg.contains(&unit::CR) || arg.contains(&unit::LF) {
        return Err(CmdLineError::LineBreak { index });
    }
    if arg.contains(&unit::NUL) {
        return Err(CmdLineError::Nul { index });
    }

    let quote = needs_quoting(arg);
    if quote {
        out.push(unit::QUOTE);
    }

    let mut backslashes: usize = 0;
    for &code in arg {
        match code {
            unit::BACKSLASH => backslashes += 1,
            unit::QUOTE => {
                // 2n backslashes before a literal quote, so the argv parser on
                // the far side sees n of them and a quote it does not treat as
                // a delimiter.
                out.extend(std::iter::repeat_n(unit::BACKSLASH, backslashes));
                backslashes = 0;
                // Doubling rather than `\"`: a backslash-escaped quote still
                // closes the quoted region as far as cmd.exe is concerned, and
                // everything after it would be re-exposed to the metacharacter
                // parser. `""` leaves and re-enters with nothing in between.
                out.push(unit::QUOTE);
            }
            unit::PERCENT => {
                backslashes = 0;
                out.extend(PERCENT_GUARD.encode_utf16());
            }
            _ => backslashes = 0,
        }
        out.push(code);
    }

    if quote {
        // 2n backslashes before the closing quote, so it stays a delimiter.
        out.extend(std::iter::repeat_n(unit::BACKSLASH, backslashes));
        out.push(unit::QUOTE);
    }

    Ok(())
}

/// Builds the argument string for `cmd.exe`, running `script` with `args`.
///
/// The returned value starts at the switches, so a caller passes it as a single
/// raw argument to a `cmd.exe` process: nothing re-quotes it on the way out.
///
/// # Errors
///
/// Returns [`CmdLineError::ScriptPath`] if the script path cannot be quoted,
/// and [`CmdLineError::LineBreak`] or [`CmdLineError::Nul`] for an argument
/// that `cmd.exe` cannot carry.
pub fn batch_command_line(script: &[u16], args: &[Vec<u16>]) -> Result<Vec<u16>, CmdLineError> {
    if script.contains(&unit::QUOTE) || script.last() == Some(&unit::BACKSLASH) {
        return Err(CmdLineError::ScriptPath);
    }
    if script.contains(&unit::NUL) {
        return Err(CmdLineError::Nul { index: 0 });
    }

    let mut out: Vec<u16> = CMD_SWITCHES.encode_utf16().collect();
    out.push(unit::SPACE);

    // The outer quote pair. `/s` makes cmd.exe strip exactly the first and last
    // quote of what follows and treat everything between as the command, with
    // no conditional rule to reason about.
    out.push(unit::QUOTE);

    out.push(unit::QUOTE);
    out.extend_from_slice(script);
    out.push(unit::QUOTE);

    for (offset, arg) in args.iter().enumerate() {
        out.push(unit::SPACE);
        append_argument(&mut out, arg, offset + 1)?;
    }

    out.push(unit::QUOTE);
    Ok(out)
}

/// A `Vec<u16>` rendered for a test assertion or a diagnostic.
///
/// Lossy by construction; never used to build a command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utf16Display<'a>(pub &'a [u16]);

impl fmt::Display for Utf16Display<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for ch in char::decode_utf16(self.0.iter().copied()) {
            f.write_fmt(format_args!("{}", ch.unwrap_or(char::REPLACEMENT_CHARACTER)))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn escape(arg: &str) -> String {
        let mut out = Vec::new();
        append_argument(&mut out, &units(arg), 1).expect("representable");
        Utf16Display(&out).to_string()
    }

    fn line(script: &str, args: &[&str]) -> String {
        let args: Vec<Vec<u16>> = args.iter().map(|a| units(a)).collect();
        let out = batch_command_line(&units(script), &args).expect("representable");
        Utf16Display(&out).to_string()
    }

    #[test]
    fn the_switches_disable_every_feature_that_could_run_something_else() {
        assert!(CMD_SWITCHES.contains("/d"), "AutoRun must be disabled");
        assert!(CMD_SWITCHES.contains("/v:OFF"), "delayed expansion must be disabled");
        assert!(CMD_SWITCHES.contains("/s"), "the conditional quote rule must be pinned");
        assert!(CMD_SWITCHES.contains("/e:ON"), "the percent guard needs command extensions");
    }

    #[test]
    fn a_plain_word_is_left_alone() {
        assert_eq!(escape("test"), "test");
        assert_eq!(escape("build2"), "build2");
        // The unquoted allowlist.
        assert_eq!(escape("--flag"), "--flag");
        assert_eq!(escape(r"C:\dir\file.txt"), r"C:\dir\file.txt");
    }

    #[test]
    fn whitespace_forces_quoting() {
        assert_eq!(escape("a b"), r#""a b""#);
        assert_eq!(escape("a\tb"), "\"a\tb\"");
    }

    #[test]
    fn an_empty_argument_is_quoted_so_it_survives() {
        // Without the quotes it would disappear from argv entirely.
        assert_eq!(escape(""), r#""""#);
    }

    #[test]
    fn command_separators_are_quoted_rather_than_executed() {
        // The CVE-2024-24576 shape: `a&b` unquoted runs `b` as a command.
        assert_eq!(escape("a&b"), r#""a&b""#);
        assert_eq!(escape("a|b"), r#""a|b""#);
        assert_eq!(escape("a>b"), r#""a>b""#);
        assert_eq!(escape("a<b"), r#""a<b""#);
        assert_eq!(escape("a&&b"), r#""a&&b""#);
    }

    #[test]
    fn a_caret_is_quoted_rather_than_treated_as_an_escape() {
        assert_eq!(escape("a^b"), r#""a^b""#);
        // Doubling would be wrong: inside quotes a caret is already literal.
        assert!(!escape("a^b").contains("^^"));
    }

    #[test]
    fn a_variable_reference_is_defused_rather_than_expanded() {
        let escaped = escape("%PATH%");
        // Every `%` gets the no-op substring expansion spliced in front of it,
        // so cmd.exe never sees a `%NAME%` pair.
        assert_eq!(escaped, "\"%%cd:~,%PATH%%cd:~,%\"");
        assert_eq!(escaped.matches("%%cd:~,").count(), 2);
    }

    #[test]
    fn a_lone_percent_is_guarded_too() {
        assert_eq!(escape("100%"), "\"100%%cd:~,%\"");
        assert_eq!(escape("a%b"), "\"a%%cd:~,%b\"");
    }

    #[test]
    fn delayed_expansion_syntax_is_quoted_and_the_switch_disables_it() {
        // `!` needs both: quoting stops the metacharacter parse seeing it, and
        // /v:OFF stops the script expanding it if it were re-enabled.
        assert_eq!(escape("!DELAYED!"), r#""!DELAYED!""#);
        assert!(CMD_SWITCHES.contains("/v:OFF"));
    }

    #[test]
    fn an_inner_quote_is_doubled_not_backslash_escaped() {
        // `\"` would close the quoted region as far as cmd.exe is concerned,
        // re-exposing everything after it to the metacharacter parser.
        assert_eq!(escape(r#"a"b"#), r#""a""b""#);
        assert!(!escape(r#"a"b"#).contains(r#"\""#));
    }

    #[test]
    fn backslashes_before_a_quote_are_doubled() {
        // 2n backslashes then the doubled quote, so the argv parser on the far
        // side reconstructs n backslashes and a literal quote.
        assert_eq!(escape(r#"a\"b"#), r#""a\\""b""#);
        assert_eq!(escape(r#"a\\"b"#), r#""a\\\\""b""#);
    }

    #[test]
    fn a_trailing_backslash_is_doubled_against_the_closing_quote() {
        // Otherwise `"%~1"` in the script would see the backslash escape the
        // quote and swallow the rest of the line.
        assert_eq!(escape(r"a\"), r#""a\\""#);
        assert_eq!(escape(r"C:\dir\"), r#""C:\dir\\""#);
    }

    #[test]
    fn backslashes_not_adjacent_to_a_quote_are_left_alone() {
        assert_eq!(escape(r"C:\a\b"), r"C:\a\b");
    }

    #[test]
    fn a_line_break_is_refused_rather_than_truncated() {
        let mut out = Vec::new();
        assert_eq!(
            append_argument(&mut out, &units("a\nb"), 3),
            Err(CmdLineError::LineBreak { index: 3 })
        );
        assert_eq!(
            append_argument(&mut out, &units("a\rb"), 1),
            Err(CmdLineError::LineBreak { index: 1 })
        );
    }

    #[test]
    fn a_nul_is_refused() {
        let mut out = Vec::new();
        assert_eq!(
            append_argument(&mut out, &[0x61, 0, 0x62], 2),
            Err(CmdLineError::Nul { index: 2 })
        );
    }

    #[test]
    fn the_error_names_the_argument_position() {
        let args = vec![units("ok"), units("bad\nvalue")];
        let err = batch_command_line(&units(r"C:\n\npm.cmd"), &args).unwrap_err();
        assert_eq!(err, CmdLineError::LineBreak { index: 2 });
        assert!(err.to_string().contains("argument 2"));
    }

    #[test]
    fn the_whole_command_is_wrapped_in_one_outer_quote_pair() {
        let built = line(r"C:\Program Files\nodejs\npm.cmd", &["test"]);
        assert_eq!(built, "/d /e:ON /v:OFF /s /c \"\"C:\\Program Files\\nodejs\\npm.cmd\" test\"");
        assert!(built.ends_with('"'));
    }

    #[test]
    fn an_unquotable_script_path_is_refused() {
        assert_eq!(
            batch_command_line(&units(r#"C:\we"ird.cmd"#), &[]),
            Err(CmdLineError::ScriptPath)
        );
        assert_eq!(batch_command_line(&units(r"C:\dir\"), &[]), Err(CmdLineError::ScriptPath));
    }

    #[test]
    fn the_full_adversarial_set_produces_a_balanced_command_line() {
        let adversarial =
            [r#"a"b"#, "a&b", "%PATH%", "!DELAYED!", "a b", "a^b", "", "a|b", r"a\", "100%"];
        let built = line(r"C:\tools\shim.cmd", &adversarial);

        // Every quote is either an opening/closing delimiter or half of a
        // doubled literal, so the total is even. An odd count would mean some
        // argument left cmd.exe inside a quoted region, which is the failure
        // that turns the next argument into a command.
        assert_eq!(built.matches('"').count() % 2, 0, "unbalanced quotes in {built}");
        assert!(!built.contains('\n') && !built.contains('\r'));
    }

    #[test]
    fn non_ascii_arguments_survive_unquoted() {
        assert_eq!(escape("café"), "café");
        assert_eq!(escape("日本"), "日本");
    }

    #[test]
    fn utf16_display_round_trips() {
        assert_eq!(Utf16Display(&units("héllo")).to_string(), "héllo");
    }
}
