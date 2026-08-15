//! A strict `.env` parser.
//!
//! `.env` has no specification, so every implementation disagrees at the edges.
//! This one resolves the ambiguity in the direction a secrets manager needs:
//! **a line that cannot be parsed unambiguously is an error, never a guess.**
//! Importing a file and silently dropping the two lines the parser did not
//! understand is how a deploy loses `DATABASE_URL`.
//!
//! The accepted grammar:
//!
//! | Form | Meaning |
//! |---|---|
//! | `# ...` or blank | Ignored |
//! | `KEY=value` | Unquoted; trailing whitespace trimmed, no escapes, no inline comment |
//! | `KEY='value'` | Literal; no escape sequences at all, `\` is a backslash |
//! | `KEY="value"` | `\\ \" \n \r \t` are escapes, everything else is literal |
//! | `export KEY=...` | The `export ` prefix is accepted and dropped |
//!
//! Unquoted values deliberately do **not** support trailing `# comment`: a
//! password ending in ` # 1` is far more likely than a comment on a secret
//! line, and guessing wrong truncates the value.

use crate::keyname;

/// Why a `.env` document could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum DotenvError {
    /// A non-blank, non-comment line contained no `=`.
    #[error("line {line}: expected `KEY=value`")]
    MissingEquals {
        /// One-based line number.
        line: usize,
    },
    /// The key on this line was not a legal key name.
    #[error("line {line}: {source}")]
    InvalidKey {
        /// One-based line number.
        line: usize,
        /// The underlying validation failure.
        source: keyname::KeyNameError,
    },
    /// A quoted value opened but never closed.
    #[error("line {line}: unterminated {quote} quote")]
    UnterminatedQuote {
        /// One-based line number.
        line: usize,
        /// Which quote character was left open.
        quote: char,
    },
    /// A double-quoted value contained an escape this parser does not define.
    #[error("line {line}: unknown escape `\\{ch}` (valid: \\\\ \\\" \\n \\r \\t)")]
    UnknownEscape {
        /// One-based line number.
        line: usize,
        /// The character that followed the backslash.
        ch: char,
    },
    /// A quoted value had trailing content after the closing quote.
    #[error("line {line}: unexpected text after the closing quote")]
    TrailingContent {
        /// One-based line number.
        line: usize,
    },
    /// The same key appeared twice. Last-one-wins is a silent data loss bug.
    #[error("line {line}: duplicate key `{key}`, first defined on line {first}")]
    DuplicateKey {
        /// One-based line number of the second definition.
        line: usize,
        /// One-based line number of the first definition.
        first: usize,
        /// The repeated key.
        key: String,
    },
}

/// Parses a `.env` document into key/value pairs, preserving file order.
///
/// # Errors
///
/// Any line that is not unambiguously parseable aborts the whole parse. A
/// partially imported `.env` is worse than a rejected one.
pub fn parse(input: &str) -> Result<Vec<(String, String)>, DotenvError> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen: Vec<(&str, usize)> = Vec::new();

    for (index, raw) in input.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let trimmed = trimmed.strip_prefix("export ").map_or(trimmed, str::trim_start);

        let (key, rest) = trimmed.split_once('=').ok_or(DotenvError::MissingEquals { line })?;
        let key = key.trim_end();

        keyname::validate(key).map_err(|source| DotenvError::InvalidKey { line, source })?;

        if let Some((_, first)) = seen.iter().find(|(k, _)| *k == key) {
            return Err(DotenvError::DuplicateKey { line, first: *first, key: key.to_owned() });
        }
        seen.push((key, line));

        let value = parse_value(rest.trim_start(), line)?;
        out.push((key.to_owned(), value));
    }

    Ok(out)
}

/// Parses the right-hand side of a `KEY=` assignment.
fn parse_value(rest: &str, line: usize) -> Result<String, DotenvError> {
    match rest.as_bytes().first() {
        Some(b'\'') => parse_single_quoted(&rest[1..], line),
        Some(b'"') => parse_double_quoted(&rest[1..], line),
        _ => Ok(rest.trim_end().to_owned()),
    }
}

/// Single quotes are fully literal: the value ends at the next `'`.
fn parse_single_quoted(body: &str, line: usize) -> Result<String, DotenvError> {
    let end = body.find('\'').ok_or(DotenvError::UnterminatedQuote { line, quote: '\'' })?;
    if !body[end + 1..].trim().is_empty() {
        return Err(DotenvError::TrailingContent { line });
    }
    Ok(body[..end].to_owned())
}

/// Double quotes support exactly five escapes and reject any other.
fn parse_double_quoted(body: &str, line: usize) -> Result<String, DotenvError> {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if !chars.as_str().trim().is_empty() {
                    return Err(DotenvError::TrailingContent { line });
                }
                return Ok(out);
            }
            '\\' => {
                let escaped =
                    chars.next().ok_or(DotenvError::UnterminatedQuote { line, quote: '"' })?;
                out.push(match escaped {
                    '\\' => '\\',
                    '"' => '"',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => return Err(DotenvError::UnknownEscape { line, ch: other }),
                });
            }
            other => out.push(other),
        }
    }

    Err(DotenvError::UnterminatedQuote { line, quote: '"' })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> Vec<(String, String)> {
        parse(input).unwrap()
    }

    #[test]
    fn parses_a_plain_document() {
        let out = parsed("A=1\nB=two\n");
        assert_eq!(out, [("A".to_owned(), "1".to_owned()), ("B".to_owned(), "two".to_owned())]);
    }

    #[test]
    fn preserves_file_order() {
        let out = parsed("Z=1\nA=2\nM=3\n");
        let keys: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["Z", "A", "M"]);
    }

    #[test]
    fn skips_comments_and_blank_lines() {
        let out = parsed("# leading\n\n  \nA=1\n# trailing\n");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn accepts_the_export_prefix() {
        assert_eq!(parsed("export A=1\n"), [("A".to_owned(), "1".to_owned())]);
        // Not a prefix without the space.
        assert!(parse("exportA=1\n").is_ok());
        assert_eq!(parsed("exportA=1\n")[0].0, "exportA");
    }

    #[test]
    fn unquoted_values_keep_hashes_rather_than_guessing_at_comments() {
        // A truncating parser would return "hunter2" here and break the deploy.
        assert_eq!(parsed("PASSWORD=hunter2 # not a comment\n")[0].1, "hunter2 # not a comment");
    }

    #[test]
    fn unquoted_values_are_right_trimmed() {
        assert_eq!(parsed("A=1   \n")[0].1, "1");
        assert_eq!(parsed("A=   1\n")[0].1, "1");
        assert_eq!(parsed("A=\n")[0].1, "");
    }

    #[test]
    fn single_quotes_are_entirely_literal() {
        assert_eq!(parsed(r"A='a\nb'")[0].1, r"a\nb");
        assert_eq!(parsed(r#"A='he said "hi"'"#)[0].1, r#"he said "hi""#);
        assert_eq!(parsed("A='  spaced  '")[0].1, "  spaced  ");
        assert_eq!(parsed("A=''")[0].1, "");
    }

    #[test]
    fn double_quotes_interpret_the_five_escapes() {
        assert_eq!(parsed(r#"A="a\nb""#)[0].1, "a\nb");
        assert_eq!(parsed(r#"A="a\tb""#)[0].1, "a\tb");
        assert_eq!(parsed(r#"A="a\rb""#)[0].1, "a\rb");
        assert_eq!(parsed(r#"A="a\\b""#)[0].1, r"a\b");
        assert_eq!(parsed(r#"A="a\"b""#)[0].1, r#"a"b"#);
    }

    #[test]
    fn double_quotes_preserve_everything_else_literally() {
        assert_eq!(parsed(r#"A="$HOME `id` ${x}""#)[0].1, "$HOME `id` ${x}");
        assert_eq!(parsed(r#"A="  spaced  ""#)[0].1, "  spaced  ");
    }

    #[test]
    fn unknown_escapes_are_errors_not_silent_passthrough() {
        assert_eq!(parse(r#"A="a\qb""#), Err(DotenvError::UnknownEscape { line: 1, ch: 'q' }));
        // Unicode escapes are not implemented either: most .env consumers do
        // not implement them, so emitting one would produce a value that other
        // tools read back differently. The backslash is interpolated so the
        // escape never appears literally in this source file.
        let unicode_escape = format!("A=\"a{}u0041b\"", '\\');
        assert_eq!(parse(&unicode_escape), Err(DotenvError::UnknownEscape { line: 1, ch: 'u' }));
    }

    #[test]
    fn unterminated_quotes_are_errors() {
        assert_eq!(parse("A='oops"), Err(DotenvError::UnterminatedQuote { line: 1, quote: '\'' }));
        assert_eq!(
            parse(r#"A="oops"#),
            Err(DotenvError::UnterminatedQuote { line: 1, quote: '"' })
        );
        assert_eq!(
            parse(r#"A="oops\"#),
            Err(DotenvError::UnterminatedQuote { line: 1, quote: '"' })
        );
    }

    #[test]
    fn trailing_content_after_a_closing_quote_is_an_error() {
        assert_eq!(parse(r#"A="a" b"#), Err(DotenvError::TrailingContent { line: 1 }));
        assert_eq!(parse("A='a' b"), Err(DotenvError::TrailingContent { line: 1 }));
        // Trailing whitespace is fine.
        assert_eq!(parsed(r#"A="a"   "#)[0].1, "a");
    }

    #[test]
    fn missing_equals_is_an_error() {
        assert_eq!(parse("A=1\nJUST_A_WORD\n"), Err(DotenvError::MissingEquals { line: 2 }));
    }

    #[test]
    fn invalid_keys_are_rejected_with_a_line_number() {
        assert!(matches!(parse("1BAD=x"), Err(DotenvError::InvalidKey { line: 1, .. })));
        assert!(matches!(parse("A=1\nb-c=x"), Err(DotenvError::InvalidKey { line: 2, .. })));
    }

    #[test]
    fn duplicate_keys_are_rejected_rather_than_last_one_wins() {
        assert_eq!(
            parse("A=1\nB=2\nA=3\n"),
            Err(DotenvError::DuplicateKey { line: 3, first: 1, key: "A".to_owned() })
        );
    }

    #[test]
    fn key_may_have_whitespace_before_the_equals() {
        assert_eq!(parsed("A = 1\n"), [("A".to_owned(), "1".to_owned())]);
    }

    #[test]
    fn crlf_input_does_not_leak_carriage_returns_into_values() {
        // str::lines strips \r\n, so a CRLF checkout of a fixture parses the
        // same as an LF one. Worth pinning: an invisible \r on the end of a
        // token produces baffling authentication failures.
        assert_eq!(
            parsed("A=1\r\nB=2\r\n"),
            [("A".to_owned(), "1".to_owned()), ("B".to_owned(), "2".to_owned())]
        );
    }
}
