//! The two identity types and where each is discovered.
//!
//! # One login path, two identity types
//!
//! Humans authenticate through Access SSO with managed OAuth and PKCE.
//! Machines present an Access service token as a header pair. Both produce an
//! Access-signed JWT at the edge, so the server sees one kind of caller and
//! there is exactly one authorization path -- the class of bug where an
//! interactive login works and a CI login does not cannot arise.
//!
//! Service-token JWTs have **no `email`, no `nbf`, and an empty `sub`**. A
//! verifier that requires any of those rejects every machine client.
//!
//! # Resolution order
//!
//! Flags, then `PRK_*`, then `CF_*`. The last of those is `cloudflared` parity:
//! a CI job that already exports `CF_ACCESS_CLIENT_ID` and
//! `CF_ACCESS_CLIENT_SECRET` for `cloudflared access` works with no changes,
//! which is the difference between adopting this tool and rewriting a pipeline
//! to adopt it.
//!
//! `PRK_*` wins so that a machine using both can point them at different
//! services.

use secrecy::SecretString;

/// Environment variables carrying a service token, in precedence order.
pub const SERVICE_TOKEN_ID_VARS: [&str; 2] = ["PRK_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID"];

/// Environment variables carrying a service token secret, in precedence order.
pub const SERVICE_TOKEN_SECRET_VARS: [&str; 2] =
    ["PRK_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET"];

/// The request header carrying a service token's client id.
pub const HEADER_CLIENT_ID: &str = prick_api::credential::HEADER_CLIENT_ID;

/// The request header carrying a service token's client secret.
pub const HEADER_CLIENT_SECRET: &str = prick_api::credential::HEADER_CLIENT_SECRET;

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

/// A resolved Access service token.
///
/// The client id is not secret -- it is the `common_name` the audit log records
/// the caller as -- so it is a plain `String`. The secret is not.
#[derive(Debug, Clone)]
pub struct ServiceToken {
    client_id: String,
    client_secret: SecretString,
    source: TokenSource,
}

/// Where a service token was found.
///
/// Reported by `prk doctor`, so an operator can tell a token that came from a
/// flag from one an unrelated `CF_*` variable supplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// Passed on the command line.
    Flag,
    /// Read from `PRK_ACCESS_CLIENT_ID` and `PRK_ACCESS_CLIENT_SECRET`.
    PrkEnvironment,
    /// Read from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
    CloudflaredEnvironment,
    /// Loaded from the token store.
    Stored,
}

impl TokenSource {
    /// A short description for a diagnostic.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Flag => "command line",
            Self::PrkEnvironment => "PRK_ACCESS_CLIENT_ID / PRK_ACCESS_CLIENT_SECRET",
            Self::CloudflaredEnvironment => "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET",
            Self::Stored => "token store",
        }
    }
}

impl ServiceToken {
    /// Builds a service token from its two halves.
    pub fn new(
        client_id: impl Into<String>,
        client_secret: SecretString,
        source: TokenSource,
    ) -> Self {
        Self { client_id: client_id.into(), client_secret, source }
    }

    /// The client id, which is the identity the server audits.
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Where this token came from.
    pub fn source(&self) -> TokenSource {
        self.source
    }

    /// Converts into the transport's credential type.
    pub fn into_api_credential(self) -> prick_api::Credential {
        prick_api::Credential::ServiceToken {
            client_id: self.client_id,
            client_secret: self.client_secret,
        }
    }
}

/// Resolves a service token from flags and an environment lookup.
///
/// The lookup is a parameter rather than `std::env::var` so the precedence
/// rules can be tested without mutating the process environment -- which is
/// `unsafe` under the 2024 edition, and which races every other test in the
/// binary.
///
/// Both halves must come from the same source. A `PRK_*` id paired with a
/// `CF_*` secret is a misconfiguration, and silently combining them would
/// produce an authentication failure with no way to see why.
pub fn resolve_service_token(
    flag_id: Option<&str>,
    flag_secret: Option<&str>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Option<ServiceToken> {
    if let (Some(id), Some(secret)) = (flag_id, flag_secret) {
        return Some(ServiceToken::new(id, SecretString::from(secret), TokenSource::Flag));
    }

    for (index, source) in
        [TokenSource::PrkEnvironment, TokenSource::CloudflaredEnvironment].into_iter().enumerate()
    {
        let id = SERVICE_TOKEN_ID_VARS.get(index).and_then(|name| lookup(name));
        let secret = SERVICE_TOKEN_SECRET_VARS.get(index).and_then(|name| lookup(name));
        if let (Some(id), Some(secret)) = (id, secret)
            && !id.is_empty()
            && !secret.is_empty()
        {
            return Some(ServiceToken::new(id, SecretString::from(secret), source));
        }
    }

    None
}

/// Resolves a service token from the real process environment.
pub fn service_token_from_env(
    flag_id: Option<&str>,
    flag_secret: Option<&str>,
) -> Option<ServiceToken> {
    resolve_service_token(flag_id, flag_secret, |name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let owned: Vec<(String, String)> =
            pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        move |name| owned.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

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

    #[test]
    fn a_flag_beats_every_environment_variable() {
        let token = resolve_service_token(
            Some("flag.access"),
            Some("flag-secret"),
            env(&[
                ("PRK_ACCESS_CLIENT_ID", "prk.access"),
                ("PRK_ACCESS_CLIENT_SECRET", "prk-secret"),
            ]),
        )
        .expect("a flag pair resolves");

        assert_eq!(token.client_id(), "flag.access");
        assert_eq!(token.source(), TokenSource::Flag);
    }

    #[test]
    fn prk_variables_are_used_before_the_cloudflared_ones() {
        let token = resolve_service_token(
            None,
            None,
            env(&[
                ("PRK_ACCESS_CLIENT_ID", "prk.access"),
                ("PRK_ACCESS_CLIENT_SECRET", "prk-secret"),
                ("CF_ACCESS_CLIENT_ID", "cf.access"),
                ("CF_ACCESS_CLIENT_SECRET", "cf-secret"),
            ]),
        )
        .expect("the PRK pair resolves");

        assert_eq!(token.client_id(), "prk.access");
        assert_eq!(token.source(), TokenSource::PrkEnvironment);
    }

    #[test]
    fn an_existing_cloudflared_setup_works_unchanged() {
        // The whole point of the fallback: a pipeline already configured for
        // `cloudflared access` needs no edits.
        let token = resolve_service_token(
            None,
            None,
            env(&[("CF_ACCESS_CLIENT_ID", "cf.access"), ("CF_ACCESS_CLIENT_SECRET", "cf-secret")]),
        )
        .expect("the cloudflared pair resolves");

        assert_eq!(token.client_id(), "cf.access");
        assert_eq!(token.source(), TokenSource::CloudflaredEnvironment);
    }

    #[test]
    fn halves_are_never_taken_from_different_sources() {
        // A PRK id with a CF secret is a misconfiguration. Combining them would
        // authenticate as nobody and report nothing useful.
        let resolved = resolve_service_token(
            None,
            None,
            env(&[
                ("PRK_ACCESS_CLIENT_ID", "prk.access"),
                ("CF_ACCESS_CLIENT_SECRET", "cf-secret"),
            ]),
        );
        assert!(resolved.is_none(), "two sources were combined into one credential");
    }

    #[test]
    fn a_half_configured_pair_resolves_to_nothing() {
        for pairs in [
            vec![("PRK_ACCESS_CLIENT_ID", "prk.access")],
            vec![("PRK_ACCESS_CLIENT_SECRET", "prk-secret")],
            vec![("CF_ACCESS_CLIENT_ID", "cf.access")],
        ] {
            assert!(resolve_service_token(None, None, env(&pairs)).is_none(), "{pairs:?}");
        }
    }

    #[test]
    fn an_empty_variable_is_treated_as_absent() {
        // An exported-but-empty variable is what a CI system produces when a
        // secret is missing. Treating it as present produces a 403 that looks
        // like a permissions problem.
        let resolved = resolve_service_token(
            None,
            None,
            env(&[("PRK_ACCESS_CLIENT_ID", ""), ("PRK_ACCESS_CLIENT_SECRET", "")]),
        );
        assert!(resolved.is_none());
    }

    #[test]
    fn nothing_configured_resolves_to_nothing() {
        assert!(resolve_service_token(None, None, env(&[])).is_none());
    }

    #[test]
    fn a_service_token_never_renders_its_secret() {
        let token =
            ServiceToken::new("abc.access", SecretString::from("hunter2"), TokenSource::Flag);
        let rendered = format!("{token:?}");
        assert!(!rendered.contains("hunter2"), "a secret leaked through Debug: {rendered}");
        assert!(rendered.contains("abc.access"), "the client id is not secret");
    }

    #[test]
    fn a_service_token_converts_into_the_transports_header_pair() {
        let token = ServiceToken::new("abc.access", SecretString::from("shh"), TokenSource::Flag);
        match token.into_api_credential() {
            prick_api::Credential::ServiceToken { client_id, client_secret } => {
                assert_eq!(client_id, "abc.access");
                assert_eq!(client_secret.expose_secret(), "shh");
            }
            other => panic!("expected a service token, got {other:?}"),
        }
    }

    #[test]
    fn every_source_describes_itself() {
        for source in [
            TokenSource::Flag,
            TokenSource::PrkEnvironment,
            TokenSource::CloudflaredEnvironment,
            TokenSource::Stored,
        ] {
            assert!(!source.as_str().is_empty());
        }
        assert!(TokenSource::CloudflaredEnvironment.as_str().contains("CF_ACCESS_CLIENT_ID"));
    }
}
