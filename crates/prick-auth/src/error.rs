//! Why authentication failed.
//!
//! # Exit codes come from the shared taxonomy
//!
//! Every variant maps onto a [`prick_core::classify::ErrorKind`] rather than
//! inventing a code. That table is part of the CLI's contract -- scripts branch
//! on it -- so a second, parallel numbering would be a way for `prk login` and
//! `prk secrets get` to disagree about what "not authenticated" means.
//!
//! In particular [`AuthError::AuthExpired`] exits **3**, not 2. Code 2 is the
//! argument parser's usage error, and a script that could not tell "your
//! session expired, run `prk login`" from "you typed the command wrong" would
//! retry the wrong thing forever.

use prick_core::classify::ErrorKind;

/// The dashboard path an operator has to visit to turn managed OAuth on.
///
/// Named exactly, because "enable it in the dashboard" is not an instruction --
/// and named as the dashboard CURRENTLY reads. The setting used to sit under
/// "Authentication > OIDC/OAuth Provider"; it is now a tab of its own on the
/// application's "Additional settings" page, and an operator following the old
/// path finds no such section and reasonably concludes the feature is missing.
///
/// The toggle also does not take effect until the page is SAVED, which is worth
/// saying out loud: every other control on that screen is a switch, so a switch
/// that needs a separate Save reads as already applied.
pub const MANAGED_OAUTH_SETTING: &str = "Zero Trust > Access > Applications > (your application) > Additional settings > \
     OAuth > Managed OAuth, then Save";

/// The RFC 8707 error code for a resource the authorization server will not
/// mint a token for.
///
/// Named because the generic advice for a denied login -- log in again, or use
/// a service token -- is wrong for this one. Neither does anything about a
/// resource indicator the server does not recognise.
pub const INVALID_TARGET: &str = "invalid_target";

/// A failure during authentication.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum AuthError {
    /// The application is behind Access, but managed OAuth is not enabled on
    /// it, so there is no authorization server to talk to.
    #[error(
        "this application is protected by Cloudflare Access, but managed OAuth is not enabled \
         on it, so `prk login` has no authorization server to use"
    )]
    ManagedOAuthDisabled,

    /// A discovery document was missing, unreadable, or did not contain the
    /// endpoint it is required to.
    #[error("could not discover the authorization server: {reason}")]
    Discovery {
        /// What was missing or malformed. Never a response body.
        reason: String,
    },

    /// Dynamic client registration was refused.
    #[error("the authorization server refused to register a client: {reason}")]
    Registration {
        /// What the server said, from its typed error fields only.
        reason: String,
    },

    /// The `state` in the redirect did not match the one that was sent.
    ///
    /// Either a cross-site request forgery attempt or a stale browser tab. The
    /// two are indistinguishable from here, and both mean the same thing: this
    /// redirect does not belong to this login.
    #[error("the login response did not match this login attempt and was discarded")]
    StateMismatch,

    /// The authorization server redirected back with an error.
    #[error("the authorization server refused the login: {error}")]
    Denied {
        /// The RFC 6749 error code, such as `access_denied`.
        error: String,
    },

    /// The stored session can no longer be refreshed.
    ///
    /// The typed outcome of `invalid_grant` from the token endpoint. The
    /// refresh token has been revoked, has expired, or belongs to a client
    /// registration the server has forgotten.
    #[error("the stored session has expired and could not be renewed")]
    AuthExpired,

    /// No credential was available at all.
    #[error("no credentials were found for {api_url}")]
    NoCredential {
        /// The server that was being addressed.
        api_url: String,
    },

    /// The browser round trip did not complete in time.
    #[error("the browser did not complete the login within {seconds} seconds")]
    LoginTimeout {
        /// How long was waited.
        seconds: u64,
    },

    /// A browser could not be opened.
    #[error("could not open a browser: {reason}")]
    Browser {
        /// What the platform reported.
        reason: String,
    },

    /// The token store could not be read or written.
    #[error("could not {operation} the token store at {path}: {source}")]
    Store {
        /// What was being attempted, as a verb phrase.
        operation: &'static str,
        /// The path involved.
        path: String,
        /// The underlying failure.
        source: std::io::Error,
    },

    /// The requested storage backend is not available in this build.
    #[error("the `{backend}` token storage backend is not available in this build")]
    StorageUnavailable {
        /// The backend that was asked for.
        backend: &'static str,
    },

    /// A request failed.
    #[error(transparent)]
    Api(#[from] prick_api::ApiError),

    /// Something below the handshake failed: a socket, the CSPRNG, the clock.
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl AuthError {
    /// The taxonomy entry this failure maps onto.
    pub fn kind(&self) -> ErrorKind {
        match self {
            // The session is gone and the fix is to log in again, which is
            // exactly what `Unauthenticated` means everywhere else.
            Self::AuthExpired | Self::NoCredential { .. } | Self::Denied { .. } => {
                ErrorKind::Unauthenticated
            }
            // The server is configured in a way that makes login impossible.
            // Not a credential problem, and retrying will not help.
            Self::ManagedOAuthDisabled | Self::StorageUnavailable { .. } => {
                ErrorKind::ServiceUnavailable
            }
            Self::Discovery { .. } | Self::Registration { .. } => ErrorKind::NotPrick,
            Self::StateMismatch => ErrorKind::Forbidden,
            Self::LoginTimeout { .. } => ErrorKind::Timeout,
            Self::Api(err) => err.kind(),
            Self::Browser { .. } | Self::Store { .. } | Self::Io(_) => ErrorKind::Unknown,
        }
    }

    /// The process exit code for this failure.
    pub fn exit_code(&self) -> u8 {
        self.kind().exit_code()
    }

    /// The stable machine-readable code emitted under `--json`.
    ///
    /// More specific than the taxonomy's where this crate knows more: a caller
    /// that can distinguish `AUTH_EXPIRED` from `UNAUTHENTICATED` can retry a
    /// login rather than prompting for one.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ManagedOAuthDisabled => "MANAGED_OAUTH_DISABLED",
            Self::Discovery { .. } => "DISCOVERY_FAILED",
            Self::Registration { .. } => "REGISTRATION_FAILED",
            Self::StateMismatch => "STATE_MISMATCH",
            Self::Denied { .. } => "LOGIN_DENIED",
            Self::AuthExpired => "AUTH_EXPIRED",
            Self::NoCredential { .. } => "NO_CREDENTIAL",
            Self::LoginTimeout { .. } => "LOGIN_TIMEOUT",
            Self::Browser { .. } => "BROWSER_FAILED",
            Self::Store { .. } => "TOKEN_STORE_FAILED",
            Self::StorageUnavailable { .. } => "STORAGE_UNAVAILABLE",
            Self::Api(err) => err.kind().code(),
            Self::Io(_) => "IO_ERROR",
        }
    }

    /// The actionable next step.
    ///
    /// `&'static str` rather than a formatted `String`, so the hint reaches the
    /// binary's structured help channel unchanged. The one hint that would want
    /// interpolation -- the dashboard path -- is spelled out as a literal
    /// instead, and a test pins it against [`MANAGED_OAUTH_SETTING`] so the two
    /// cannot drift.
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::ManagedOAuthDisabled => Some(
                "Enable it at: Zero Trust > Access > Applications > (your application) > \
                 Additional settings > OAuth > Managed OAuth, then Save",
            ),
            Self::AuthExpired => Some("Run `prk login <url>` again to start a new session."),
            Self::NoCredential { .. } => Some(
                "Run `prk login <url>`, or set PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET \
                 for a service token.",
            ),
            Self::StateMismatch => Some(
                "Close any other login tabs and run `prk login <url>` again. A redirect from a \
                 previous attempt cannot be used.",
            ),
            Self::LoginTimeout { .. } => Some(
                "Run `prk login <url>` again and complete the sign-in in the browser window it \
                 opens.",
            ),
            Self::Browser { .. } => Some(
                "Open the printed URL manually. On a headless machine, use a service token \
                 instead: PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET.",
            ),
            Self::StorageUnavailable { .. } => {
                Some("Use the default file storage: `prk login <url> --storage file`.")
            }
            Self::Store { .. } => Some(
                "Check that the configuration directory is writable, or set PRK_CONFIG_DIR to \
                 somewhere it is.",
            ),
            // RFC 8707. `prk` names the resource the server's own metadata
            // declared, so being refused for it means the metadata and the
            // Access application disagree about what this hostname is.
            Self::Denied { error } if error == INVALID_TARGET => Some(
                "The authorization server did not accept the resource this server's metadata                  names. Check that the URL you passed is the hostname of the Access application                  in front of it.",
            ),
            Self::Api(err) => err.hint(),
            Self::Discovery { .. }
            | Self::Registration { .. }
            | Self::Denied { .. }
            | Self::Io(_) => self.kind().hint(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_session_is_an_authentication_failure_not_a_usage_error() {
        let err = AuthError::AuthExpired;
        assert_eq!(err.kind(), ErrorKind::Unauthenticated);
        // Code 2 belongs to the argument parser. A script must be able to tell
        // "log in again" from "you typed that wrong".
        assert_eq!(err.exit_code(), 3);
        assert_ne!(err.exit_code(), prick_core::classify::EXIT_USAGE);
        assert_eq!(err.code(), "AUTH_EXPIRED");
        assert!(err.hint().is_some_and(|hint| hint.contains("prk login")));
    }

    #[test]
    fn managed_oauth_being_off_names_the_exact_setting() {
        let err = AuthError::ManagedOAuthDisabled;
        let hint = err.hint().expect("this failure must be actionable");
        assert!(hint.contains("Zero Trust"), "{hint}");
        assert!(hint.contains("Access"), "{hint}");
        assert!(hint.contains("Applications"), "{hint}");
        // Case-insensitive: the hint spells the toggle the way the dashboard
        // labels it ("Managed OAuth"), and matching that label is the whole
        // point of naming a path. The assertion is about the feature being
        // named, not about its capitalisation.
        assert!(hint.to_lowercase().contains("managed oauth"), "{hint}");
        // The hint is a literal so that it can be `&'static str`. This keeps
        // that literal honest against the documented path rather than trusting
        // two copies of the same sentence to stay in step.
        assert!(hint.ends_with(MANAGED_OAUTH_SETTING), "{hint}");
    }

    #[test]
    fn no_failure_can_report_success() {
        let failures = [
            AuthError::ManagedOAuthDisabled,
            AuthError::Discovery { reason: "no token endpoint".to_owned() },
            AuthError::Registration { reason: "refused".to_owned() },
            AuthError::StateMismatch,
            AuthError::Denied { error: "access_denied".to_owned() },
            AuthError::AuthExpired,
            AuthError::NoCredential { api_url: "https://x".to_owned() },
            AuthError::LoginTimeout { seconds: 300 },
            AuthError::Browser { reason: "no display".to_owned() },
            AuthError::StorageUnavailable { backend: "keyring" },
        ];

        for err in &failures {
            assert_ne!(err.exit_code(), 0, "{err} claimed success");
            assert!(!err.code().is_empty());
        }
    }

    #[test]
    fn machine_codes_are_unique() {
        let mut codes = vec![
            AuthError::ManagedOAuthDisabled.code(),
            AuthError::Discovery { reason: String::new() }.code(),
            AuthError::Registration { reason: String::new() }.code(),
            AuthError::StateMismatch.code(),
            AuthError::Denied { error: String::new() }.code(),
            AuthError::AuthExpired.code(),
            AuthError::NoCredential { api_url: String::new() }.code(),
            AuthError::LoginTimeout { seconds: 0 }.code(),
            AuthError::Browser { reason: String::new() }.code(),
            AuthError::StorageUnavailable { backend: "keyring" }.code(),
        ];
        codes.sort_unstable();
        let total = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), total, "two failures share a machine code");
    }

    #[test]
    fn a_state_mismatch_is_refused_rather_than_explained_away() {
        let err = AuthError::StateMismatch;
        // Forbidden rather than Unauthenticated: the redirect was rejected on
        // purpose, and retrying the same one will be rejected again.
        assert_eq!(err.kind(), ErrorKind::Forbidden);
        assert!(err.to_string().contains("discarded"));
    }

    #[test]
    fn an_api_failure_keeps_the_transports_own_classification() {
        let err = AuthError::Api(prick_api::ApiError::new(ErrorKind::Unreachable, "no route"));
        assert_eq!(err.kind(), ErrorKind::Unreachable);
        assert_eq!(err.exit_code(), 7);
        assert_eq!(err.code(), "UNREACHABLE");
    }

    #[test]
    fn a_refused_resource_is_not_answered_with_log_in_again() {
        // What `prk login` printed before the `resource` parameter was sent:
        // "run `prk login`, or set a service token", to someone who had just
        // run `prk login`. Neither is the fix for `invalid_target`.
        let err = AuthError::Denied { error: INVALID_TARGET.to_owned() };
        let hint = err.hint().expect("this failure must be actionable");
        assert!(hint.contains("resource"), "{hint}");
        assert!(!hint.contains("PRK_ACCESS_CLIENT_ID"), "{hint}");

        // Every other denial keeps the generic advice.
        let other = AuthError::Denied { error: "access_denied".to_owned() };
        assert_ne!(other.hint(), err.hint());
    }

    #[test]
    fn no_message_can_carry_a_token() {
        // Every variant's payload is a code, a path, a duration or a reason
        // string this crate wrote. None of them is ever populated from a
        // response body or a secret.
        let err = AuthError::Denied { error: "access_denied".to_owned() };
        assert_eq!(err.to_string(), "the authorization server refused the login: access_denied");
    }
}
