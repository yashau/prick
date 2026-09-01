//! Redaction and fingerprinting of secret material for logs and diagnostics.
//!
//! The workspace lints stop a secret reaching a stream by accident: only the
//! output module may write, and `secrecy` keeps values from being formatted by
//! mistake. This module covers the deliberate cases -- diagnostics that must
//! mention a value in order to be useful.
//!
//! Two tools, with different jobs:
//!
//! - [`mask`] renders a placeholder of **fixed width**. Length is information;
//!   a mask that echoes it distinguishes a 12-character password from a 64-hex
//!   token, which narrows an offline search considerably.
//! - [`fingerprint`] renders a short, stable, one-way tag. Two operators can
//!   confirm they are looking at the same value without either revealing it,
//!   which is what makes "your local copy differs from the server's" a
//!   diagnosable statement.
//!
//! # What a fingerprint hides, and from whom
//!
//! [`fingerprint`] is unkeyed and unsalted -- `sha256(value)`, truncated -- so
//! anybody holding a candidate value can recompute the tag and see whether it
//! matches. That is exactly the property correlation needs: two parties who
//! never exchange the value still arrive at the same tag. It is also, in the
//! same breath, a guess-confirmation oracle.
//!
//! What separates the two readings is the entropy of the value, not the width
//! of the tag:
//!
//! - A **high-entropy** value -- a generated token, a key, another digest --
//!   is safe to fingerprint into a log. Recomputing the tag requires already
//!   knowing the value, and there is no candidate set small enough to search.
//! - A **low-entropy** value -- a human-chosen password, a PIN, anything drawn
//!   from a set an attacker can enumerate -- is not. A fingerprint that reaches
//!   a log an attacker can read confirms a guess offline at billions of
//!   candidates a second, and 72 bits is far more than enough to make that
//!   confirmation unambiguous.
//!
//! Keying the construction is what would close that, and this crate cannot do
//! it. An HMAC needs a key; sourcing one is I/O, which the crate contract
//! forbids, so it would have to arrive as an argument. A key each install
//! chooses for itself makes fingerprints incomparable between machines, which
//! is the entire reason they exist -- the client and the server are different
//! installs. A key shared fleet-wide keeps them comparable but means
//! distributing a new long-lived secret to every install and to the server,
//! which is a larger problem than the one it solves.
//!
//! So the property is upheld by the calling rule rather than by the
//! construction: fingerprint values that are themselves unguessable, and
//! nothing else.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// What a redacted value is replaced with in free text.
pub const PLACEHOLDER: &str = "[redacted]";

/// The fixed-width mask. Eight characters regardless of the input.
pub const MASK: &str = "********";

/// Bytes of digest kept in a fingerprint.
///
/// Nine bytes encode to twelve base64url characters with no padding. That is
/// 72 bits: far more than enough to keep two secrets from colliding, and short
/// enough to compare by eye in a terminal.
///
/// The width is a legibility and collision choice, not a security one. An
/// unkeyed digest is only as hard to invert as its input is to guess, at any
/// width; see the module documentation for what that means for callers.
const FINGERPRINT_BYTES: usize = 9;

/// Renders a fixed-width mask for a secret value.
///
/// Deliberately ignores its argument's length. Taking `&str` rather than no
/// argument keeps call sites readable and makes the intent grep-able.
pub fn mask(_value: &str) -> &'static str {
    MASK
}

/// Renders a short, stable, one-way tag for a value.
///
/// The output is prefixed so it is obvious in a log that the following
/// characters are a digest and not the value itself.
///
/// One-way is not the same as unguessable, and the difference is the caller's
/// to respect: the tag is unkeyed, so it confirms a guess as readily as it
/// correlates two copies of a value. Fingerprint tokens, keys and digests;
/// never a password, a PIN or any other value an attacker could enumerate. The
/// module documentation sets out why the construction cannot enforce that
/// itself.
pub fn fingerprint(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let truncated = &digest[..FINGERPRINT_BYTES];
    format!("sha256:{}", URL_SAFE_NO_PAD.encode(truncated))
}

/// Whether two values are the same, decided from fingerprints alone.
///
/// The comparison is not constant-time and must not be used on authentication
/// paths; it exists so a diagnostic can say "these differ" without either side
/// holding both values. It carries [`fingerprint`]'s rule about what may be
/// fingerprinted in the first place.
pub fn fingerprints_match(a: &str, b: &str) -> bool {
    fingerprint(a) == fingerprint(b)
}

/// Replaces every occurrence of each secret in `haystack` with [`PLACEHOLDER`].
///
/// Applied as a last line of defence to text that is about to be shown --
/// a subprocess's output, a server error body, a panic message.
///
/// Secrets are substituted **longest first**. Replacing shortest-first leaves
/// fragments behind whenever one secret contains another: with secrets `ab` and
/// `abcd`, the input `abcd` would otherwise become `[redacted]cd`, and those
/// two surviving characters are real secret material.
///
/// Empty secrets are skipped; substituting one would insert a placeholder
/// between every character.
pub fn redact(haystack: &str, secrets: &[&str]) -> String {
    let mut ordered: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    ordered.sort_unstable_by_key(|s| std::cmp::Reverse(s.len()));
    ordered.dedup();

    let mut out = haystack.to_owned();
    for secret in ordered {
        if out.contains(secret) {
            out = out.replace(secret, PLACEHOLDER);
        }
    }
    out
}

/// Whether any of `secrets` appears anywhere in `haystack`.
///
/// The predicate an assertion in the test suite uses: no secret value may
/// appear on stderr on any error path.
pub fn contains_any(haystack: &str, secrets: &[&str]) -> bool {
    secrets.iter().any(|s| !s.is_empty() && haystack.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mask_never_reveals_length() {
        assert_eq!(mask("a"), mask(&"a".repeat(4096)));
        assert_eq!(mask(""), MASK);
        assert_eq!(mask("hunter2").len(), MASK.len());
    }

    #[test]
    fn fingerprints_are_stable_and_short() {
        let a = fingerprint("hunter2");
        assert_eq!(a, fingerprint("hunter2"));
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), "sha256:".len() + 12);
    }

    #[test]
    fn fingerprints_distinguish_values() {
        assert_ne!(fingerprint("hunter2"), fingerprint("hunter3"));
        assert_ne!(fingerprint(""), fingerprint(" "));
        assert!(fingerprints_match("same", "same"));
        assert!(!fingerprints_match("same", "different"));
    }

    #[test]
    fn a_fingerprint_is_an_unsalted_truncated_digest() {
        // Pins the construction the module documentation reasons about: the tag
        // is recomputable by anyone holding the value, which is what makes it a
        // correlation handle for high-entropy values and a guess-confirmation
        // oracle for weak ones. Changing this changes that paragraph.
        let digest = Sha256::digest(b"hunter2");
        let encoded = URL_SAFE_NO_PAD.encode(&digest[..FINGERPRINT_BYTES]);
        assert_eq!(fingerprint("hunter2"), format!("sha256:{encoded}"));
    }

    #[test]
    fn a_fingerprint_never_contains_the_value() {
        let secret = "SUPERSECRETVALUE";
        assert!(!fingerprint(secret).contains(secret));
    }

    #[test]
    fn redaction_replaces_every_occurrence() {
        let out = redact("token=abc and again abc", &["abc"]);
        assert_eq!(out, "token=[redacted] and again [redacted]");
        assert!(!out.contains("abc"));
    }

    #[test]
    fn overlapping_secrets_leave_no_fragment() {
        // Shortest-first would produce "[redacted]cd" and leak two characters.
        let out = redact("abcd", &["ab", "abcd"]);
        assert_eq!(out, PLACEHOLDER);
        assert!(!out.contains("cd"));
    }

    #[test]
    fn empty_secrets_are_ignored() {
        assert_eq!(redact("hello", &[""]), "hello");
        assert_eq!(redact("hello", &["", "ell"]), "h[redacted]o");
    }

    #[test]
    fn redaction_of_nothing_is_the_identity() {
        assert_eq!(redact("unchanged", &[]), "unchanged");
    }

    #[test]
    fn redaction_handles_multiline_and_unicode() {
        let out = redact("line1\ncafé\nline3", &["café"]);
        assert_eq!(out, "line1\n[redacted]\nline3");
    }

    #[test]
    fn contains_any_detects_a_leak() {
        assert!(contains_any("error: value was hunter2", &["hunter2"]));
        assert!(!contains_any("error: value was [redacted]", &["hunter2"]));
        assert!(!contains_any("anything", &[""]), "an empty secret must not match");
        assert!(!contains_any("anything", &[]));
    }

    #[test]
    fn redacted_output_never_trips_the_leak_detector() {
        let secrets = ["hunter2", "s3cr3t", "hunter2andmore"];
        let text = "a hunter2 b s3cr3t c hunter2andmore d";
        let redacted = redact(text, &secrets);
        assert!(!contains_any(&redacted, &secrets), "redaction left a secret behind: {redacted}");
    }
}
