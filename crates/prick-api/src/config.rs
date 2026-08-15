//! Everything a request needs that is not a route.

use std::time::Duration;

/// The default request deadline, applied when `--timeout` is not given.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The API version prefix. Versioned from day one so a breaking change has
/// somewhere to go that is not a flag day.
pub const API_PREFIX: &str = "/api/v1";

/// Connection-level settings shared by every request.
#[derive(Debug, Clone)]
pub struct Config {
    base_url: String,
    timeout: Duration,
}

impl Config {
    /// Builds a configuration from a base URL, normalising any trailing slash.
    pub fn new(base_url: impl Into<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        Self { base_url, timeout: DEFAULT_TIMEOUT }
    }

    /// Overrides the request deadline.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The origin, without a trailing slash and without the API prefix.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The request deadline.
    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Builds an absolute URL for a route, percent-encoding every segment.
    ///
    /// Routes are always built this way and never with `format!`; see
    /// [`prick_core::urlpath`] for why.
    pub fn url(&self, segments: &[&str]) -> String {
        let base = format!("{}{API_PREFIX}", self.base_url);
        prick_core::urlpath::join(&base, segments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_slashes_are_normalised_away() {
        assert_eq!(Config::new("https://x/").base_url(), "https://x");
        assert_eq!(Config::new("https://x///").base_url(), "https://x");
        assert_eq!(Config::new("https://x").base_url(), "https://x");
    }

    #[test]
    fn routes_are_encoded_not_interpolated() {
        let config = Config::new("https://prick.example.com");
        assert_eq!(
            config.url(&["projects", "eu:west", "secrets"]),
            "https://prick.example.com/api/v1/projects/eu%3Awest/secrets"
        );
    }

    #[test]
    fn the_default_timeout_is_applied_and_overridable() {
        let config = Config::new("https://x");
        assert_eq!(config.timeout(), DEFAULT_TIMEOUT);
        assert_eq!(config.with_timeout(Duration::from_secs(5)).timeout(), Duration::from_secs(5));
    }
}
