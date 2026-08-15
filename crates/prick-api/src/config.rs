//! Everything a request needs that is not a route.

use std::time::Duration;

/// The default request deadline, applied when `--timeout` is not given.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The API version prefix. Versioned from day one so a breaking change has
/// somewhere to go that is not a flag day.
pub const API_PREFIX: &str = "/api/v1";

/// How many times a retryable request is tried again.
pub const DEFAULT_MAX_RETRIES: u32 = 2;

/// The first backoff interval. Doubles per attempt, with jitter.
pub const DEFAULT_RETRY_BASE: Duration = Duration::from_millis(200);

/// Connection-level settings shared by every request.
#[derive(Debug, Clone)]
pub struct Config {
    base_url: String,
    timeout: Duration,
    max_retries: u32,
    retry_base: Duration,
}

impl Config {
    /// Builds a configuration from a base URL, normalising any trailing slash.
    pub fn new(base_url: impl Into<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        Self {
            base_url,
            timeout: DEFAULT_TIMEOUT,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_base: DEFAULT_RETRY_BASE,
        }
    }

    /// Overrides the request deadline.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Overrides the retry policy.
    ///
    /// Setting `max_retries` to zero disables retrying, which is what the test
    /// suite does so a mocked failure is observed rather than smoothed over.
    #[must_use]
    pub fn with_retries(mut self, max_retries: u32, base: Duration) -> Self {
        self.max_retries = max_retries;
        self.retry_base = base;
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

    /// How many extra attempts a retryable failure gets.
    pub fn max_retries(&self) -> u32 {
        self.max_retries
    }

    /// The backoff interval for a given attempt, before jitter.
    ///
    /// Doubles per attempt and is capped, so a long deadline cannot turn a
    /// handful of retries into a wait nobody asked for.
    pub fn backoff(&self, attempt: u32) -> Duration {
        /// Beyond this the wait stops being a retry and starts being a hang.
        const CAP: Duration = Duration::from_secs(5);
        let factor = 1u32 << attempt.min(8);
        self.retry_base.saturating_mul(factor).min(CAP)
    }

    /// The `User-Agent` this client sends.
    ///
    /// Carries the version so a server-side log can tell which client produced
    /// a request. Nothing about the machine or the user is included.
    pub fn user_agent() -> String {
        format!("prk/{}", env!("CARGO_PKG_VERSION"))
    }

    /// Builds an absolute URL for a route, percent-encoding every segment.
    ///
    /// Routes are always built this way and never with `format!`; see
    /// [`prick_core::urlpath`] for why.
    ///
    /// **Everything the server serves is under this prefix**, `/health`
    /// included. The Worker routes `/api/*` to the API and everything else to
    /// the admin UI, so a path built at the origin reaches SvelteKit's 404 page
    /// rather than a route.
    pub fn url(&self, segments: &[&str]) -> String {
        let base = format!("{}{API_PREFIX}", self.base_url);
        prick_core::urlpath::join(&base, segments)
    }

    /// Builds an absolute URL for a route, with a query string.
    ///
    /// Both halves of every pair are percent-encoded, which over-encodes for a
    /// query component and is deliberate: the same conservative set is used for
    /// path segments, and nothing here needs a character it removes.
    pub fn url_with_query(&self, segments: &[&str], query: &[(&str, &str)]) -> String {
        let mut url = self.url(segments);
        for (index, (name, value)) in query.iter().enumerate() {
            url.push(if index == 0 { '?' } else { '&' });
            url.push_str(&prick_core::urlpath::encode_segment(name));
            url.push('=');
            url.push_str(&prick_core::urlpath::encode_segment(value));
        }
        url
    }

    /// Builds an absolute URL at the deployment origin, outside the API prefix.
    ///
    /// Nothing this crate calls lives there. It remains because a caller
    /// reaching the origin has no other way to build a URL that respects the
    /// configured base -- but if you are reaching for it to build an API route,
    /// you want [`Config::url`].
    pub fn root_url(&self, segments: &[&str]) -> String {
        prick_core::urlpath::join(&self.base_url, segments)
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
    fn health_lives_under_the_api_prefix_like_every_other_route() {
        // The Worker routes `/api/*` to the API and everything else to the
        // admin UI, so a probe of the origin's `/health` gets an HTML 404.
        let config = Config::new("https://prick.example.com");
        assert_eq!(config.url(&["health"]), "https://prick.example.com/api/v1/health");
    }

    #[test]
    fn a_query_string_is_encoded_rather_than_interpolated() {
        let config = Config::new("https://prick.example.com");
        assert_eq!(
            config.url_with_query(
                &["projects", "billing", "environments", "eu-west", "secrets"],
                &[("reason", "run")]
            ),
            "https://prick.example.com/api/v1/projects/billing/environments/eu-west/secrets?reason=run"
        );
        assert_eq!(
            config.url_with_query(&["x"], &[("a", "b c"), ("d", "e&f")]),
            "https://prick.example.com/api/v1/x?a=b%20c&d=e%26f"
        );
        assert_eq!(config.url_with_query(&["x"], &[]), config.url(&["x"]));
    }

    #[test]
    fn the_default_timeout_is_applied_and_overridable() {
        let config = Config::new("https://x");
        assert_eq!(config.timeout(), DEFAULT_TIMEOUT);
        assert_eq!(config.with_timeout(Duration::from_secs(5)).timeout(), Duration::from_secs(5));
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        let config = Config::new("https://x");
        assert_eq!(config.backoff(0), Duration::from_millis(200));
        assert_eq!(config.backoff(1), Duration::from_millis(400));
        assert_eq!(config.backoff(2), Duration::from_millis(800));
        assert_eq!(config.backoff(20), Duration::from_secs(5), "an unbounded wait is a hang");
    }

    #[test]
    fn retries_can_be_disabled_outright() {
        let config = Config::new("https://x").with_retries(0, Duration::ZERO);
        assert_eq!(config.max_retries(), 0);
    }

    #[test]
    fn the_user_agent_names_the_client_and_its_version() {
        let agent = Config::user_agent();
        assert!(agent.starts_with("prk/"));
        assert!(!agent.contains(' '), "a user agent with spaces is harder to grep for: {agent}");
    }
}
