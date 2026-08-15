//! What a request authenticates as.
//!
//! This crate does not know how to *obtain* a credential -- that is
//! `prick-auth`, which needs a browser, a CSPRNG and a token file. It only
//! knows how to present one, which keeps the dependency pointing one way and
//! keeps the OAuth handshake out of the transport.
//!
//! # Never both
//!
//! A request carries a bearer token or a service-token header pair, never both.
//! Cloudflare Access resolves the two differently, and sending both means the
//! identity the server sees depends on Access's precedence rules rather than on
//! anything this client decided.

use secrecy::{ExposeSecret as _, SecretString};

/// The request header carrying a service token's client id.
pub const HEADER_CLIENT_ID: &str = "CF-Access-Client-Id";

/// The request header carrying a service token's client secret.
pub const HEADER_CLIENT_SECRET: &str = "CF-Access-Client-Secret";

/// The header a per-request identifier is sent and echoed in.
pub const HEADER_REQUEST_ID: &str = "X-Request-Id";

/// The credential a request is made with.
///
/// `Debug` is derived, which is safe because the only secret-bearing variants
/// hold a [`SecretString`] whose own `Debug` is the redaction.
#[derive(Debug, Clone)]
pub enum Credential {
    /// No credential. Used for the pre-login probe, and for nothing else.
    Anonymous,
    /// An interactive user's Access token.
    Bearer(SecretString),
    /// A machine's Access service token.
    ServiceToken {
        /// The client id. Not secret: it is an opaque identifier that appears
        /// in the audit log as the caller's `common_name`.
        client_id: String,
        /// The client secret.
        client_secret: SecretString,
    },
}

impl Credential {
    /// The headers this credential contributes, in order.
    ///
    /// Returns owned strings rather than borrowing, so the exposed secret has a
    /// single short-lived home rather than being reachable from the credential.
    pub fn headers(&self) -> Vec<(&'static str, String)> {
        match self {
            Self::Anonymous => Vec::new(),
            Self::Bearer(token) => {
                vec![("authorization", format!("Bearer {}", token.expose_secret()))]
            }
            Self::ServiceToken { client_id, client_secret } => vec![
                (HEADER_CLIENT_ID, client_id.clone()),
                (HEADER_CLIENT_SECRET, client_secret.expose_secret().to_owned()),
            ],
        }
    }

    /// Whether a credential is present at all.
    pub fn is_present(&self) -> bool {
        !matches!(self, Self::Anonymous)
    }

    /// Whether an expired credential could be renewed without a browser.
    pub fn is_refreshable(&self) -> bool {
        matches!(self, Self::Bearer(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_anonymous_request_carries_no_credential_headers() {
        assert!(Credential::Anonymous.headers().is_empty());
        assert!(!Credential::Anonymous.is_present());
    }

    #[test]
    fn a_bearer_token_becomes_one_authorization_header() {
        let credential = Credential::Bearer(SecretString::from("tok"));
        assert_eq!(credential.headers(), [("authorization", "Bearer tok".to_owned())]);
        assert!(credential.is_present());
        assert!(credential.is_refreshable());
    }

    #[test]
    fn a_service_token_becomes_the_pair_cloudflared_uses() {
        let credential = Credential::ServiceToken {
            client_id: "abc.access".to_owned(),
            client_secret: SecretString::from("shh"),
        };
        let headers = credential.headers();
        assert_eq!(headers[0].0, "CF-Access-Client-Id");
        assert_eq!(headers[1].0, "CF-Access-Client-Secret");
        // A service token never expires, so there is nothing to refresh.
        assert!(!credential.is_refreshable());
    }

    #[test]
    fn a_credential_never_renders_its_secret_through_debug() {
        for credential in [
            Credential::Bearer(SecretString::from("hunter2")),
            Credential::ServiceToken {
                client_id: "abc.access".to_owned(),
                client_secret: SecretString::from("hunter2"),
            },
        ] {
            let rendered = format!("{credential:?}");
            assert!(!rendered.contains("hunter2"), "a secret leaked through Debug: {rendered}");
        }
    }

    #[test]
    fn the_two_kinds_are_mutually_exclusive_by_construction() {
        // There is no variant that carries both, so "never send both" is a
        // property of the type rather than a rule in the transport.
        let bearer = Credential::Bearer(SecretString::from("t")).headers();
        assert!(!bearer.iter().any(|(name, _)| *name == HEADER_CLIENT_ID));
    }
}
