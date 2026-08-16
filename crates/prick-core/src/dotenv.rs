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
//! | `KEY=value` | Unquoted; surrounding whitespace trimmed, no escapes |
//! | `KEY='value'` | Literal; no escape sequences at all, `\` is a backslash |
//! | `KEY="value"` | `\\ \" \n \r \t` are escapes, everything else is literal |
//! | `export KEY=...` | The `export ` prefix is accepted and dropped |
//!
//! A quoted value may be followed by `# comment`, because the closing quote has
//! already said where the value ends.
//!
//! On an **unquoted** value, whitespace before a `#` is the one line shape this
//! format cannot resolve, and it is [rejected](DotenvError::AmbiguousComment).
//! `PASSWORD=hunter2 # 1` is either a password containing a hash or a password
//! with a comment after it; both occur in real files, and either reading stores
//! a value the author did not write without saying so. The two quoted forms
//! state which was meant, and `PASSWORD=hunter2#1` -- no whitespace -- is
//! unambiguous already.
//!
//! # Where this grammar is spoken
//!
//! `prk secrets upload` hands the document to the server, which parses it there
//! and reports the line it refused; that parser accepts this grammar and the
//! same rule about `#`. What this one does locally is prove the other
//! direction: [`crate::format::render`] emits `.env` output, and its tests read
//! that output back through here, so a downloaded environment is one this
//! product can be handed again.

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
    /// An unquoted value had whitespace before a `#`, which is a comment or
    /// part of the value with nothing in the line to say which.
    #[error("line {line}: unquoted value has a `#` after whitespace; quote the value to keep it")]
    AmbiguousComment {
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

        let value = parse_value(rest, line)?;
        out.push((key.to_owned(), value));
    }

    Ok(out)
}

/// Parses the right-hand side of a `KEY=` assignment.
///
/// The opening quote is looked for *past* any whitespace, but [`parse_unquoted`]
/// is handed that whitespace intact: whether it was there is what separates
/// `COLOR=#ffffff`, a value, from `COLOR= #ffffff`, which could be that same
/// value written with insignificant whitespace or an empty one with a comment.
fn parse_value(rest: &str, line: usize) -> Result<String, DotenvError> {
    let trimmed = rest.trim_start();
    match trimmed.as_bytes().first() {
        Some(b'\'') => parse_single_quoted(&trimmed[1..], line),
        Some(b'"') => parse_double_quoted(&trimmed[1..], line),
        _ => parse_unquoted(rest, line),
    }
}

/// An unquoted value runs to the end of the line, minus surrounding whitespace.
///
/// Whitespace before a `#` makes the line unreadable either way round, so it is
/// refused rather than resolved. A `#` that follows a non-space character is
/// part of the value: `TOKEN=ab#cd` is `ab#cd`.
fn parse_unquoted(rest: &str, line: usize) -> Result<String, DotenvError> {
    if rest.contains(" #") || rest.contains("\t#") {
        return Err(DotenvError::AmbiguousComment { line });
    }
    Ok(rest.trim().to_owned())
}

/// Single quotes are fully literal: the value ends at the next `'`.
fn parse_single_quoted(body: &str, line: usize) -> Result<String, DotenvError> {
    let end = body.find('\'').ok_or(DotenvError::UnterminatedQuote { line, quote: '\'' })?;
    check_after_close(&body[end + 1..], line)?;
    Ok(body[..end].to_owned())
}

/// After a closing quote only whitespace or a `#` comment may follow.
///
/// `KEY="a" b` is refused rather than read as `a`, so a mistyped `KEY="a" "b"`
/// cannot store half a value without saying so. A comment is fine: the quotes
/// already delimited the value, which is what makes quoting the answer to
/// [`DotenvError::AmbiguousComment`].
fn check_after_close(rest: &str, line: usize) -> Result<(), DotenvError> {
    let rest = rest.trim_start();
    if rest.is_empty() || rest.starts_with('#') {
        Ok(())
    } else {
        Err(DotenvError::TrailingContent { line })
    }
}

/// Double quotes support exactly five escapes and reject any other.
fn parse_double_quoted(body: &str, line: usize) -> Result<String, DotenvError> {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                check_after_close(chars.as_str(), line)?;
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
    fn a_hash_after_whitespace_in_an_unquoted_value_is_refused_not_guessed_at() {
        // Both readings of this line are losses. Truncating it stores "hunter2"
        // and the deploy authenticates with the wrong password; keeping it whole
        // stores a value with a stray comment welded onto the end. Neither is
        // visible to the operator, so the line is refused instead.
        assert_eq!(parse("PASSWORD=hunter2 # 1\n"), Err(DotenvError::AmbiguousComment { line: 1 }));
        assert_eq!(parse("A=1\nB=2 \t# x\n"), Err(DotenvError::AmbiguousComment { line: 2 }));
        // An empty value with a comment reads the same two ways: the value could
        // be nothing, or `#ffffff` written with insignificant whitespace.
        assert_eq!(parse("COLOR= # ffffff\n"), Err(DotenvError::AmbiguousComment { line: 1 }));
    }

    #[test]
    fn a_hash_that_follows_a_non_space_stays_in_the_value() {
        // The load-bearing case for the rule above: a parser that strips from
        // the first `#` stores the empty string for a colour and half a token.
        assert_eq!(parsed("COLOR=#ffffff\n")[0].1, "#ffffff");
        assert_eq!(parsed("TOKEN=ab#cd\n")[0].1, "ab#cd");
    }

    #[test]
    fn quoting_is_how_a_value_keeps_its_hash() {
        // The way out of `AmbiguousComment`, in both directions.
        assert_eq!(parsed("PASSWORD=\"hunter2 # 1\"\n")[0].1, "hunter2 # 1");
        assert_eq!(parsed("PASSWORD='hunter2 # 1'\n")[0].1, "hunter2 # 1");
        assert_eq!(parsed("PASSWORD=\"hunter2\" # 1\n")[0].1, "hunter2");
    }

    #[test]
    fn unquoted_values_are_trimmed() {
        assert_eq!(parsed("A=1   \n")[0].1, "1");
        assert_eq!(parsed("A=   1\n")[0].1, "1");
        assert_eq!(parsed("A=\n")[0].1, "");
        assert_eq!(parsed("A=   \n")[0].1, "");
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
        // A unicode escape is an unknown escape too. The `.env` ecosystem
        // treats `\u` inconsistently, so accepting one here would produce a
        // value other tools read back differently. The backslash is
        // interpolated so the escape never appears literally in this source
        // file.
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
    fn a_comment_may_follow_a_closing_quote() {
        // The closing quote already said where the value ended, so there is
        // nothing left to guess at -- and this is what makes "quote it" a real
        // answer for someone whose file has comments on its secret lines.
        assert_eq!(parsed(r#"A="a" # why"#)[0].1, "a");
        assert_eq!(parsed("A='a'   # why")[0].1, "a");
        assert_eq!(parsed(r##"A="a"#comment"##)[0].1, "a");
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
