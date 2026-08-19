//! The managed OAuth handshake.
//!
//! # The flow `prk login <url>` performs
//!
//! 1. **Probe `/health`.** Three outcomes, all handled explicitly; see
//!    [`crate::discovery::probe`].
//! 2. **Discover** the authorization server via RFC 9728 and RFC 8414, and
//!    with it the RFC 8707 `resource` indicator that every later request
//!    carries -- Access refuses an authorization request that omits it.
//! 3. **Bind** a loopback listener on an OS-assigned port. This happens before
//!    registration because the port is part of the redirect URI that gets
//!    registered.
//! 4. **Register dynamically** for `http://127.0.0.1:<port>/callback`.
//! 5. **PKCE S256**, with the Cloudflare quirk handled -- see
//!    [`generate_pkce`].
//! 6. **Open the browser**, then accept exactly one request on the listener.
//! 7. **Compare `state` in constant time.**
//! 8. **Exchange** the code and store the tokens.
//!
//! # Why the `state` comparison is constant-time
//!
//! `state` arrives in a URL from an untrusted redirect. `==` on strings returns
//! as soon as two bytes differ, so the time it takes leaks how long a common
//! prefix was, and an attacker who can trigger repeated redirects can recover
//! the value a byte at a time and then forge a callback.
//!
//! The window is small and the attack is fiddly. It is also entirely avoidable
//! by calling [`prick_core::pkce::constant_time_eq`], which is why nothing here
//! uses `==`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;

use prick_api::{Body, Client};
use prick_core::pkce;

use crate::callback::CallbackListener;
use crate::discovery::{self, AuthorizationServer, Probe};
use crate::error::AuthError;
use crate::store::{StoredSession, Tokens};

/// Bytes of entropy in the OAuth `state` parameter.
pub const STATE_ENTROPY_BYTES: usize = 32;

/// How long to wait for the browser round trip before giving up.
pub const LOGIN_TIMEOUT_SECS: u64 = 300;

/// How long before expiry an access token is renewed.
///
/// A token that expires *during* the request it is about to authenticate is no
/// more useful than one that has already expired, and the failure it produces
/// is an intermittent 401 rather than a clean one.
pub const REFRESH_SKEW_SECS: u64 = 60;

/// How many times [`generate_pkce`] will resample before giving up.
///
/// About 3% of verifiers are rejected, so the chance of needing more than a
/// handful is negligible and the chance of needing 64 is about one in 10^97.
/// The bound exists so that a broken predicate is a clean failure rather than
/// a process that spins forever.
pub const MAX_VERIFIER_ATTEMPTS: usize = 64;

/// The scopes requested, when the server does not narrow them.
///
/// `offline_access` is what produces a refresh token, and without one every
/// access-token expiry would mean another browser round trip -- which is
/// exactly the 15-minute-session problem transparent refresh exists to hide.
const DESIRED_SCOPES: [&str; 4] = ["openid", "email", "profile", "offline_access"];

/// A PKCE verifier and the challenge derived from it.
#[derive(Debug, Clone)]
pub struct Pkce {
    /// The verifier, sent only to the token endpoint.
    pub verifier: SecretString,
    /// The challenge, sent in the authorization request.
    pub challenge: String,
}

/// Generates a PKCE verifier whose challenge Cloudflare will accept.
///
/// # The Cloudflare quirk
///
/// Cloudflare's authorization endpoint rejects a `code_challenge` that does not
/// begin with an alphanumeric character. base64url output begins with `-` or
/// `_` roughly 3% of the time, so a generator that does not check produces an
/// intermittent login failure at about that rate -- frequent enough to be a
/// support burden, rare enough that every report looks like a flake.
///
/// The fix is rejection sampling: generate, check, regenerate. Truncating or
/// substituting the first character instead would bias the verifier over a
/// smaller set; resampling keeps it uniform over the accepted one.
/// [`prick_core::pkce::is_usable_verifier`] is the predicate.
///
/// # Errors
///
/// [`AuthError::Io`] if the system CSPRNG is unavailable, or if the bound in
/// [`MAX_VERIFIER_ATTEMPTS`] is exhausted -- which would mean the predicate is
/// broken rather than that the sampling was unlucky.
pub fn generate_pkce() -> Result<Pkce, AuthError> {
    for _ in 0..MAX_VERIFIER_ATTEMPTS {
        let mut bytes = [0u8; pkce::VERIFIER_ENTROPY_BYTES];
        getrandom::fill(&mut bytes).map_err(|err| {
            AuthError::Io(std::io::Error::other(format!("no system randomness: {err}")))
        })?;

        let verifier = pkce::verifier_from_bytes(&bytes);
        if pkce::is_usable_verifier(&verifier) {
            let challenge = pkce::challenge_s256(&verifier);
            return Ok(Pkce { verifier: SecretString::from(verifier), challenge });
        }
    }

    Err(AuthError::Io(std::io::Error::other(format!(
        "could not generate an acceptable PKCE challenge in {MAX_VERIFIER_ATTEMPTS} attempts"
    ))))
}

/// Generates the OAuth `state` parameter.
///
/// # Errors
///
/// [`AuthError::Io`] if the system CSPRNG is unavailable.
pub fn generate_state() -> Result<String, AuthError> {
    let mut bytes = [0u8; STATE_ENTROPY_BYTES];
    getrandom::fill(&mut bytes).map_err(|err| {
        AuthError::Io(std::io::Error::other(format!("no system randomness: {err}")))
    })?;
    Ok(pkce::verifier_from_bytes(&bytes))
}

/// Picks the scopes to request.
///
/// The intersection of what is wanted and what the server advertises. A server
/// that advertises nothing gets the full list, because RFC 8414 makes
/// `scopes_supported` optional and refusing to ask for anything would be worse
/// than asking for something that is ignored.
pub fn scopes_for(server: &AuthorizationServer) -> Vec<String> {
    match server.scopes_supported.as_ref() {
        Some(supported) => DESIRED_SCOPES
            .iter()
            .filter(|wanted| supported.iter().any(|offered| offered == *wanted))
            .map(|scope| (*scope).to_owned())
            .collect(),
        None => DESIRED_SCOPES.iter().map(|scope| (*scope).to_owned()).collect(),
    }
}

/// Builds the URL the browser is sent to.
///
/// Query parameters go through `url`'s encoder rather than `format!`, so a
/// redirect URI or a state value cannot terminate the query and inject another
/// parameter.
///
/// `resource` is the RFC 8707 indicator naming what the token is for, and
/// Cloudflare Access refuses the request outright without it. It is `None` only
/// for a server with nothing in front of it, which has no protected resource
/// metadata to have named one and no authorization server to care.
///
/// # Errors
///
/// [`AuthError::Discovery`] if the authorization endpoint is not a URL.
pub fn authorization_url(
    server: &AuthorizationServer,
    client_id: &str,
    redirect_uri: &str,
    pkce_challenge: &str,
    state: &str,
    resource: Option<&str>,
) -> Result<String, AuthError> {
    let mut url =
        url::Url::parse(&server.authorization_endpoint).map_err(|err| AuthError::Discovery {
            reason: format!(
                "the authorization endpoint `{}` is not a URL: {err}",
                server.authorization_endpoint
            ),
        })?;

    let scopes = scopes_for(server).join(" ");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("state", state);
        query.append_pair("code_challenge", pkce_challenge);
        query.append_pair("code_challenge_method", pkce::METHOD);
        if let Some(resource) = resource {
            query.append_pair("resource", resource);
        }
        if !scopes.is_empty() {
            query.append_pair("scope", &scopes);
        }
    }

    Ok(url.into())
}

/// A successful token endpoint response.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

/// An RFC 6749 section 5.2 error response.
#[derive(Debug, Deserialize)]
struct OAuthErrorBody {
    error: String,
}

/// Seconds since the Unix epoch.
///
/// A clock before 1970 is not a state worth modelling; it reads as zero, which
/// makes every token look expired and produces a refresh rather than a panic.
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// Posts to the token endpoint and interprets the result.
///
/// The one place `invalid_grant` is turned into [`AuthError::AuthExpired`], so
/// every caller -- first exchange or transparent refresh -- reports an expired
/// session the same way.
async fn post_token(
    client: &Client,
    token_endpoint: &str,
    form: &[(&str, &str)],
) -> Result<Tokens, AuthError> {
    let received = client.fetch(reqwest::Method::POST, token_endpoint, Body::Form(form)).await?;
    let facts = &received.facts;

    if facts.status >= 400 {
        // RFC 6749 puts the machine-readable reason in the body, not the
        // status: `invalid_grant` and `invalid_client` are both 400.
        if let Ok(body) = serde_json::from_slice::<OAuthErrorBody>(received.body()) {
            return Err(match body.error.as_str() {
                // The refresh token was revoked, has expired, or belongs to a
                // client registration the server has since forgotten. All three
                // mean the same thing to a user: log in again.
                "invalid_grant" => AuthError::AuthExpired,
                other => AuthError::Denied { error: other.to_owned() },
            });
        }

        return Err(match prick_api::response::classify(facts) {
            Some(classified) => {
                AuthError::Api(prick_api::ApiError::from_response(facts.clone(), classified))
            }
            None => AuthError::Api(prick_api::ApiError::from_server(
                facts.clone(),
                format!("the token endpoint returned HTTP {}", facts.status),
            )),
        });
    }

    let response: TokenResponse =
        serde_json::from_slice(received.body()).map_err(|_| AuthError::Discovery {
            reason: "the token endpoint returned a body with no access token in it".to_owned(),
        })?;

    Ok(Tokens {
        access_token: SecretString::from(response.access_token),
        refresh_token: response.refresh_token.map(SecretString::from),
        expires_at: response.expires_in.map(|seconds| now().saturating_add(seconds)),
    })
}

/// Exchanges an authorization code for tokens.
///
/// `resource` is repeated here rather than left to the authorization request.
/// RFC 8707 section 2.2 is explicit that the token request carries it too, and
/// an authorization server that scopes the audience needs it in order to mint a
/// token for the right one rather than inferring it from the grant.
///
/// # Errors
///
/// [`AuthError::AuthExpired`] for `invalid_grant`, [`AuthError::Denied`] for
/// any other OAuth error, or a transport failure.
pub async fn exchange_code(
    client: &Client,
    token_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &SecretString,
    resource: Option<&str>,
) -> Result<Tokens, AuthError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier.expose_secret()),
    ];
    if let Some(resource) = resource {
        form.push(("resource", resource));
    }

    post_token(client, token_endpoint, &form).await
}

/// Renews an access token from a refresh token.
///
/// The server may or may not return a new refresh token. When it does not, the
/// existing one is kept: dropping it would turn every renewal into the last
/// one, and the failure would only show up when the next renewal was due.
///
/// `resource` is the indicator the session was minted for, which is why the
/// stored session carries it. A renewal that named a different resource -- or
/// none -- would be asking for a different token than the one it replaces.
///
/// # Errors
///
/// [`AuthError::AuthExpired`] for `invalid_grant`, which is what a revoked or
/// expired refresh token produces.
pub async fn refresh(
    client: &Client,
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &SecretString,
    resource: Option<&str>,
) -> Result<Tokens, AuthError> {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.expose_secret()),
        ("client_id", client_id),
    ];
    if let Some(resource) = resource {
        form.push(("resource", resource));
    }

    let mut tokens = post_token(client, token_endpoint, &form).await?;

    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.clone());
    }
    Ok(tokens)
}

/// Finds `state` and `code` in the callback's query parameters.
///
/// Rejects a redirect that carries a parameter twice: two `state` values means
/// something is trying to make the comparison pick the convenient one.
fn single<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let mut found = params.iter().filter(|(key, _)| key == name);
    let first = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(&first.1)
}

/// What a login needs beyond the server's own configuration.
#[derive(Debug, Clone)]
pub struct LoginOptions {
    /// How long to wait for the browser round trip.
    pub timeout: Duration,
}

impl Default for LoginOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(LOGIN_TIMEOUT_SECS) }
    }
}

/// What the probe found, for the caller to report before the browser opens.
#[derive(Debug, Clone)]
pub struct LoginOutcome {
    /// The session to store.
    pub session: StoredSession,
    /// What the unauthenticated probe revealed.
    pub probe: Probe,
}

/// Runs the whole interactive login.
///
/// `open` is a parameter rather than a call into the browser opener so that the
/// flow can be driven end to end by a test without a display. The CLI passes
/// [`crate::browser::open`]; the test suite passes a closure that fetches the
/// authorization URL itself.
///
/// # Errors
///
/// Any stage can fail; see [`AuthError`]. The two an operator acts on are
/// [`AuthError::ManagedOAuthDisabled`], which names the dashboard setting, and
/// [`AuthError::LoginTimeout`].
pub async fn login<F>(
    client: &Client,
    api_url: &str,
    options: &LoginOptions,
    open: F,
) -> Result<LoginOutcome, AuthError>
where
    F: FnOnce(&str) -> Result<(), AuthError>,
{
    // 1. Probe. An unprotected server is not a failure -- the secrets are
    //    reachable either way -- but the caller has to be told, loudly.
    let probe = discovery::probe(client).await?;
    let metadata_url = match &probe {
        Probe::ManagedOAuth { metadata_url } => metadata_url.clone(),
        Probe::ManagedOAuthDisabled => return Err(AuthError::ManagedOAuthDisabled),
        Probe::Unprotected => None,
    };

    // 2. Discover.
    //
    // The challenge's `resource_metadata` is tried first and is not required to
    // work: Access on the managed-OAuth beta advertises a URL it answers 404
    // for, while serving the same document at the standard RFC 9728 spelling.
    // `resolve_protected_resource` falls back to paths derived from the
    // resource THIS client is talking to, so a login no longer dies one request
    // short of everything it needed.
    //
    // An unprotected server has no challenge and no metadata to find, so it
    // keeps treating the API URL as the issuer rather than probing for
    // documents that are not there.
    let (issuer, resource) = if matches!(probe, Probe::Unprotected) {
        (api_url.to_owned(), None)
    } else {
        let health = client.config().url(&["health"]);
        let metadata =
            discovery::resolve_protected_resource(client, metadata_url.as_deref(), &health).await?;

        let issuer = metadata.authorization_servers.first().cloned().ok_or_else(|| {
            AuthError::Discovery {
                reason: "the protected resource metadata names no authorization server".to_owned(),
            }
        })?;

        // The same document names what the token is FOR, and RFC 8707 says to
        // send that back. Access is not lenient about it: an authorization
        // request carrying no `resource` is refused with `invalid_target`, at
        // the callback rather than in the browser.
        (issuer, Some(metadata.resource_indicator(api_url)))
    };
    let server = discovery::fetch_authorization_server(client, &issuer).await?;

    // 3. Bind first: the port is part of the redirect URI that gets registered.
    let listener = CallbackListener::bind()?;
    let redirect_uri = listener.redirect_uri();

    // 4. Register.
    let registration = discovery::register_client(client, &server, &redirect_uri).await?;

    // 5. PKCE, with the Cloudflare leading-character quirk handled.
    let pkce_pair = generate_pkce()?;
    let state = generate_state()?;

    // 6. Browser.
    let authorize = authorization_url(
        &server,
        &registration.client_id,
        &redirect_uri,
        &pkce_pair.challenge,
        &state,
        resource.as_deref(),
    )?;
    open(&authorize)?;

    // 7. One request, on a blocking thread so the reactor stays free.
    let timeout = options.timeout;
    let params = tokio::task::spawn_blocking(move || listener.wait_for_callback(timeout))
        .await
        .map_err(|err| AuthError::Io(std::io::Error::other(err.to_string())))??;

    if let Some(error) = single(&params, "error") {
        return Err(AuthError::Denied { error: error.to_owned() });
    }

    // 8. Constant-time comparison. `state` came from an untrusted redirect.
    let returned = single(&params, "state").ok_or(AuthError::StateMismatch)?;
    if !pkce::constant_time_eq(returned, &state) {
        return Err(AuthError::StateMismatch);
    }

    let code = single(&params, "code").ok_or_else(|| AuthError::Denied {
        error: "the redirect carried no authorization code".to_owned(),
    })?;

    // 9. Exchange.
    let tokens = exchange_code(
        client,
        &server.token_endpoint,
        &registration.client_id,
        &redirect_uri,
        code,
        &pkce_pair.verifier,
        resource.as_deref(),
    )
    .await?;

    Ok(LoginOutcome {
        session: StoredSession {
            api_url: api_url.trim_end_matches('/').to_owned(),
            issuer: server.issuer,
            client_id: registration.client_id,
            token_endpoint: server.token_endpoint,
            resource,
            tokens,
        },
        probe,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> AuthorizationServer {
        AuthorizationServer {
            issuer: "https://example.cloudflareaccess.com".to_owned(),
            authorization_endpoint: "https://example.cloudflareaccess.com/authorize".to_owned(),
            token_endpoint: "https://example.cloudflareaccess.com/token".to_owned(),
            registration_endpoint: Some("https://example.cloudflareaccess.com/register".to_owned()),
            code_challenge_methods_supported: Some(vec!["S256".to_owned()]),
            scopes_supported: None,
        }
    }

    #[test]
    fn a_generated_challenge_always_starts_with_an_alphanumeric() {
        // The Cloudflare quirk. Without rejection sampling this fails about 3%
        // of the time, which is the intermittent login failure the loop exists
        // to remove -- so the assertion is run enough times to see it.
        for _ in 0..200 {
            let pair = generate_pkce().expect("the system CSPRNG must be available");
            assert!(
                pkce::is_acceptable_challenge(&pair.challenge),
                "Cloudflare would reject `{}`",
                pair.challenge
            );
            assert!(pkce::is_valid_verifier(pair.verifier.expose_secret()));
        }
    }

    #[test]
    fn the_challenge_is_derived_from_the_verifier_it_is_paired_with() {
        let pair = generate_pkce().expect("generated");
        assert_eq!(pkce::challenge_s256(pair.verifier.expose_secret()), pair.challenge);
    }

    #[test]
    fn two_verifiers_are_never_the_same() {
        let first = generate_pkce().expect("generated");
        let second = generate_pkce().expect("generated");
        assert_ne!(first.verifier.expose_secret(), second.verifier.expose_secret());
    }

    #[test]
    fn a_verifier_never_renders_through_debug() {
        let pair = generate_pkce().expect("generated");
        let rendered = format!("{pair:?}");
        assert!(
            !rendered.contains(pair.verifier.expose_secret()),
            "the verifier leaked through Debug: {rendered}"
        );
    }

    #[test]
    fn the_resampling_bound_is_generous_enough_to_never_be_hit_by_chance() {
        // About 3% rejected, so 64 consecutive rejections has probability
        // 0.03^64. Hitting the bound means the predicate is broken.
        const { assert!(MAX_VERIFIER_ATTEMPTS >= 32) }
    }

    #[test]
    fn state_is_long_random_and_url_safe() {
        let first = generate_state().expect("generated");
        let second = generate_state().expect("generated");
        assert_ne!(first, second);
        assert_eq!(first.len(), 43, "32 bytes of base64url is 43 characters");
        assert!(first.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')));
    }

    #[test]
    fn the_authorization_url_carries_every_required_parameter() {
        let url = authorization_url(
            &server(),
            "client-1",
            "http://127.0.0.1:5000/callback",
            "chal",
            "st",
            Some("https://prick.example.com"),
        )
        .expect("the endpoint is a URL");
        let parsed = url::Url::parse(&url).expect("a URL was produced");
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        assert_eq!(params["response_type"], "code");
        assert_eq!(params["client_id"], "client-1");
        assert_eq!(params["redirect_uri"], "http://127.0.0.1:5000/callback");
        assert_eq!(params["state"], "st");
        assert_eq!(params["code_challenge"], "chal");
        assert_eq!(params["code_challenge_method"], "S256");
        // RFC 8707. Without it Access answers `invalid_target` and the login
        // dies at the callback.
        assert_eq!(params["resource"], "https://prick.example.com");
        assert!(params["scope"].contains("offline_access"), "no refresh token would be issued");
    }

    #[test]
    fn the_plain_pkce_method_is_never_requested() {
        let url =
            authorization_url(&server(), "c", "http://127.0.0.1:1/callback", "chal", "st", None)
                .expect("a URL");
        assert!(url.contains("code_challenge_method=S256"));
        assert!(!url.contains("plain"));
    }

    #[test]
    fn query_parameters_are_encoded_rather_than_interpolated() {
        // A state value containing `&` must not become a second parameter.
        let url = authorization_url(
            &server(),
            "c",
            "http://127.0.0.1:1/callback",
            "chal",
            "a&evil=1",
            None,
        )
        .expect("a URL");
        let parsed = url::Url::parse(&url).expect("a URL");
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(params["state"], "a&evil=1");
        assert!(!params.contains_key("evil"), "a parameter was injected through state");
    }

    #[test]
    fn an_endpoint_that_is_not_a_url_is_reported_rather_than_concatenated() {
        let mut server = server();
        server.authorization_endpoint = "not a url".to_owned();
        let err = authorization_url(&server, "c", "http://127.0.0.1:1/callback", "ch", "st", None)
            .expect_err("a malformed endpoint");
        assert!(matches!(err, AuthError::Discovery { .. }));
    }

    #[test]
    fn scopes_are_narrowed_to_what_the_server_offers() {
        let mut server = server();
        server.scopes_supported = Some(vec!["openid".to_owned(), "email".to_owned()]);
        assert_eq!(scopes_for(&server), ["openid", "email"]);

        server.scopes_supported = None;
        assert!(scopes_for(&server).contains(&"offline_access".to_owned()));
    }

    #[test]
    fn a_server_offering_nothing_we_want_produces_no_scope_parameter() {
        let mut server = server();
        server.scopes_supported = Some(vec!["something_else".to_owned()]);
        assert!(scopes_for(&server).is_empty());

        let url = authorization_url(&server, "c", "http://127.0.0.1:1/callback", "ch", "st", None)
            .expect("a URL");
        assert!(!url.contains("scope="), "an empty scope was still sent: {url}");
    }

    #[test]
    fn a_parameter_that_appears_twice_is_refused_rather_than_disambiguated() {
        let params =
            vec![("state".to_owned(), "a".to_owned()), ("state".to_owned(), "b".to_owned())];
        assert_eq!(single(&params, "state"), None);

        let params = vec![("state".to_owned(), "a".to_owned())];
        assert_eq!(single(&params, "state"), Some("a"));
        assert_eq!(single(&params, "code"), None);
    }

    #[test]
    fn a_server_with_nothing_in_front_of_it_sends_no_resource_at_all() {
        // There is no protected resource metadata to have named one, and an
        // invented indicator is a value the server never advertised.
        let url =
            authorization_url(&server(), "c", "http://127.0.0.1:1/callback", "ch", "st", None)
                .expect("a URL");
        assert!(!url.contains("resource="), "a resource was invented: {url}");
    }

    #[test]
    fn the_refresh_skew_is_long_enough_to_cover_a_request() {
        assert_eq!(REFRESH_SKEW_SECS, 60);
    }

    #[test]
    fn the_default_login_timeout_allows_for_a_real_sign_in() {
        // Long enough for a password manager, a second factor and a redirect.
        assert_eq!(LoginOptions::default().timeout.as_secs(), 300);
    }
}
