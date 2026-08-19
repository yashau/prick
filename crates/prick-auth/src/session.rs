//! Turning stored state into the credential a request is made with.
//!
//! # Transparent refresh
//!
//! An Access session is short. If renewal were something a user had to notice,
//! `prk` would prompt for a login in the middle of a `prk run`, which is
//! precisely where a prompt cannot be answered -- the terminal belongs to the
//! child process.
//!
//! So the access token is renewed **before** each request whenever it is within
//! [`crate::oauth::REFRESH_SKEW_SECS`] of expiring, and the renewed session is
//! written back. Renewing after a 401 instead would work, but it would put a
//! guaranteed extra round trip on the critical path of the first request after
//! every expiry, and it would have to be implemented once per call site.
//!
//! # Precedence
//!
//! A service token wins over a stored session. A machine with `PRK_*` or `CF_*`
//! set has been told explicitly what identity to use, and silently preferring a
//! developer's leftover browser session on the same box would make CI runs
//! authenticate as whoever last logged in there.

use crate::credential::{ServiceToken, TokenSource};
use crate::error::AuthError;
use crate::oauth::{REFRESH_SKEW_SECS, refresh};
use crate::store::{StoredSession, TokenStore};

/// A credential, and where it came from.
#[derive(Debug, Clone)]
pub struct Resolved {
    /// What to present on the request.
    pub credential: prick_api::Credential,
    /// Where it was found, for `prk doctor` and for `-v`.
    pub source: TokenSource,
    /// Whether the access token was renewed to produce it.
    pub refreshed: bool,
    /// When the credential stops being valid, if that is known.
    pub expires_at: Option<u64>,
}

/// Seconds since the Unix epoch.
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Resolves the credential to use for `api_url`.
///
/// # Errors
///
/// [`AuthError::NoCredential`] when nothing is configured,
/// [`AuthError::AuthExpired`] when the stored session cannot be renewed, and
/// whatever the token endpoint reported when a renewal fails for another
/// reason.
pub async fn resolve(
    client: &prick_api::Client,
    store: &TokenStore,
    api_url: &str,
    service_token: Option<ServiceToken>,
) -> Result<Resolved, AuthError> {
    resolve_at(client, store, api_url, service_token, now()).await
}

/// [`resolve`] with an explicit clock, so expiry handling is testable.
///
/// # Errors
///
/// See [`resolve`].
pub async fn resolve_at(
    client: &prick_api::Client,
    store: &TokenStore,
    api_url: &str,
    service_token: Option<ServiceToken>,
    now: u64,
) -> Result<Resolved, AuthError> {
    if let Some(token) = service_token {
        let source = token.source();
        return Ok(Resolved {
            credential: token.into_api_credential(),
            source,
            refreshed: false,
            expires_at: None,
        });
    }

    let wanted = api_url.trim_end_matches('/');
    let session = store
        .load()?
        // A token issued for one server is never presented to another: the
        // audience is baked into the token, and sending it elsewhere would leak
        // it to a host that has no business seeing it.
        .filter(|session| session.api_url == wanted)
        .ok_or_else(|| AuthError::NoCredential { api_url: wanted.to_owned() })?;

    if !session.needs_refresh(now, REFRESH_SKEW_SECS) {
        return Ok(Resolved {
            credential: prick_api::Credential::Bearer(session.tokens.access_token.clone()),
            source: TokenSource::Stored,
            refreshed: false,
            expires_at: session.tokens.expires_at,
        });
    }

    let Some(refresh_token) = session.tokens.refresh_token.clone() else {
        // Expired with no way back. Reported as expired rather than as missing,
        // because "log in again" is the fix and "no credentials found" would
        // read as a configuration problem.
        return Err(AuthError::AuthExpired);
    };

    let tokens = refresh(
        client,
        &session.token_endpoint,
        &session.client_id,
        &refresh_token,
        session.resource.as_deref(),
    )
    .await?;

    let renewed = StoredSession { tokens, ..session };
    store.save(&renewed)?;

    Ok(Resolved {
        credential: prick_api::Credential::Bearer(renewed.tokens.access_token.clone()),
        source: TokenSource::Stored,
        refreshed: true,
        expires_at: renewed.tokens.expires_at,
    })
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;
    use crate::store::{StorageBackend, Tokens};

    fn client() -> prick_api::Client {
        prick_api::Client::new(
            prick_api::Config::new("https://prick.example.com"),
            prick_api::Credential::Anonymous,
        )
        .expect("building a client must succeed")
    }

    fn store() -> (tempfile::TempDir, TokenStore) {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let store = TokenStore::in_dir(dir.path().join("prick"), StorageBackend::File);
        (dir, store)
    }

    fn session(expires_at: Option<u64>, refreshable: bool) -> StoredSession {
        StoredSession {
            api_url: "https://prick.example.com".to_owned(),
            issuer: "https://example.cloudflareaccess.com".to_owned(),
            client_id: "client-1".to_owned(),
            token_endpoint: "https://example.cloudflareaccess.com/token".to_owned(),
            resource: Some("https://prick.example.com".to_owned()),
            tokens: Tokens {
                access_token: SecretString::from("access-abc"),
                refresh_token: refreshable.then(|| SecretString::from("refresh-xyz")),
                expires_at,
            },
        }
    }

    #[tokio::test]
    async fn a_service_token_wins_over_a_stored_session() {
        let (_dir, store) = store();
        store.save(&session(Some(u64::MAX), true)).expect("save");

        let resolved = resolve_at(
            &client(),
            &store,
            "https://prick.example.com",
            Some(ServiceToken::new(
                "ci.access",
                SecretString::from("shh"),
                TokenSource::PrkEnvironment,
            )),
            1_000,
        )
        .await
        .expect("a service token always resolves");

        assert_eq!(resolved.source, TokenSource::PrkEnvironment);
        assert!(matches!(resolved.credential, prick_api::Credential::ServiceToken { .. }));
        assert!(!resolved.refreshed);
    }

    #[tokio::test]
    async fn a_live_session_is_used_without_a_round_trip() {
        let (_dir, store) = store();
        store.save(&session(Some(10_000), true)).expect("save");

        let resolved = resolve_at(&client(), &store, "https://prick.example.com", None, 1_000)
            .await
            .expect("a live session resolves");

        assert_eq!(resolved.source, TokenSource::Stored);
        assert!(!resolved.refreshed, "a token with hours left was renewed anyway");
        assert!(matches!(resolved.credential, prick_api::Credential::Bearer(_)));
    }

    #[tokio::test]
    async fn a_trailing_slash_on_the_url_still_matches_the_stored_session() {
        let (_dir, store) = store();
        store.save(&session(Some(10_000), true)).expect("save");

        resolve_at(&client(), &store, "https://prick.example.com/", None, 1_000)
            .await
            .expect("the trailing slash must be normalised away");
    }

    #[tokio::test]
    async fn a_session_for_a_different_server_is_not_used() {
        // Presenting a token minted for one audience to another host would leak
        // it to somewhere with no business seeing it.
        let (_dir, store) = store();
        store.save(&session(Some(10_000), true)).expect("save");

        let err = resolve_at(&client(), &store, "https://other.example.com", None, 1_000)
            .await
            .expect_err("a token for another server must not be presented");
        assert!(matches!(err, AuthError::NoCredential { .. }));
    }

    #[tokio::test]
    async fn nothing_stored_and_nothing_configured_says_how_to_fix_it() {
        let (_dir, store) = store();
        let err = resolve_at(&client(), &store, "https://prick.example.com", None, 1_000)
            .await
            .expect_err("no credential exists");

        assert!(matches!(err, AuthError::NoCredential { .. }));
        let hint = err.hint().expect("this failure must be actionable");
        assert!(hint.contains("prk login"));
        assert!(hint.contains("PRK_ACCESS_CLIENT_ID"));
    }

    #[tokio::test]
    async fn an_expired_session_with_no_refresh_token_is_reported_as_expired() {
        let (_dir, store) = store();
        store.save(&session(Some(1_000), false)).expect("save");

        let err = resolve_at(&client(), &store, "https://prick.example.com", None, 2_000)
            .await
            .expect_err("an expired session cannot be used");

        assert!(matches!(err, AuthError::AuthExpired));
        assert_eq!(err.exit_code(), 3);
    }

    #[tokio::test]
    async fn a_token_expiring_inside_the_skew_window_is_treated_as_expired() {
        // 30 seconds left, which is less than the 60-second skew: renewing is
        // the whole point, so with no refresh token this is expired.
        let (_dir, store) = store();
        store.save(&session(Some(1_030), false)).expect("save");

        let err = resolve_at(&client(), &store, "https://prick.example.com", None, 1_000)
            .await
            .expect_err("a token expiring mid-request is stale");
        assert!(matches!(err, AuthError::AuthExpired));
    }

    #[tokio::test]
    async fn a_session_with_no_stated_expiry_is_used_as_is() {
        let (_dir, store) = store();
        store.save(&session(None, false)).expect("save");

        let resolved = resolve_at(&client(), &store, "https://prick.example.com", None, u64::MAX)
            .await
            .expect("a token with no expiry is used until it is refused");
        assert!(!resolved.refreshed);
    }
}
