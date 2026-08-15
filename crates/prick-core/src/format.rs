//! Serialisation of secret sets into the shell-facing output formats.
//!
//! Every format here is **unconditionally quoting**. Not "quote when
//! necessary" -- always. Conditional quoting is where output formatters go
//! wrong, because deciding whether a value needs quoting means modelling the
//! consumer's grammar correctly, and a single miss is a command injection or a
//! silently altered value.
//!
//! | Format | Rule |
//! |---|---|
//! | [`OutputFormat::Env`] | Double-quoted; escapes `\`, `"`, newline, carriage return, tab. Raw UTF-8 otherwise |
//! | [`OutputFormat::Shell`] | POSIX **single** quotes; the only escape is `'` becoming `'\''` |
//! | [`OutputFormat::Yaml`] | Double-quoted **key and value** |
//! | [`OutputFormat::Json`] | Sorted keys, deterministic byte output |
//!
//! Notes on the two interesting ones.
//!
//! **Shell.** Inside POSIX single quotes the shell interprets *nothing* --
//! not `$`, not a backtick, not a backslash, not `!`. So closing the quote,
//! emitting an escaped quote, and reopening is total: a value can contain any
//! byte sequence and still evaluate back to itself. A formatter that
//! double-quotes and escapes only `"` leaves `$`, backtick and `\` live, which
//! turns a secret value into arbitrary command execution in the consumer's
//! shell.
//!
//! **YAML.** Quoting the key as well as the value sidesteps the entire YAML
//! 1.1-versus-1.2 minefield in one move: `yes`/`no`/`on`/`off` as booleans,
//! `null`/`~`, `12:30` read as a sexagesimal integer, `0755` as octal, and
//! `NO` as a country code. A quoted scalar is a string in every YAML version.
//!
//! The `env` format deliberately does **not** emit backslash-u escapes. Most
//! `.env` consumers do not implement them, so a value written that way would be
//! read back as a literal backslash. Control characters that cannot be
//! expressed with the five supported escapes are therefore an **error**, not a
//! silently corrupted line.

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};
use std::str::FromStr;

/// Why a secret set could not be rendered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum FormatError {
    /// A value contained a C0 control character the target format has no
    /// escape for. The offending value is deliberately **not** included.
    #[error(
        "the value of `{key}` contains control character U+{code:04X}, \
         which the `{format}` format cannot represent"
    )]
    UnrepresentableControl {
        /// The key, which is plaintext by design and safe to name.
        key: String,
        /// The code point that could not be encoded.
        code: u32,
        /// The format that rejected it.
        format: &'static str,
    },
    /// The requested format name was not recognised.
    #[error("unknown output format `{0}`")]
    UnknownFormat(String),
}

/// The output formats `prk secrets download` can produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OutputFormat {
    /// `KEY="value"`, suitable for a `.env` file.
    #[default]
    Env,
    /// `export KEY='value'`, suitable for `eval "$(...)"`.
    Shell,
    /// `"KEY": "value"`, a flat YAML mapping.
    Yaml,
    /// A JSON object with sorted keys.
    Json,
}

impl OutputFormat {
    /// Every format, in the order they should appear in help text.
    pub const ALL: [Self; 4] = [Self::Env, Self::Shell, Self::Yaml, Self::Json];

    /// The lowercase name used on the command line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Shell => "shell",
            Self::Yaml => "yaml",
            Self::Json => "json",
        }
    }
}

impl fmt::Display for OutputFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for OutputFormat {
    type Err = FormatError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|f| f.as_str() == s)
            .ok_or_else(|| FormatError::UnknownFormat(s.to_owned()))
    }
}

/// Renders a secret set in the requested format.
///
/// A [`BTreeMap`] is required rather than accepted for convenience: iteration
/// order is key order, so the same input always produces byte-identical output.
/// That is what makes `prk secrets download | diff` meaningful.
///
/// The result always ends with a newline.
///
/// # Errors
///
/// Returns [`FormatError::UnrepresentableControl`] if a value cannot be encoded
/// in the target format. Nothing is written in that case -- a partial file is
/// worse than no file.
pub fn render(
    format: OutputFormat,
    secrets: &BTreeMap<String, String>,
) -> Result<String, FormatError> {
    match format {
        OutputFormat::Json => Ok(render_json(secrets)),
        OutputFormat::Shell => {
            Ok(join_lines(secrets.iter().map(|(key, value)| shell_line(key, value))))
        }
        OutputFormat::Yaml => {
            Ok(join_lines(secrets.iter().map(|(key, value)| yaml_line(key, value))))
        }
        OutputFormat::Env => {
            let mut out = String::new();
            for (key, value) in secrets {
                out.push_str(&env_line(key, value)?);
                out.push('\n');
            }
            Ok(out)
        }
    }
}

/// Concatenates rendered lines, each terminated with a newline.
fn join_lines(lines: impl Iterator<Item = String>) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Renders one `KEY="value"` line for a `.env` file.
///
/// # Errors
///
/// Returns [`FormatError::UnrepresentableControl`] for any C0 control other
/// than newline, carriage return and tab.
pub fn env_line(key: &str, value: &str) -> Result<String, FormatError> {
    let mut out = String::with_capacity(key.len() + value.len() + 3);
    out.push_str(key);
    out.push_str("=\"");

    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                return Err(FormatError::UnrepresentableControl {
                    key: key.to_owned(),
                    code: u32::from(c),
                    format: "env",
                });
            }
            c => out.push(c),
        }
    }

    out.push('"');
    Ok(out)
}

/// Renders one `export KEY='value'` line.
///
/// Total for any input: single quotes suppress every shell metacharacter, and
/// an embedded `'` is emitted as `'\''` -- close, escaped quote, reopen.
pub fn shell_line(key: &str, value: &str) -> String {
    format!("export {key}={}", single_quote(value))
}

/// Wraps a value in POSIX single quotes, escaping any embedded single quote.
pub fn single_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Renders one `"KEY": "value"` YAML mapping entry.
///
/// Both halves are double-quoted, so no value can be reinterpreted as a
/// boolean, a null, a number, a date or a sexagesimal.
pub fn yaml_line(key: &str, value: &str) -> String {
    format!("{}: {}", double_quote_yaml(key), double_quote_yaml(value))
}

/// Renders a YAML double-quoted scalar.
///
/// Unlike the `env` format, YAML's double-quoted style defines a hexadecimal
/// escape, so every control character is representable and this cannot fail.
pub fn double_quote_yaml(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 || c == '\u{7f}' => {
                let code = u32::from(c);
                // Writing into a String is infallible.
                let _ = write!(out, "\\x{code:02x}");
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Renders a JSON object with sorted keys and a trailing newline.
///
/// Written by hand rather than through `serde_json::to_string_pretty` so that
/// the function is total -- there is no error path to swallow -- and so the
/// exact byte layout is pinned by this crate rather than by a dependency's
/// formatting choices.
fn render_json(secrets: &BTreeMap<String, String>) -> String {
    let mut out = String::from("{\n");
    for (index, (key, value)) in secrets.iter().enumerate() {
        if index > 0 {
            out.push_str(",\n");
        }
        out.push_str("  ");
        out.push_str(&json_string(key));
        out.push_str(": ");
        out.push_str(&json_string(value));
    }
    if !secrets.is_empty() {
        out.push('\n');
    }
    out.push_str("}\n");
    out
}

/// Renders a JSON string literal per RFC 8259.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 => {
                let code = u32::from(c);
                // Writing into a String is infallible.
                let _ = write!(out, "\\u{code:04x}");
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn shell_quoting_neutralises_every_metacharacter() {
        // The upstream formatter double-quoted and escaped only `"`, leaving
        // all of these live. Under single quotes none of them are special.
        let hostile = "$(id) `id` ${HOME} \\ ! & ; | > < * ? ~ #";
        let line = shell_line("SECRET", hostile);
        assert_eq!(line, format!("export SECRET='{hostile}'"));
        assert!(!line.contains("\"$"), "value must not be double-quoted");
    }

    #[test]
    fn shell_quoting_handles_an_embedded_single_quote() {
        assert_eq!(single_quote("it's"), r"'it'\''s'");
        assert_eq!(single_quote("'"), r"''\'''");
        assert_eq!(single_quote("''"), r"''\'''\'''");
        assert_eq!(single_quote(""), "''");
    }

    #[test]
    fn shell_quoting_keeps_newlines_literal() {
        // Legal inside single quotes, so no escaping is needed or wanted.
        assert_eq!(single_quote("a\nb"), "'a\nb'");
    }

    #[test]
    fn env_escapes_exactly_five_characters() {
        assert_eq!(env_line("K", "plain").unwrap(), r#"K="plain""#);
        assert_eq!(env_line("K", "a\nb").unwrap(), r#"K="a\nb""#);
        assert_eq!(env_line("K", "a\rb").unwrap(), r#"K="a\rb""#);
        assert_eq!(env_line("K", "a\tb").unwrap(), r#"K="a\tb""#);
        assert_eq!(env_line("K", r"a\b").unwrap(), r#"K="a\\b""#);
        assert_eq!(env_line("K", r#"a"b"#).unwrap(), r#"K="a\"b""#);
    }

    #[test]
    fn env_passes_utf8_through_raw() {
        // No backslash-u escapes: most .env parsers do not implement them.
        assert_eq!(env_line("K", "café 日本 🔑").unwrap(), "K=\"café 日本 🔑\"");
    }

    #[test]
    fn env_leaves_shell_metacharacters_alone_inside_its_own_quotes() {
        // .env is not shell; `$` is data here. Consumers that do interpolate
        // are opting into it.
        assert_eq!(env_line("K", "$HOME").unwrap(), r#"K="$HOME""#);
    }

    #[test]
    fn env_refuses_unrepresentable_controls_rather_than_corrupting_the_line() {
        let err = env_line("API_KEY", "a\u{7}b").unwrap_err();
        assert_eq!(
            err,
            FormatError::UnrepresentableControl {
                key: "API_KEY".to_owned(),
                code: 0x07,
                format: "env",
            }
        );
        // The message names the key but never the value.
        let rendered = err.to_string();
        assert!(rendered.contains("API_KEY"));
        assert!(!rendered.contains('b'), "value must not appear in the error");
    }

    #[test]
    fn env_rejects_a_null_byte() {
        assert!(env_line("K", "a\u{0}b").is_err());
    }

    #[test]
    fn yaml_quotes_the_values_yaml_would_otherwise_reinterpret() {
        for value in ["yes", "no", "on", "off", "null", "~", "12:30", "0755", "true", "1.0"] {
            let line = yaml_line("K", value);
            assert_eq!(line, format!(r#""K": "{value}""#), "{value} was not quoted");
        }
    }

    #[test]
    fn yaml_quotes_the_key_too() {
        assert_eq!(yaml_line("NO", "x"), r#""NO": "x""#);
        assert_eq!(yaml_line("A:B", "x"), r#""A:B": "x""#);
    }

    #[test]
    fn yaml_can_represent_controls_that_env_cannot() {
        assert_eq!(double_quote_yaml("a\u{7}b"), r#""a\x07b""#);
        assert_eq!(double_quote_yaml("a\nb"), r#""a\nb""#);
    }

    #[test]
    fn json_output_is_sorted_and_deterministic() {
        let secrets = map(&[("Z", "1"), ("A", "2"), ("M", "3")]);
        let out = render(OutputFormat::Json, &secrets).unwrap();
        assert_eq!(out, "{\n  \"A\": \"2\",\n  \"M\": \"3\",\n  \"Z\": \"1\"\n}\n");
        assert_eq!(render(OutputFormat::Json, &secrets).unwrap(), out);
    }

    #[test]
    fn json_matches_serde_for_awkward_values() {
        let secrets = map(&[("K", "a\"b\\c\nd\te\u{8}f\u{c}g\u{1}h")]);
        let ours: serde_json::Value =
            serde_json::from_str(&render(OutputFormat::Json, &secrets).unwrap()).unwrap();
        let theirs = serde_json::to_value(&secrets).unwrap();
        assert_eq!(ours, theirs, "our JSON must parse back to the same value");
    }

    #[test]
    fn json_of_an_empty_set_is_still_valid() {
        let out = render(OutputFormat::Json, &BTreeMap::new()).unwrap();
        assert_eq!(out, "{\n}\n");
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    }

    #[test]
    fn every_format_ends_with_a_newline() {
        let secrets = map(&[("A", "1")]);
        for format in OutputFormat::ALL {
            let out = render(format, &secrets).unwrap();
            assert!(out.ends_with('\n'), "{format} did not end with a newline");
        }
    }

    #[test]
    fn every_format_renders_an_empty_set_without_error() {
        for format in OutputFormat::ALL {
            assert!(render(format, &BTreeMap::new()).is_ok(), "{format} failed on an empty set");
        }
    }

    #[test]
    fn render_fails_whole_rather_than_emitting_a_partial_document() {
        let secrets = map(&[("A", "fine"), ("B", "bad\u{7}"), ("C", "fine")]);
        assert!(render(OutputFormat::Env, &secrets).is_err());
        // The other formats can represent it.
        assert!(render(OutputFormat::Shell, &secrets).is_ok());
        assert!(render(OutputFormat::Yaml, &secrets).is_ok());
        assert!(render(OutputFormat::Json, &secrets).is_ok());
    }

    #[test]
    fn format_names_round_trip() {
        for format in OutputFormat::ALL {
            assert_eq!(format.as_str().parse::<OutputFormat>().unwrap(), format);
            assert_eq!(format.to_string(), format.as_str());
        }
        assert_eq!(
            "toml".parse::<OutputFormat>(),
            Err(FormatError::UnknownFormat("toml".to_owned()))
        );
    }

    #[test]
    fn env_output_round_trips_through_the_dotenv_parser() {
        let secrets = map(&[
            ("SIMPLE", "value"),
            ("SPACED", "a b c"),
            ("QUOTED", r#"say "hi""#),
            ("BACKSLASH", r"C:\path\to"),
            ("NEWLINE", "line1\nline2"),
            ("TABBED", "a\tb"),
            ("UNICODE", "café 🔑"),
            ("DOLLAR", "$HOME `id` ${x}"),
            ("HASH", "trailing # hash"),
        ]);

        let rendered = render(OutputFormat::Env, &secrets).unwrap();
        let parsed: BTreeMap<String, String> =
            crate::dotenv::parse(&rendered).unwrap().into_iter().collect();

        assert_eq!(parsed, secrets);
    }
}
