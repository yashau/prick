//! Slugs: the one spelling every route addresses a project or an environment
//! by.
//!
//! # Why the CLI checks this itself
//!
//! `Slug` in `@prick/shared` is `^[a-z0-9]+(?:-[a-z0-9]+)*$`, bounded at 64
//! characters, and every path parameter is validated against it. Sending
//! `EU West` produces a `422` whose message is about a schema; checking here
//! produces one about the name the user typed, before a request is made.
//!
//! The grammar is also what makes two other things unambiguous, which is why it
//! is this strict: a slug contains no `/`, so it cannot add a path segment, and
//! no `:`, so `project:environment` and `KEY:reveal` each have exactly one
//! parse.
//!
//! # Where this would rather live
//!
//! `prick-core`, with the other pure string logic. It is here because
//! `prick-core` is machine-checked for purity and is not this component's to
//! change; moving it is a one-file follow-up with no behaviour in it.

use crate::error::CliError;

/// The longest a slug may be, matching `SLUG_MAX_LENGTH` in `@prick/shared`.
pub const SLUG_MAX_LEN: usize = 64;

/// Whether a name is already a valid slug.
///
/// Lowercase ASCII letters and digits, with single interior hyphens: no
/// leading or trailing hyphen, and no two in a row.
pub fn is_slug(value: &str) -> bool {
    if value.is_empty() || value.len() > SLUG_MAX_LEN {
        return false;
    }

    let mut previous_hyphen = true; // Treat the start as a hyphen: none may follow.
    for byte in value.bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' => previous_hyphen = false,
            b'-' if !previous_hyphen => previous_hyphen = true,
            _ => return false,
        }
    }

    // A trailing hyphen leaves the flag set.
    !previous_hyphen
}

/// Derives a slug from a display name.
///
/// Everything outside `[a-z0-9]` becomes a hyphen, runs collapse, and the ends
/// are trimmed. Returns `None` when nothing usable survives -- a name of
/// entirely non-ASCII characters has no slug, and inventing one such as
/// `project-1` would produce an identifier that does not resemble what was
/// typed.
pub fn slugify(name: &str) -> Option<String> {
    let mut slug = String::with_capacity(name.len().min(SLUG_MAX_LEN));

    for ch in name.chars() {
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_lowercase() || lowered.is_ascii_digit() {
            slug.push(lowered);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }

        if slug.len() >= SLUG_MAX_LEN {
            break;
        }
    }

    // Only ASCII was pushed, and the loop stops at the bound, so trimming can
    // only shorten what is already short enough.
    let trimmed = slug.trim_matches('-');

    if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
}

/// Rejects a name that no route could address.
///
/// # Errors
///
/// [`CliError::Other`] naming the value and the grammar. `kind` is the word the
/// message uses -- "project", "environment" -- so the reader is told which of
/// the two arguments is wrong.
pub fn require_slug(kind: &str, value: &str) -> Result<(), CliError> {
    if is_slug(value) {
        return Ok(());
    }

    let suggestion = slugify(value)
        .filter(|slug| slug != value)
        .map(|slug| format!(" Did you mean `{slug}`?"))
        .unwrap_or_default();

    Err(CliError::Other(format!(
        "`{value}` is not a usable {kind} name: it must be lowercase letters, digits and single \
         hyphens, at most {SLUG_MAX_LEN} characters.{suggestion}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grammar_matches_the_shared_schemas() {
        for value in ["a", "billing", "eu-west", "eu-west-1", "a1", "0"] {
            assert!(is_slug(value), "{value} is a valid slug");
        }

        for value in
            ["", "-eu", "eu-", "eu--west", "EU", "eu west", "eu:west", "eu/west", "eu.west", "café"]
        {
            assert!(!is_slug(value), "{value} is not a valid slug");
        }
    }

    #[test]
    fn a_slug_is_bounded() {
        assert!(is_slug(&"a".repeat(SLUG_MAX_LEN)));
        assert!(!is_slug(&"a".repeat(SLUG_MAX_LEN + 1)));
    }

    #[test]
    fn a_display_name_becomes_the_obvious_slug() {
        assert_eq!(slugify("Billing").as_deref(), Some("billing"));
        assert_eq!(slugify("Billing EU").as_deref(), Some("billing-eu"));
        assert_eq!(slugify("EU  West").as_deref(), Some("eu-west"));
        assert_eq!(slugify("eu:west").as_deref(), Some("eu-west"));
        assert_eq!(slugify("  Production  ").as_deref(), Some("production"));
        assert_eq!(slugify("v2.1").as_deref(), Some("v2-1"));
    }

    #[test]
    fn every_derived_slug_is_actually_a_slug() {
        for name in ["Billing EU", "!!!weird!!!name!!!", "a-".repeat(80).as_str(), "9 lives"] {
            if let Some(slug) = slugify(name) {
                assert!(is_slug(&slug), "slugify({name:?}) produced {slug:?}");
            }
        }
    }

    #[test]
    fn a_name_with_nothing_usable_in_it_has_no_slug() {
        // Better than inventing an identifier that resembles nothing the user
        // typed and that they will have to look up to use.
        assert_eq!(slugify("日本"), None);
        assert_eq!(slugify("---"), None);
        assert_eq!(slugify(""), None);
    }

    #[test]
    fn the_refusal_names_the_grammar_and_offers_the_derived_form() {
        let err = require_slug("environment", "EU West").expect_err("not a slug");
        let message = err.to_string();
        assert!(message.contains("environment"), "{message}");
        assert!(message.contains("EU West"), "{message}");
        assert!(message.contains("eu-west"), "{message}");
    }

    #[test]
    fn a_valid_slug_is_accepted_without_comment() {
        assert!(require_slug("project", "billing").is_ok());
    }
}
