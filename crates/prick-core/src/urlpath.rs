//! Percent-encoding for URL path segments.
//!
//! Project and environment names are user-chosen and reach the API as path
//! segments. Interpolating them into a URL without encoding is how
//! `GET /projects/{name}` turns into path traversal when a name contains `/`,
//! and how an environment named `12:30` or `a b` produces a malformed request.
//!
//! Everything that builds a request path goes through [`join`]; nothing formats
//! a URL with `format!` directly.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// Everything except the RFC 3986 unreserved set `A-Z a-z 0-9 - . _ ~`.
///
/// This is deliberately stricter than the `pchar` grammar a path segment
/// technically allows. Encoding `:`, `@`, `!`, `$`, `&`, `'`, `(`, `)`, `*`,
/// `+`, `,`, `;`, `=` costs three bytes each and removes any question about how
/// a proxy, a router, or a log parser in between will read them.
const PATH_SEGMENT: &AsciiSet =
    &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// Percent-encodes a single path segment.
///
/// The result never contains `/`, so an encoded name cannot escape its position
/// in the path. It can still *be* `.` or `..`, since `.` is unreserved and
/// therefore passes through unchanged -- use [`is_usable_segment`] to reject
/// those as names. This function guarantees only that one name occupies exactly
/// one segment.
pub fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, PATH_SEGMENT).to_string()
}

/// Joins a base URL and a sequence of path segments, encoding each segment.
///
/// A trailing slash on `base` is normalised away, so `join("https://x/api/v1/",
/// &["projects"])` and `join("https://x/api/v1", &["projects"])` agree.
///
/// Empty segments are skipped rather than producing `//`, which some routers
/// normalise and others do not.
pub fn join(base: &str, segments: &[&str]) -> String {
    let mut out = String::with_capacity(base.len() + segments.len() * 16);
    out.push_str(base.trim_end_matches('/'));

    for segment in segments {
        if segment.is_empty() {
            continue;
        }
        out.push('/');
        out.push_str(&encode_segment(segment));
    }

    out
}

/// Whether a name is safe to use as a path segment at all.
///
/// Encoding handles every character, but `.` and `..` remain dangerous as
/// *whole segments* because they are resolved by the path grammar itself rather
/// than by any character rule. Names are rejected, not mangled.
pub fn is_usable_segment(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreserved_characters_pass_through() {
        assert_eq!(encode_segment("simple-name_1.0~x"), "simple-name_1.0~x");
    }

    #[test]
    fn slashes_cannot_escape_a_segment() {
        assert_eq!(encode_segment("a/b"), "a%2Fb");
        assert_eq!(encode_segment("../../etc/passwd"), "..%2F..%2Fetc%2Fpasswd");
    }

    #[test]
    fn colons_in_environment_names_are_encoded() {
        // The counterpart to the scope parser: `eu:west` is a legal name and
        // must survive the round trip to the server.
        assert_eq!(encode_segment("eu:west"), "eu%3Awest");
        assert_eq!(encode_segment("12:30"), "12%3A30");
    }

    #[test]
    fn spaces_and_query_delimiters_are_encoded() {
        assert_eq!(encode_segment("a b"), "a%20b");
        assert_eq!(encode_segment("a?b#c"), "a%3Fb%23c");
        assert_eq!(encode_segment("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_segment("%"), "%25");
    }

    #[test]
    fn already_encoded_input_is_encoded_again_rather_than_trusted() {
        // Double-encoding is the safe failure: the server sees a name that does
        // not exist, instead of a smuggled `/`.
        assert_eq!(encode_segment("a%2Fb"), "a%252Fb");
    }

    #[test]
    fn non_ascii_becomes_utf8_percent_escapes() {
        assert_eq!(encode_segment("café"), "caf%C3%A9");
        assert_eq!(encode_segment("日本"), "%E6%97%A5%E6%9C%AC");
    }

    #[test]
    fn join_builds_an_encoded_path() {
        assert_eq!(
            join("https://prick.example.com/api/v1", &["projects", "eu:west", "secrets"]),
            "https://prick.example.com/api/v1/projects/eu%3Awest/secrets"
        );
    }

    #[test]
    fn join_normalises_a_trailing_slash_on_the_base() {
        let with = join("https://x/api/v1/", &["projects"]);
        let without = join("https://x/api/v1", &["projects"]);
        assert_eq!(with, without);
        assert_eq!(with, "https://x/api/v1/projects");
    }

    #[test]
    fn join_skips_empty_segments() {
        assert_eq!(join("https://x", &["a", "", "b"]), "https://x/a/b");
        assert_eq!(join("https://x", &[]), "https://x");
    }

    #[test]
    fn dot_segments_are_rejected_as_names_rather_than_encoded() {
        assert!(!is_usable_segment("."));
        assert!(!is_usable_segment(".."));
        assert!(!is_usable_segment(""));
        assert!(is_usable_segment("...."));
        assert!(is_usable_segment("production"));
    }
}
