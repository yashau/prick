//! PKCE (RFC 7636) challenge derivation for the `S256` method.
//!
//! # What is and is not here
//!
//! Deriving a challenge from a verifier is a pure function of the verifier, so
//! it lives here and is covered by the miri run. **Generating** a verifier
//! needs a CSPRNG, which needs a syscall, so it lives in `prick-auth`.
//!
//! That split is why this crate can depend on `sha2` but not on `getrandom`.
//!
//! # The Cloudflare quirk
//!
//! Cloudflare's authorization endpoint rejects a `code_challenge` that does not
//! begin with an alphanumeric character. base64url output begins with `-` or
//! `_` roughly 3% of the time, so a generator that does not check produces an
//! intermittent login failure at about that rate -- frequent enough to be a
//! support burden, rare enough to look like a flake.
//!
//! The fix is to generate, check with [`is_acceptable_challenge`], and
//! regenerate on rejection. Rejection sampling keeps the verifier uniform over
//! the accepted set, which truncating or substituting the first character would
//! not.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// The shortest verifier RFC 7636 permits.
pub const MIN_VERIFIER_LEN: usize = 43;

/// The longest verifier RFC 7636 permits.
pub const MAX_VERIFIER_LEN: usize = 128;

/// The number of random bytes a verifier should be built from.
///
/// 32 bytes is 256 bits of entropy and base64url-encodes to exactly 43
/// characters, the RFC minimum length. Nothing is gained by going longer.
pub const VERIFIER_ENTROPY_BYTES: usize = 32;

/// The `code_challenge_method` value this module implements.
pub const METHOD: &str = "S256";

/// Derives the `S256` code challenge for a verifier.
///
/// `challenge = base64url_no_pad(SHA256(ascii(verifier)))`, per RFC 7636
/// section 4.2.
pub fn challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Whether a string is a well-formed `code_verifier`.
///
/// RFC 7636 section 4.1: 43 to 128 characters from the unreserved set
/// `A-Z a-z 0-9 - . _ ~`.
pub fn is_valid_verifier(verifier: &str) -> bool {
    let len = verifier.len();
    (MIN_VERIFIER_LEN..=MAX_VERIFIER_LEN).contains(&len)
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// Whether a derived challenge is acceptable to Cloudflare's endpoint.
///
/// Returns `false` when the first character is `-` or `_`, which base64url can
/// produce and which the endpoint rejects. Callers regenerate the verifier and
/// try again.
pub fn is_acceptable_challenge(challenge: &str) -> bool {
    challenge.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
}

/// Whether a verifier yields a challenge Cloudflare will accept.
///
/// The predicate a rejection-sampling generator loops on.
pub fn is_usable_verifier(verifier: &str) -> bool {
    is_valid_verifier(verifier) && is_acceptable_challenge(&challenge_s256(verifier))
}

/// Encodes random bytes as a `code_verifier`.
///
/// Separated from generation so the encoding is testable without a CSPRNG: the
/// caller supplies the bytes, this supplies the encoding.
pub fn verifier_from_bytes(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Constant-time equality for the OAuth `state` parameter.
///
/// The redirect's `state` is attacker-influenced, so comparing it with `==`
/// leaks its prefix through timing. The comparison runs over the full length of
/// both inputs regardless of where they first differ.
///
/// Lengths are compared in the clear: `state` has a fixed length that is not
/// secret.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        // The `black_box` is what keeps the loop constant-time rather than
        // merely appearing to be. Accumulating with `|=` is correct as written,
        // but nothing in the language stops an optimiser from noticing that a
        // non-zero accumulator can never return to zero and leaving the loop
        // early -- which would put the timing signal straight back. Keeping
        // `diff` opaque on every iteration denies it that reasoning.
        //
        // `black_box` is a hint and not a guarantee, but it is the only barrier
        // the standard library offers, and this crate may not take a dependency
        // on one that does better. The cost is a few nanoseconds on a
        // comparison that runs once per login.
        diff = core::hint::black_box(diff | (x ^ y));
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7636, Appendix B.
    const RFC_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    #[test]
    fn matches_the_rfc_7636_test_vector() {
        assert_eq!(challenge_s256(RFC_VERIFIER), RFC_CHALLENGE);
    }

    #[test]
    fn the_rfc_vector_is_itself_a_valid_verifier() {
        assert!(is_valid_verifier(RFC_VERIFIER));
        assert_eq!(RFC_VERIFIER.len(), MIN_VERIFIER_LEN);
    }

    #[test]
    fn the_challenge_is_unpadded_base64url() {
        let challenge = challenge_s256(RFC_VERIFIER);
        assert!(!challenge.contains('='), "must not be padded");
        assert!(!challenge.contains('+') && !challenge.contains('/'), "must be url-safe");
        // 32 digest bytes encode to 43 characters without padding.
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn derivation_is_deterministic() {
        assert_eq!(challenge_s256("abc"), challenge_s256("abc"));
        assert_ne!(challenge_s256("abc"), challenge_s256("abd"));
    }

    #[test]
    fn verifier_length_bounds_are_enforced() {
        let too_short = "a".repeat(MIN_VERIFIER_LEN - 1);
        let shortest = "a".repeat(MIN_VERIFIER_LEN);
        let longest = "a".repeat(MAX_VERIFIER_LEN);
        let too_long = "a".repeat(MAX_VERIFIER_LEN + 1);

        assert!(!is_valid_verifier(&too_short));
        assert!(is_valid_verifier(&shortest));
        assert!(is_valid_verifier(&longest));
        assert!(!is_valid_verifier(&too_long));
        assert!(!is_valid_verifier(""));
    }

    #[test]
    fn verifier_charset_is_enforced() {
        let base = "a".repeat(MIN_VERIFIER_LEN - 1);
        for allowed in ['-', '.', '_', '~', 'Z', '9'] {
            assert!(is_valid_verifier(&format!("{base}{allowed}")), "rejected {allowed}");
        }
        for rejected in ['+', '/', '=', ' ', '%', '\n'] {
            assert!(!is_valid_verifier(&format!("{base}{rejected}")), "accepted {rejected}");
        }
    }

    #[test]
    fn thirty_two_bytes_encode_to_the_minimum_length_verifier() {
        let bytes = [0x2au8; VERIFIER_ENTROPY_BYTES];
        let verifier = verifier_from_bytes(&bytes);
        assert_eq!(verifier.len(), MIN_VERIFIER_LEN);
        assert!(is_valid_verifier(&verifier));
    }

    #[test]
    fn challenges_starting_with_a_url_safe_symbol_are_rejected() {
        assert!(!is_acceptable_challenge("-abc"));
        assert!(!is_acceptable_challenge("_abc"));
        assert!(!is_acceptable_challenge(""));
        assert!(is_acceptable_challenge("Eabc"));
        assert!(is_acceptable_challenge("9abc"));
        assert!(is_acceptable_challenge(RFC_CHALLENGE));
    }

    #[test]
    fn rejection_sampling_finds_a_usable_verifier_quickly() {
        // Stands in for the generator loop in prick-auth: about 3% of inputs
        // are rejected, so a handful of tries always suffices. Deterministic
        // input, because this crate has no randomness.
        let usable = (0u32..64)
            .map(|i| {
                let mut bytes = [0u8; VERIFIER_ENTROPY_BYTES];
                bytes[..4].copy_from_slice(&i.to_be_bytes());
                verifier_from_bytes(&bytes)
            })
            .find(|v| is_usable_verifier(v));

        assert!(usable.is_some(), "no usable verifier in 64 tries");
    }

    #[test]
    fn some_verifiers_really_do_produce_rejected_challenges() {
        // Pins the reason the loop exists. If this ever finds none, the search
        // space or the encoder changed and the quirk handling needs revisiting.
        let rejected = (0u32..4096).find(|i| {
            let mut bytes = [0u8; VERIFIER_ENTROPY_BYTES];
            bytes[..4].copy_from_slice(&i.to_be_bytes());
            !is_acceptable_challenge(&challenge_s256(&verifier_from_bytes(&bytes)))
        });

        assert!(rejected.is_some(), "expected at least one rejected challenge in 4096 tries");
    }

    #[test]
    fn constant_time_eq_agrees_with_equality() {
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("abc", ""));
        assert!(!constant_time_eq("Abc", "abc"));
    }

    #[test]
    fn constant_time_eq_finds_a_difference_wherever_it_falls() {
        // The barrier in the accumulate loop is invisible to a functional test;
        // what a test can pin is that the loop still reports a difference in
        // the last position, where an early-exiting comparison would have run
        // longest, as readily as one in the first.
        let base = "s".repeat(64);
        for i in [0usize, 31, 63] {
            let mut other = base.clone();
            other.replace_range(i..=i, "t");
            assert!(!constant_time_eq(&base, &other), "missed a difference at {i}");
        }
        assert!(constant_time_eq(&base, &base));
    }

    #[test]
    fn constant_time_eq_compares_bytes_not_characters() {
        // `state` is compared exactly as the redirect delivered it. Two values
        // of equal byte length that differ only inside a multi-byte code point
        // must still compare unequal.
        assert!(constant_time_eq("→←↑", "→←↑"));
        assert!(!constant_time_eq("→←↑", "→←↓"));
    }

    #[test]
    fn method_is_s256_not_plain() {
        assert_eq!(METHOD, "S256");
    }
}
