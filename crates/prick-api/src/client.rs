//! The HTTP transport.
//!
//! # Status
//!
//! Skeleton. [`Client`] holds the configuration and hands out routes; it does
//! not yet make requests.
//!
//! TODO, in order:
//!
//! 1. Build a `reqwest::Client` with rustls + ring and
//!    `rustls-platform-verifier`, a per-request `X-Request-Id`, and the
//!    configured timeout.
//! 2. `send()`: **check the status before touching the body.** Map the status
//!    through [`prick_core::classify::ErrorKind::from_status`] and the
//!    transport failure through [`crate::error::Transport`]. Deserialising
//!    first is the direct cause of the "undescriptive error when the server is
//!    unreachable" class of bug.
//! 3. Attach credentials: a bearer token from `prick-auth`, or the
//!    `CF-Access-Client-Id` / `CF-Access-Client-Secret` header pair for a
//!    service token. Never both.
//! 4. Transparent token refresh on a single 401, then retry once. The
//!    15-minute Access session must be invisible to the user.
//! 5. Retry with jittered backoff for the kinds where
//!    [`prick_core::classify::ErrorKind::is_retryable`] holds. Writes that may
//!    have partially applied are excluded by that predicate already.
//!
//! No CORS handling and no cookie jar: this client is not a browser, and a
//! cookie store would be a place for a session to persist unaudited.

use crate::config::Config;

/// A configured API client.
#[derive(Debug, Clone)]
pub struct Client {
    config: Config,
}

impl Client {
    /// Builds a client from a configuration.
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// The configuration this client was built with.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The absolute URL for a route, with every segment percent-encoded.
    pub fn url(&self, segments: &[&str]) -> String {
        self.config.url(segments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_builds_encoded_routes_from_its_config() {
        let client = Client::new(Config::new("https://prick.example.com/"));
        assert_eq!(
            client.url(&["projects", "a/b"]),
            "https://prick.example.com/api/v1/projects/a%2Fb"
        );
        assert_eq!(client.config().base_url(), "https://prick.example.com");
    }
}
