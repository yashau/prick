//! Reading a response in the order that produces a useful error.
//!
//! # The ordering is the whole point
//!
//! The defect this module exists to prevent is one line: parsing the body
//! before checking the status. When the server is unreachable and a proxy
//! answers with an HTML error page, the JSON decoder is the first thing to
//! fail, and the user is told `SyntaxError: Unexpected token '<'`. That message
//! names nothing that can be acted on, and it is indistinguishable from a
//! genuine schema mismatch.
//!
//! So the order here is fixed, and each step can conclude on its own:
//!
//! 1. **Transport.** No status exists yet. DNS, connection refused, TLS,
//!    deadline. Handled in [`crate::client`], because producing one needs a
//!    socket.
//! 2. **Status, content type and the Cloudflare headers.** Everything in this
//!    module. A `302` to `*.cloudflareaccess.com`, a `401` carrying
//!    `WWW-Authenticate`, a `403` with `cf-mitigated`, a `530` with a
//!    `cf-ray` -- each has a different fix and none of them is a schema
//!    problem.
//! 3. **Only then**, parse.
//!
//! # What is retained from the body
//!
//! From a response that does not claim to be JSON, the only thing kept is the
//! HTML `<title>`, truncated to [`TITLE_CAP`]. A Cloudflare error page puts the
//! error number there -- `1033`, `1016`, `530` -- which is exactly the fact an
//! operator needs and is the only part of the page that is. Such a body is read
//! no further than [`NON_JSON_BODY_CAP`], because nothing past the `<head>` is
//! ever looked at.
//!
//! Nothing else survives. The body is never echoed, never logged and never
//! attached to an error, because a response body from a secrets manager may
//! contain a secret and this code cannot tell.
//!
//! # Why there are two caps
//!
//! A cap on an unknown body is an allocation bound and should be tight. A cap
//! on this server's own answer is a different quantity entirely: it must be at
//! least as large as the largest document the server can be made to produce, or
//! writes the server accepts one at a time add up to a read the client refuses.
//! One number cannot be both, so [`BODY_CAP`] is derived from the server's own
//! limits and [`NON_JSON_BODY_CAP`] stays small.

use std::fmt::Write as _;

use prick_core::classify::ErrorKind;
use prick_core::keyname::MAX_KEY_LEN;

/// The most of a response body that is ever read when the response does not
/// claim to be JSON.
///
/// Enough for the whole of a Cloudflare error page, and for the `<head>` of any
/// login or captive-portal page that puts its diagnosis in a `<title>`. Nothing
/// else is ever taken from such a body, so reading further would buy nothing.
pub const NON_JSON_BODY_CAP: usize = 64 * 1024;

/// The server's cap on one decrypted secret value, in UTF-8 bytes.
///
/// Mirrors `SECRET_VALUE_MAX_BYTES` in `packages/shared/src/limits.ts`, which a
/// deployment may lower through the `SECRET_MAX_BYTES` variable. Lowering it
/// only leaves [`BODY_CAP`] more generous than it needs to be, which is the
/// safe direction: a cap can be too large without anything breaking.
pub const SERVER_SECRET_VALUE_CAP: usize = 64 * 1024;

/// The server's cap on how many secrets one environment may hold.
///
/// Mirrors `ENV_MAX_SECRETS` in `packages/shared/src/limits.ts`, and is
/// likewise a default a deployment may lower.
pub const SERVER_ENV_SECRET_CAP: usize = 500;

/// How much JSON string escaping is allowed to expand a secret value.
///
/// A serialiser writes a control byte as `\u00XX` -- six bytes for one -- and a
/// quote or a backslash as two. Two covers every value except one made mostly
/// of control characters, and such a value cannot be written to a `.env` file
/// at all, so an export of it is not the thing to size the buffer around.
const ESCAPE_ALLOWANCE: usize = 2;

/// The bytes of JSON around one entry of an export: `"":"",`.
const ENTRY_FRAMING: usize = 6;

/// The most of a JSON response body that is ever read.
///
/// Derived, not chosen. The largest document this server can produce is a
/// whole-environment export: [`SERVER_ENV_SECRET_CAP`] entries, each a key of
/// at most [`prick_core::keyname::MAX_KEY_LEN`] bytes and a value of at most
/// [`SERVER_SECRET_VALUE_CAP`] before escaping, plus the enclosing braces.
///
/// The defect this derivation exists to prevent is a cap *below* what the
/// server accepts. The server takes each secret on its own merits, so a handful
/// of writes it is right to accept can leave an environment whose read-back the
/// client refuses -- and that environment is then unexportable and unrunnable
/// while writes to it keep succeeding. Tying the number to the server's own
/// limits is what makes that state unreachable.
///
/// It is still a bound: a hostile or broken server cannot make the client
/// allocate without end, and the buffer only ever grows to the body actually
/// received, so an ordinary response of a few kilobytes costs a few kilobytes.
pub const BODY_CAP: usize = SERVER_ENV_SECRET_CAP
    * (MAX_KEY_LEN + SERVER_SECRET_VALUE_CAP * ESCAPE_ALLOWANCE + ENTRY_FRAMING)
    + 2;

/// The most of an extracted `<title>` that is ever retained.
pub const TITLE_CAP: usize = 200;

/// The hostname suffix Cloudflare Access redirects to for an interactive login.
pub const ACCESS_HOST_SUFFIX: &str = ".cloudflareaccess.com";

/// What a response said about itself, before anything tried to parse it.
///
/// Deliberately not the response body. Every field here is either a status
/// code or a header a proxy sets, none of which can carry a secret.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ResponseFacts {
    /// The HTTP status code.
    pub status: u16,
    /// The `Content-Type` header, lowercased, without parameters.
    pub content_type: Option<String>,
    /// Cloudflare's per-request identifier. Its presence proves a Cloudflare
    /// edge answered, which is what distinguishes an origin error from an edge
    /// error.
    pub cf_ray: Option<String>,
    /// Set by Cloudflare when a security product intercepted the request.
    pub cf_mitigated: Option<String>,
    /// Present on a `401`. Managed OAuth puts the discovery URL here.
    pub www_authenticate: Option<String>,
    /// The redirect target, when there is one.
    pub location: Option<String>,
    /// The server's `X-Request-Id`, for locating the audit row.
    pub request_id: Option<String>,
    /// The HTML `<title>`, if the body had one within [`NON_JSON_BODY_CAP`].
    pub title: Option<String>,
    /// Whether the body was longer than the cap that applied to it and was cut
    /// short. See [`body_cap`].
    pub truncated: bool,
}

impl ResponseFacts {
    /// Whether the response claims to be JSON.
    pub fn is_json(&self) -> bool {
        self.content_type.as_deref().is_some_and(|value| {
            value == "application/json"
                || value.ends_with("+json")
                || value.starts_with("application/json")
        })
    }

    /// Whether the response claims to be HTML.
    pub fn is_html(&self) -> bool {
        self.content_type.as_deref().is_some_and(|value| value.starts_with("text/html"))
    }

    /// Whether a Cloudflare edge answered.
    pub fn from_cloudflare(&self) -> bool {
        self.cf_ray.is_some() || self.cf_mitigated.is_some()
    }

    /// Whether the redirect target is Cloudflare Access's login page.
    pub fn redirects_to_access(&self) -> bool {
        self.location
            .as_deref()
            .is_some_and(|location| host_of(location).is_some_and(is_access_host))
    }

    /// The Cloudflare error number named in the page title, if there is one.
    ///
    /// Cloudflare's error pages are titled things like
    /// `example.com | 1033: Argo Tunnel error`. The number is the only
    /// actionable part, and each one has a distinct cause.
    pub fn cloudflare_error_code(&self) -> Option<u16> {
        let title = self.title.as_deref()?;
        let bytes = title.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index].is_ascii_digit() {
                let start = index;
                while index < bytes.len() && bytes[index].is_ascii_digit() {
                    index += 1;
                }
                // 1000-1199 are Cloudflare's own error numbers: 10xx for the
                // edge and the origin, 11xx for Workers.
                if index - start == 4
                    && let Ok(code) = title.get(start..index)?.parse::<u16>()
                    && (1000..1200).contains(&code)
                {
                    return Some(code);
                }
            } else {
                index += 1;
            }
        }
        None
    }
}

/// The cap that applies to a response, decided from what it says about itself.
///
/// The content type is read from the headers, so this is known before a single
/// body byte is taken. A response claiming JSON may be a whole-environment
/// export and gets [`BODY_CAP`]; anything else is read only as far as a
/// `<title>` could be and gets [`NON_JSON_BODY_CAP`].
///
/// A hostile server can of course claim JSON. It then gets the larger of two
/// bounds, which is still a bound.
pub fn body_cap(facts: &ResponseFacts) -> usize {
    if facts.is_json() { BODY_CAP } else { NON_JSON_BODY_CAP }
}

/// The host part of a URL, without scheme, port, path or credentials.
fn host_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://").map(|(_, rest)| rest)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = authority.split_once(':').map_or(authority, |(host, _)| host);
    if host.is_empty() { None } else { Some(host) }
}

/// Whether a host belongs to Cloudflare Access.
///
/// Suffix matching on a full label, so `evil-cloudflareaccess.com` and
/// `cloudflareaccess.com.example.net` do not match.
fn is_access_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host.ends_with(ACCESS_HOST_SUFFIX)
}

/// A classified response, or `None` if it is a success worth parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    /// The taxonomy entry.
    pub kind: ErrorKind,
    /// A message naming what was observed. Never contains a response body.
    pub message: String,
}

/// Classifies a response from its facts alone.
///
/// Returns `None` when the response is a JSON success and the caller should go
/// on to deserialise it. Every other outcome is an [`ErrorKind`] with a message
/// that names what was actually seen, which is what makes the difference
/// between "request failed" and "the URL you configured is a Cloudflare Access
/// login page".
pub fn classify(facts: &ResponseFacts) -> Option<Classified> {
    let describe = |kind: ErrorKind, message: String| Some(Classified { kind, message });

    // A redirect is never a valid API response, and the interesting case is
    // that the redirect target identifies the problem exactly.
    if (300..400).contains(&facts.status) {
        if facts.redirects_to_access() {
            return describe(
                ErrorKind::Unauthenticated,
                "Cloudflare Access redirected this request to its interactive login page, so no \
                 usable credential was presented"
                    .to_owned(),
            );
        }
        let target = facts.location.as_deref().and_then(host_of).unwrap_or("an unknown host");
        return describe(
            ErrorKind::NotPrick,
            format!("the server redirected to {target}; the API never redirects"),
        );
    }

    // A Cloudflare security product intercepted the request. The status alone
    // would say 403 and nothing else.
    //
    // `Mitigated`, not `Forbidden`: this is checked BEFORE the 403 arm below
    // for the same reason it has its own kind at all -- an edge challenge and an
    // Access denial are the same status with fixes in different systems, and
    // Forbidden's hint sends the reader to the grant table.
    if let Some(mitigation) = facts.cf_mitigated.as_deref() {
        return describe(
            ErrorKind::Mitigated,
            format!(
                "Cloudflare intercepted this request with a `{mitigation}` mitigation, so it \
                 never reached the server"
            ),
        );
    }

    // An edge error: Cloudflare answered, the origin did not.
    if let Some(code) = facts.cloudflare_error_code() {
        return describe(ErrorKind::Unreachable, cloudflare_message(code));
    }

    match facts.status {
        401 => {
            let message = if facts.www_authenticate.is_some() {
                "the server requires authentication and advertised an authorization server"
            } else {
                "the server requires authentication"
            };
            describe(ErrorKind::Unauthenticated, message.to_owned())
        }
        403 if facts.is_html() => describe(
            ErrorKind::Forbidden,
            "Cloudflare Access refused this identity; the response was its denial page rather \
             than an API error"
                .to_owned(),
        ),
        // 530 is Cloudflare's "the origin is unreachable" status. It arrives
        // without an error number in the title often enough to be worth its own
        // arm.
        530 => describe(
            ErrorKind::Unreachable,
            "Cloudflare could not reach the Worker behind this hostname".to_owned(),
        ),
        status if status >= 400 => {
            if !facts.is_json() {
                describe(
                    ErrorKind::from_status(status),
                    describe_non_json(facts, "an error response"),
                )
            } else if facts.truncated {
                // The envelope was cut off, so its code and message are gone
                // and the status is all that is left. The reason they are gone
                // is the size, and that is what to report.
                describe(ErrorKind::ResponseTooLarge, describe_over_cap())
            } else {
                // A real API error. The caller parses the envelope for the
                // server's own code and message.
                None
            }
        }
        _ if !facts.is_json() => {
            describe(ErrorKind::NotPrick, describe_non_json(facts, "a successful response"))
        }
        _ if facts.truncated => describe(ErrorKind::ResponseTooLarge, describe_over_cap()),
        _ => None,
    }
}

/// Describes a response the client stopped reading because of its size.
///
/// Names the size and nothing else. The server was reached, answered, and
/// answered correctly; the failure is that the answer does not fit, and an
/// operator sent to check `--api-url` over this would find nothing wrong with
/// it. [`ErrorKind::ResponseTooLarge`] carries the way out.
fn describe_over_cap() -> String {
    format!(
        "the response body exceeded {BODY_CAP} bytes, which is the most this client reads \
         into memory, so none of it was parsed"
    )
}

/// Describes a response whose content type is not JSON, without echoing it.
fn describe_non_json(facts: &ResponseFacts, what: &str) -> String {
    let content_type = facts.content_type.as_deref().unwrap_or("no content type");
    let mut message = format!(
        "the server returned {what} as `{content_type}` rather than JSON (HTTP {})",
        facts.status
    );
    if let Some(title) = facts.title.as_deref() {
        let _ = write!(message, "; the page is titled \"{title}\"");
    }
    message
}

/// The meaning of a Cloudflare error number.
///
/// Only the ones a self-hosted Worker behind Access can actually produce. An
/// unknown number is reported as itself rather than guessed at.
fn cloudflare_message(code: u16) -> String {
    let cause = match code {
        1000 => "the DNS record points back into Cloudflare rather than at a Worker",
        1001 => "Cloudflare could not resolve the origin",
        1016 => "the DNS record for this hostname points at nothing",
        1033 => "the tunnel serving this hostname is not connected",
        1101 => "the Worker threw an exception while handling the request",
        1102 => "the Worker exceeded its CPU time limit",
        _ => "Cloudflare reported an edge error",
    };
    format!("Cloudflare error {code}: {cause}")
}

/// Extracts an HTML `<title>` from a response body.
///
/// The only thing ever kept from a body. Truncated to [`TITLE_CAP`], collapsed
/// to single spaces, and control characters dropped, so it cannot be used to
/// smuggle escape sequences onto a terminal.
pub fn html_title(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let lowered = text.to_ascii_lowercase();

    let open = lowered.find("<title")?;
    let content_start = open + lowered.get(open..)?.find('>')? + 1;
    let content_end = content_start + lowered.get(content_start..)?.find("</title")?;

    let raw = text.get(content_start..content_end)?;
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.is_empty() {
        return None;
    }

    let mut truncated = cleaned;
    if truncated.chars().count() > TITLE_CAP {
        truncated = truncated.chars().take(TITLE_CAP).collect();
    }
    Some(truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(status: u16) -> ResponseFacts {
        ResponseFacts {
            status,
            content_type: Some("application/json".to_owned()),
            ..ResponseFacts::default()
        }
    }

    fn html(status: u16) -> ResponseFacts {
        ResponseFacts {
            status,
            content_type: Some("text/html".to_owned()),
            ..ResponseFacts::default()
        }
    }

    #[test]
    fn a_json_success_is_not_classified_as_a_failure() {
        assert_eq!(classify(&json(200)), None);
        assert_eq!(classify(&json(201)), None);
    }

    #[test]
    fn a_json_error_is_left_for_the_envelope_parser() {
        // The server's own code and message are better than anything this
        // module could infer, so a JSON error body is passed through.
        assert_eq!(classify(&json(404)), None);
        assert_eq!(classify(&json(422)), None);
    }

    #[test]
    fn an_html_two_hundred_is_not_a_prick_server() {
        // The exact case that produced `SyntaxError: Unexpected token '<'`.
        let mut facts = html(200);
        facts.title = Some("Sign in".to_owned());
        let classified = classify(&facts).expect("HTML is not a valid API response");
        assert_eq!(classified.kind, ErrorKind::NotPrick);
        assert!(classified.message.contains("text/html"));
        assert!(classified.message.contains("Sign in"));
    }

    #[test]
    fn a_redirect_to_access_is_reported_as_missing_credentials() {
        let facts = ResponseFacts {
            status: 302,
            location: Some(
                "https://example.cloudflareaccess.com/cdn-cgi/access/login/x".to_owned(),
            ),
            ..ResponseFacts::default()
        };
        let classified = classify(&facts).expect("a redirect is never a valid API response");
        assert_eq!(classified.kind, ErrorKind::Unauthenticated);
        assert!(classified.message.contains("Access"));
    }

    #[test]
    fn a_lookalike_access_host_does_not_match() {
        for location in [
            "https://evil-cloudflareaccess.com/login",
            "https://cloudflareaccess.com.example.net/login",
            "https://example.com/cloudflareaccess.com",
        ] {
            let facts = ResponseFacts {
                status: 302,
                location: Some(location.to_owned()),
                ..ResponseFacts::default()
            };
            assert!(!facts.redirects_to_access(), "{location} was wrongly treated as Access");
        }
    }

    #[test]
    fn a_real_access_host_matches_in_any_case() {
        for location in [
            "https://example.cloudflareaccess.com/x",
            "https://EXAMPLE.CLOUDFLAREACCESS.COM/x",
            "https://team.eu.cloudflareaccess.com:443/x",
        ] {
            let facts = ResponseFacts {
                status: 302,
                location: Some(location.to_owned()),
                ..ResponseFacts::default()
            };
            assert!(facts.redirects_to_access(), "{location} was not recognised");
        }
    }

    #[test]
    fn a_redirect_anywhere_else_means_the_url_is_wrong() {
        let facts = ResponseFacts {
            status: 301,
            location: Some("https://www.example.com/".to_owned()),
            ..ResponseFacts::default()
        };
        let classified = classify(&facts).expect("a redirect is never a valid API response");
        assert_eq!(classified.kind, ErrorKind::NotPrick);
        assert!(classified.message.contains("www.example.com"));
    }

    #[test]
    fn an_unauthenticated_response_says_whether_discovery_was_advertised() {
        let mut facts = html(401);
        let plain = classify(&facts).expect("401 is a failure");
        assert_eq!(plain.kind, ErrorKind::Unauthenticated);

        facts.www_authenticate = Some(
            r#"Bearer resource_metadata="https://x/.well-known/oauth-protected-resource""#
                .to_owned(),
        );
        let advertised = classify(&facts).expect("401 is a failure");
        assert!(advertised.message.contains("authorization server"));
    }

    #[test]
    fn an_access_denial_page_is_distinguished_from_an_api_forbidden() {
        let classified = classify(&html(403)).expect("403 is a failure");
        assert_eq!(classified.kind, ErrorKind::Forbidden);
        assert!(classified.message.contains("Access"));

        // A JSON 403 is the server's own authorization decision, and its
        // envelope says which grant is missing.
        assert_eq!(classify(&json(403)), None);
    }

    #[test]
    fn a_mitigated_request_names_the_mitigation() {
        let facts = ResponseFacts {
            status: 403,
            cf_mitigated: Some("challenge".to_owned()),
            cf_ray: Some("8f0c0e0a0b0c0d0e-LHR".to_owned()),
            ..ResponseFacts::default()
        };
        let classified = classify(&facts).expect("a challenge is a failure");
        assert_eq!(
            classified.kind,
            ErrorKind::Mitigated,
            "an edge challenge must not be reported as an authorization failure"
        );
        assert!(classified.message.contains("challenge"));
    }

    #[test]
    fn cloudflare_error_pages_are_read_out_of_the_title() {
        for (title, code) in [
            ("example.com | 1033: Argo Tunnel error", 1033u16),
            ("prick.example.com | 1016: Origin DNS error", 1016),
            ("Error 1101 | example.com", 1101),
        ] {
            let facts = ResponseFacts {
                status: 530,
                content_type: Some("text/html".to_owned()),
                cf_ray: Some("8f0c-LHR".to_owned()),
                title: Some(title.to_owned()),
                ..ResponseFacts::default()
            };
            assert_eq!(facts.cloudflare_error_code(), Some(code), "{title}");
            let classified = classify(&facts).expect("an edge error is a failure");
            assert_eq!(classified.kind, ErrorKind::Unreachable);
            assert!(classified.message.contains(&code.to_string()));
        }
    }

    #[test]
    fn a_530_without_a_readable_title_still_says_what_is_wrong() {
        let facts = ResponseFacts {
            status: 530,
            content_type: Some("text/html".to_owned()),
            cf_ray: Some("8f0c-LHR".to_owned()),
            ..ResponseFacts::default()
        };
        let classified = classify(&facts).expect("530 is a failure");
        assert_eq!(classified.kind, ErrorKind::Unreachable);
        assert!(classified.message.contains("Worker"));
    }

    #[test]
    fn a_four_digit_number_that_is_not_a_cloudflare_code_is_ignored() {
        let facts = ResponseFacts {
            title: Some("Order 2026 confirmed".to_owned()),
            ..ResponseFacts::default()
        };
        assert_eq!(facts.cloudflare_error_code(), None);
    }

    #[test]
    fn a_truncated_json_response_is_refused_rather_than_parsed() {
        let facts = ResponseFacts { truncated: true, ..json(200) };
        let classified = classify(&facts).expect("an over-long body is a failure");
        assert_eq!(classified.kind, ErrorKind::ResponseTooLarge);
    }

    #[test]
    fn an_over_cap_body_is_reported_as_a_size_problem_and_not_as_a_wrong_url() {
        // The server was reached and answered correctly. Reporting this as
        // `NotPrick` sends an operator to look for a proxy or a typo in
        // --api-url, and there is neither -- the environment simply holds more
        // than one response can carry.
        let classified = classify(&ResponseFacts { truncated: true, ..json(200) })
            .expect("an over-long body is a failure");

        assert_eq!(classified.kind, ErrorKind::ResponseTooLarge);
        assert!(classified.message.contains(&BODY_CAP.to_string()), "{}", classified.message);
        assert!(!classified.message.contains("api-url"), "{}", classified.message);
        assert_eq!(classified.kind.exit_code(), 12);
    }

    #[test]
    fn a_truncated_error_envelope_reports_the_size_rather_than_the_status() {
        // Nothing of the envelope survived, so its code and message are gone.
        // Saying "the server returned HTTP 500" would name the one fact that is
        // not the problem.
        let classified = classify(&ResponseFacts { truncated: true, ..json(500) })
            .expect("an over-long body is a failure");
        assert_eq!(classified.kind, ErrorKind::ResponseTooLarge);
    }

    #[test]
    fn an_error_envelope_that_fits_is_still_left_to_the_envelope_parser() {
        assert_eq!(classify(&json(422)), None);
        assert_eq!(classify(&json(500)), None);
    }

    #[test]
    fn an_over_long_html_page_is_still_the_url_being_wrong() {
        // A megabyte of HTML is not a size problem to solve; it is the proof
        // that whatever answered is not this API.
        let mut facts = html(200);
        facts.truncated = true;
        facts.title = Some("Sign in".to_owned());
        let classified = classify(&facts).expect("HTML is not a valid API response");
        assert_eq!(classified.kind, ErrorKind::NotPrick);
    }

    #[test]
    fn a_content_type_with_parameters_is_still_json() {
        let facts = ResponseFacts {
            status: 200,
            content_type: Some("application/json; charset=utf-8".to_owned()),
            ..ResponseFacts::default()
        };
        assert!(facts.is_json());
        assert_eq!(classify(&facts), None);
    }

    #[test]
    fn a_json_api_content_type_is_accepted() {
        let facts = ResponseFacts {
            status: 200,
            content_type: Some("application/problem+json".to_owned()),
            ..ResponseFacts::default()
        };
        assert!(facts.is_json());
    }

    #[test]
    fn a_missing_content_type_is_not_treated_as_json() {
        let facts = ResponseFacts { status: 200, ..ResponseFacts::default() };
        assert!(!facts.is_json());
        assert_eq!(classify(&facts).map(|c| c.kind), Some(ErrorKind::NotPrick));
    }

    #[test]
    fn a_title_is_extracted_case_insensitively_and_with_attributes() {
        assert_eq!(html_title(b"<html><head><TITLE>Hello</TITLE>"), Some("Hello".to_owned()));
        assert_eq!(html_title(br#"<title data-x="1">Sign in</title>"#), Some("Sign in".to_owned()));
    }

    #[test]
    fn a_title_spanning_lines_is_collapsed_to_one() {
        assert_eq!(
            html_title(b"<title>\n  example.com |\n  1033: error\n</title>"),
            Some("example.com | 1033: error".to_owned())
        );
    }

    #[test]
    fn a_title_cannot_smuggle_control_characters() {
        let body = b"<title>a\x1b[31mred\x07</title>";
        let title = html_title(body).expect("a title is present");
        assert!(!title.contains('\x1b'), "an escape sequence survived: {title:?}");
        assert!(!title.contains('\x07'));
    }

    #[test]
    fn a_title_is_truncated_rather_than_retained_whole() {
        let body = format!("<title>{}</title>", "x".repeat(TITLE_CAP * 3));
        let title = html_title(body.as_bytes()).expect("a title is present");
        assert_eq!(title.chars().count(), TITLE_CAP);
    }

    #[test]
    fn a_body_with_no_title_yields_nothing() {
        assert_eq!(html_title(b"{\"service\":\"prick\"}"), None);
        assert_eq!(html_title(b"<html><body>no title</body></html>"), None);
        assert_eq!(html_title(b"<title></title>"), None);
        assert_eq!(html_title(b"<title>unterminated"), None);
    }

    #[test]
    fn the_non_json_cap_is_small_enough_to_be_a_bound_and_large_enough_for_a_page() {
        assert_eq!(NON_JSON_BODY_CAP, 65_536);
        const { assert!(TITLE_CAP < NON_JSON_BODY_CAP) }
    }

    #[test]
    fn the_json_cap_is_never_smaller_than_a_whole_environment_export() {
        /// A whole environment at the server's own limits, unescaped, with the
        /// JSON framing around every entry.
        const FULL_EXPORT: usize =
            SERVER_ENV_SECRET_CAP * (MAX_KEY_LEN + SERVER_SECRET_VALUE_CAP + ENTRY_FRAMING) + 2;

        // The defect the derivation exists to prevent. Two secrets at the
        // server's own per-secret limit already exceed a flat 64 KiB, so the
        // server accepts both writes and the client then refuses to read the
        // environment back -- unexportable and unrunnable, with nothing having
        // gone wrong at the server.
        const { assert!(BODY_CAP > 2 * SERVER_SECRET_VALUE_CAP) }
        const { assert!(BODY_CAP >= FULL_EXPORT) }

        // Still a bound rather than an invitation: a body is read once, into
        // memory, so the ceiling has to stay a number a laptop can hold.
        const { assert!(BODY_CAP < 128 * 1024 * 1024) }
    }

    #[test]
    fn the_cap_that_applies_is_decided_by_what_the_response_claims_to_be() {
        assert_eq!(body_cap(&json(200)), BODY_CAP);
        assert_eq!(body_cap(&html(200)), NON_JSON_BODY_CAP);
        // No content type is not a claim of JSON, so it gets the tight bound.
        assert_eq!(
            body_cap(&ResponseFacts { status: 200, ..ResponseFacts::default() }),
            NON_JSON_BODY_CAP
        );
    }

    #[test]
    fn a_host_is_parsed_out_of_a_url_without_its_credentials_or_port() {
        assert_eq!(host_of("https://user:pass@example.com:8443/path?q=1"), Some("example.com"));
        assert_eq!(host_of("http://example.com"), Some("example.com"));
        assert_eq!(host_of("not a url"), None);
        assert_eq!(host_of("https://"), None);
    }
}
