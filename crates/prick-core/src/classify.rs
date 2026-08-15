//! The error taxonomy: a closed set of failure kinds, each with a hint and an
//! exit code.
//!
//! # Why a taxonomy rather than a message
//!
//! "Request failed" tells an operator nothing. The two most common real
//! failures -- the server is not reachable, and the CLI is pointed at the wrong
//! URL -- are indistinguishable from a generic message, and both have specific
//! fixes. So every failure is classified into an [`ErrorKind`], and the kind
//! carries the fix in [`ErrorKind::hint`], rendered through the binary's
//! structured help channel.
//!
//! Classification also has to survive a server that is not this server at all.
//! Deserialising the response body **before** checking the status is how a
//! proxy's HTML error page becomes an unreadable JSON parse error instead of
//! "the URL you configured is not a prick server". [`ErrorKind::NotPrick`]
//! exists for exactly that case, and the API client must check status first.
//!
//! This module is pure: it maps status codes and pre-classified transport
//! outcomes to kinds. Producing a transport outcome requires a socket, so that
//! lives in `prick-api`.

use std::fmt;

/// A classified failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorKind {
    /// No credentials, or they have expired and could not be refreshed.
    Unauthenticated,
    /// Authenticated, but not granted the role this operation needs.
    Forbidden,
    /// The project, environment, secret or version does not exist.
    NotFound,
    /// A concurrent writer won; the operation can be retried.
    Conflict,
    /// The caller's `expected_rev` did not match; the state moved underneath.
    PreconditionFailed,
    /// The request was well-formed HTTP but the payload was rejected.
    Validation,
    /// The environment would exceed the per-environment secret cap.
    PayloadTooLarge,
    /// The server asked the client to slow down.
    RateLimited,
    /// The server failed internally.
    ServerError,
    /// The server is up but temporarily refusing work, or has no admins yet.
    ServiceUnavailable,
    /// DNS, connection refused, or a network with no route.
    Unreachable,
    /// The TLS handshake failed -- typically a corporate proxy with a private
    /// certificate authority the platform verifier does not trust.
    TlsFailure,
    /// The request exceeded the configured deadline.
    Timeout,
    /// Something answered, but it is not a prick server.
    NotPrick,
    /// A status the client has no specific handling for.
    Unknown,
}

impl ErrorKind {
    /// Classifies an HTTP status code.
    ///
    /// Status is inspected **before** the body is deserialised. That ordering
    /// is the whole point: a 502 from a proxy carries an HTML body, and parsing
    /// it first produces a decoding error that names nothing useful.
    pub fn from_status(status: u16) -> Self {
        match status {
            401 => Self::Unauthenticated,
            403 => Self::Forbidden,
            404 => Self::NotFound,
            409 => Self::Conflict,
            412 => Self::PreconditionFailed,
            413 => Self::PayloadTooLarge,
            422 | 400 => Self::Validation,
            429 => Self::RateLimited,
            503 => Self::ServiceUnavailable,
            500..=599 => Self::ServerError,
            _ => Self::Unknown,
        }
    }

    /// Whether retrying the identical request could plausibly succeed.
    ///
    /// Deliberately conservative: a write that may have partially applied is
    /// not listed, even when the server would tolerate a repeat.
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::Conflict
                | Self::RateLimited
                | Self::ServerError
                | Self::ServiceUnavailable
                | Self::Unreachable
                | Self::Timeout
        )
    }

    /// The actionable next step, for the structured help channel.
    ///
    /// A hint names a command to run or a setting to check. It never
    /// speculates, and it never contains a secret value.
    pub fn hint(self) -> Option<&'static str> {
        match self {
            Self::Unauthenticated => Some(
                "Run `prk login <url>`, or set PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET for a service token.",
            ),
            Self::Forbidden => Some(
                "An administrator must grant your identity a role on this scope. `prk whoami` shows the identity the server sees.",
            ),
            Self::NotFound => Some(
                "Check the spelling with `prk projects list` and `prk env list`. Names are case-sensitive and matched exactly.",
            ),
            Self::Conflict => Some("Another writer changed this environment. Re-run the command."),
            Self::PreconditionFailed => Some(
                "The environment changed after you read it. Re-read and re-apply, or drop --expected-rev to overwrite.",
            ),
            Self::PayloadTooLarge => Some(
                "An environment has a hard cap on the number of secrets. Split the workload across environments.",
            ),
            Self::RateLimited => {
                Some("Wait for the interval in the Retry-After header and try again.")
            }
            Self::ServiceUnavailable => Some(
                "The server is running but not ready. If it reports NO_ADMINS_CONFIGURED, set BOOTSTRAP_ADMINS and redeploy.",
            ),
            Self::ServerError => Some(
                "Run `prk doctor`, then quote the X-Request-Id from this error when reporting it.",
            ),
            Self::Unreachable => Some(
                "Check --api-url (or PRK_API_URL) and that the host resolves. `prk doctor` tests reachability.",
            ),
            Self::TlsFailure => Some(
                "The TLS handshake failed. Behind a corporate proxy, install its certificate authority in the OS trust store.",
            ),
            Self::Timeout => {
                Some("Increase --timeout, or check whether the network path is saturated.")
            }
            Self::NotPrick => Some(
                "The URL answered but is not a prick server. Point --api-url at the Worker's hostname, not at the web UI or a proxy.",
            ),
            Self::Validation | Self::Unknown => None,
        }
    }

    /// The process exit code for this kind.
    ///
    /// The table is part of the CLI's contract: scripts branch on it, so a
    /// value may never be reassigned to a different meaning.
    ///
    /// | Code | Meaning |
    /// |---|---|
    /// | 0 | Success |
    /// | 1 | Unclassified failure |
    /// | 2 | Usage error (emitted by the argument parser) |
    /// | 3 | Not authenticated |
    /// | 4 | Not authorized |
    /// | 5 | Not found |
    /// | 6 | Conflict or failed precondition |
    /// | 7 | Cannot reach the server |
    /// | 8 | Server error |
    /// | 9 | Output cannot be represented in the requested format |
    /// | 10 | Rate limited |
    /// | 11 | Request rejected as invalid |
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Unauthenticated => 3,
            Self::Forbidden => 4,
            Self::NotFound => 5,
            Self::Conflict | Self::PreconditionFailed => 6,
            Self::Unreachable | Self::TlsFailure | Self::Timeout | Self::NotPrick => 7,
            Self::ServerError | Self::ServiceUnavailable => 8,
            Self::RateLimited => 10,
            Self::Validation | Self::PayloadTooLarge => 11,
            Self::Unknown => 1,
        }
    }

    /// The stable machine-readable code emitted under `--json`.
    pub fn code(self) -> &'static str {
        match self {
            Self::Unauthenticated => "UNAUTHENTICATED",
            Self::Forbidden => "FORBIDDEN",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::PreconditionFailed => "PRECONDITION_FAILED",
            Self::Validation => "VALIDATION_FAILED",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::RateLimited => "RATE_LIMITED",
            Self::ServerError => "SERVER_ERROR",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            Self::Unreachable => "UNREACHABLE",
            Self::TlsFailure => "TLS_FAILURE",
            Self::Timeout => "TIMEOUT",
            Self::NotPrick => "NOT_A_PRICK_SERVER",
            Self::Unknown => "UNKNOWN",
        }
    }
}

/// Exit code for a successful run.
pub const EXIT_SUCCESS: u8 = 0;

/// Exit code for a failure with no better classification.
pub const EXIT_FAILURE: u8 = 1;

/// Exit code the argument parser uses for a usage error.
pub const EXIT_USAGE: u8 = 2;

/// Exit code for output that cannot be represented in the requested format.
///
/// Distinct from a validation failure because nothing was wrong with the
/// request: the data simply cannot be written to that format without silent
/// corruption. See [`crate::format::FormatError::UnrepresentableControl`].
pub const EXIT_UNREPRESENTABLE: u8 = 9;

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: &[ErrorKind] = &[
        ErrorKind::Unauthenticated,
        ErrorKind::Forbidden,
        ErrorKind::NotFound,
        ErrorKind::Conflict,
        ErrorKind::PreconditionFailed,
        ErrorKind::Validation,
        ErrorKind::PayloadTooLarge,
        ErrorKind::RateLimited,
        ErrorKind::ServerError,
        ErrorKind::ServiceUnavailable,
        ErrorKind::Unreachable,
        ErrorKind::TlsFailure,
        ErrorKind::Timeout,
        ErrorKind::NotPrick,
        ErrorKind::Unknown,
    ];

    #[test]
    fn statuses_map_to_their_kinds() {
        assert_eq!(ErrorKind::from_status(401), ErrorKind::Unauthenticated);
        assert_eq!(ErrorKind::from_status(403), ErrorKind::Forbidden);
        assert_eq!(ErrorKind::from_status(404), ErrorKind::NotFound);
        assert_eq!(ErrorKind::from_status(409), ErrorKind::Conflict);
        assert_eq!(ErrorKind::from_status(412), ErrorKind::PreconditionFailed);
        assert_eq!(ErrorKind::from_status(413), ErrorKind::PayloadTooLarge);
        assert_eq!(ErrorKind::from_status(422), ErrorKind::Validation);
        assert_eq!(ErrorKind::from_status(429), ErrorKind::RateLimited);
        assert_eq!(ErrorKind::from_status(503), ErrorKind::ServiceUnavailable);
    }

    #[test]
    fn unclaimed_server_errors_fall_through_to_server_error() {
        for status in [500, 501, 502, 504, 599] {
            assert_eq!(ErrorKind::from_status(status), ErrorKind::ServerError, "{status}");
        }
        // 503 is claimed by the more specific arm above it.
        assert_eq!(ErrorKind::from_status(503), ErrorKind::ServiceUnavailable);
    }

    #[test]
    fn unmapped_statuses_are_unknown_rather_than_a_wrong_guess() {
        for status in [418, 451, 100, 302] {
            assert_eq!(ErrorKind::from_status(status), ErrorKind::Unknown, "{status}");
        }
    }

    #[test]
    fn the_actionable_kinds_all_carry_a_hint() {
        // These are the ones an operator can actually do something about; a
        // missing hint here is the upstream bug this taxonomy exists to fix.
        for kind in [
            ErrorKind::Unauthenticated,
            ErrorKind::Forbidden,
            ErrorKind::NotFound,
            ErrorKind::Unreachable,
            ErrorKind::TlsFailure,
            ErrorKind::NotPrick,
            ErrorKind::ServiceUnavailable,
        ] {
            assert!(kind.hint().is_some(), "{kind} has no hint");
        }
    }

    #[test]
    fn hints_name_a_command_or_a_setting() {
        let hint = ErrorKind::Unauthenticated.hint().unwrap();
        assert!(hint.contains("prk login"));
        let hint = ErrorKind::Unreachable.hint().unwrap();
        assert!(hint.contains("--api-url"));
    }

    #[test]
    fn exit_codes_are_stable_and_nonzero() {
        for kind in ALL {
            assert_ne!(kind.exit_code(), EXIT_SUCCESS, "{kind} claimed success");
            assert_ne!(kind.exit_code(), EXIT_USAGE, "{kind} collided with the usage code");
            assert_ne!(
                kind.exit_code(),
                EXIT_UNREPRESENTABLE,
                "{kind} collided with the unrepresentable-output code"
            );
        }
        assert_eq!(ErrorKind::Unauthenticated.exit_code(), 3);
        assert_eq!(ErrorKind::Forbidden.exit_code(), 4);
        assert_eq!(ErrorKind::Unreachable.exit_code(), 7);
        assert_eq!(ErrorKind::Unknown.exit_code(), EXIT_FAILURE);
    }

    #[test]
    fn machine_codes_are_unique() {
        let mut codes: Vec<&str> = ALL.iter().map(|k| k.code()).collect();
        codes.sort_unstable();
        let count = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), count, "two kinds share a machine code");
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        assert!(ErrorKind::Conflict.is_retryable());
        assert!(ErrorKind::Timeout.is_retryable());
        assert!(ErrorKind::Unreachable.is_retryable());

        assert!(!ErrorKind::Unauthenticated.is_retryable());
        assert!(!ErrorKind::Forbidden.is_retryable());
        assert!(!ErrorKind::Validation.is_retryable());
        assert!(!ErrorKind::PreconditionFailed.is_retryable());
        assert!(!ErrorKind::NotPrick.is_retryable());
    }
}
