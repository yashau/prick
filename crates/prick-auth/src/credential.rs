//! The two identity types and where each is discovered.

/// Environment variables carrying a service token, in precedence order.
///
/// `PRK_*` is checked first so this CLI can be configured independently, then
/// `CF_ACCESS_*` for parity with `cloudflared` -- CI that already has those set
/// works with no changes.
pub const SERVICE_TOKEN_ID_VARS: [&str; 2] = ["PRK_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID"];

/// Environment variables carrying a service token secret, in precedence order.
pub const SERVICE_TOKEN_SECRET_VARS: [&str; 2] =
    ["PRK_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET"];

/// The request header carrying a service token's client id.
pub const HEADER_CLIENT_ID: &str = "CF-Access-Client-Id";

/// The request header carrying a service token's client secret.
pub const HEADER_CLIENT_SECRET: &str = "CF-Access-Client-Secret";

/// Which kind of identity a request is being made as.
///
/// The value itself is not held here: a secret belongs in a `secrecy` wrapper
/// so that formatting it is a compile error, and this enum is `Debug` and
/// therefore formattable by definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Credential {
    /// An interactive user, authenticated through Access SSO.
    User,
    /// A machine, presenting an Access service token.
    ServiceToken,
}

impl Credential {
    /// Whether this credential can be refreshed without user interaction.
    ///
    /// A service token never expires and never needs refreshing; a user's
    /// session does, transparently.
    pub fn is_refreshable(self) -> bool {
        matches!(self, Self::User)
    }

    /// Whether obtaining this credential requires a browser.
    pub fn needs_browser(self) -> bool {
        matches!(self, Self::User)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_tokens_are_non_interactive_and_never_refresh() {
        assert!(!Credential::ServiceToken.needs_browser());
        assert!(!Credential::ServiceToken.is_refreshable());
    }

    #[test]
    fn user_sessions_refresh_transparently() {
        assert!(Credential::User.needs_browser());
        assert!(Credential::User.is_refreshable());
    }

    #[test]
    fn prk_variables_take_precedence_over_the_cloudflared_ones() {
        assert_eq!(SERVICE_TOKEN_ID_VARS[0], "PRK_ACCESS_CLIENT_ID");
        assert_eq!(SERVICE_TOKEN_SECRET_VARS[0], "PRK_ACCESS_CLIENT_SECRET");
        assert_eq!(SERVICE_TOKEN_ID_VARS[1], "CF_ACCESS_CLIENT_ID");
        assert_eq!(SERVICE_TOKEN_SECRET_VARS[1], "CF_ACCESS_CLIENT_SECRET");
    }

    #[test]
    fn the_header_names_match_what_access_expects() {
        assert_eq!(HEADER_CLIENT_ID, "CF-Access-Client-Id");
        assert_eq!(HEADER_CLIENT_SECRET, "CF-Access-Client-Secret");
    }
}
