//! Probing the server and discovering its authorization server.
//!
//! # The probe has three outcomes and all of them matter
//!
//! Cloudflare's managed OAuth for Access shipped on 2026-03-20. An
//! Access-protected application with it enabled answers an unauthenticated API
//! request with `401` and a `WWW-Authenticate` header pointing at RFC 9728
//! protected-resource metadata, from which RFC 8414 authorization-server
//! metadata is reachable, and it supports RFC 7591 dynamic client
//! registration. That is the path `prk login` takes.
//!
//! The other two outcomes are not edge cases:
//!
//! - **Managed OAuth off.** The application is behind Access, but it only
//!   speaks the browser SSO flow. A CLI cannot complete that, and the fix is a
//!   specific dashboard setting -- so the error names it exactly rather than
//!   saying "login failed".
//! - **Nothing in front of it at all.** `/health` answers `200` with JSON to a
//!   request carrying no credential. That means a secrets manager is reachable
//!   from wherever this machine is, unauthenticated. It is the single most
//!   important thing this tool will ever have to tell an operator, so it is a
//!   loud warning rather than a debug line.

use serde::Deserialize;

use prick_api::{Body, Client};

use crate::error::AuthError;

/// The `.well-known` suffix for RFC 8414 authorization server metadata.
pub const WELL_KNOWN_AS: &str = ".well-known/oauth-authorization-server";

/// The `.well-known` suffix for RFC 9728 protected resource metadata.
///
/// Cloudflare Access advertises its own `cloudflare-access-protected-resource`
/// spelling in the challenge. This is the standard one, and the fallback when
/// the advertised URL does not resolve.
pub const WELL_KNOWN_PR: &str = ".well-known/oauth-protected-resource";

/// The `.well-known` suffix for `OpenID` Connect discovery.
///
/// Tried after the RFC 8414 name: an authorization server that implements both
/// serves the same document at each, and one that implements only `OpenID` serves
/// it here.
pub const WELL_KNOWN_OIDC: &str = ".well-known/openid-configuration";

/// What an unauthenticated request to `/health` revealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// Access is in front, and it advertised an authorization server.
    ManagedOAuth {
        /// The RFC 9728 protected-resource metadata URL, when the challenge
        /// carried one. Absent means falling back to the origin's own
        /// well-known paths.
        metadata_url: Option<String>,
    },
    /// Access is in front, but it did not advertise an authorization server.
    ManagedOAuthDisabled,
    /// Nothing is in front. The API answered without a credential.
    Unprotected,
}

impl Probe {
    /// Whether this outcome means the operator has an exposed server.
    pub fn is_unprotected(self) -> bool {
        matches!(self, Self::Unprotected)
    }
}

/// The warning text for an unprotected server.
///
/// A constant so the wording is asserted in a test rather than reviewed once.
pub const UNPROTECTED_WARNING: &str = "this server answered an unauthenticated request, so it is NOT protected by Cloudflare \
     Access: anyone who can reach this hostname can read every secret it holds";

/// Probes `/health` with no credential.
///
/// # Errors
///
/// [`AuthError::Api`] for a transport failure or a response that is not from
/// this service at all.
pub async fn probe(client: &Client) -> Result<Probe, AuthError> {
    // The API prefix, not the origin. The Worker routes `/api/*` to the API and
    // everything else to the SvelteKit admin UI, so a probe of `/health` at the
    // origin reads SvelteKit's HTML 404.
    //
    // With Access in front this is invisible -- every path 401s, so detection
    // still works. It misfires on exactly one deployment: an UNPROTECTED one,
    // where the probe is the thing that would have warned you. `prk login`
    // would abort with "not a prick server" instead of saying the server is
    // reachable without authentication.
    let url = client.config().url(&["health"]);
    let received = client.fetch(reqwest::Method::GET, &url, Body::None).await?;
    let facts = &received.facts;

    if facts.status == 401 {
        return Ok(match facts.www_authenticate.as_deref() {
            Some(challenge) => Probe::ManagedOAuth { metadata_url: metadata_url(challenge) },
            // Access answered, but with no pointer to an authorization server.
            None => Probe::ManagedOAuthDisabled,
        });
    }

    // The interactive SSO flow. A browser would follow this and get a login
    // page; a CLI cannot, and there is no machine-readable path advertised.
    if facts.redirects_to_access() {
        return Ok(Probe::ManagedOAuthDisabled);
    }

    if facts.status == 200 && facts.is_json() {
        let health: prick_api::models::Health =
            serde_json::from_slice(received.body()).map_err(|_| {
                AuthError::Api(prick_api::ApiError::new(
                    prick_core::classify::ErrorKind::NotPrick,
                    format!("{url} answered with JSON that is not a health response"),
                ))
            })?;

        if !health.is_prick() {
            return Err(AuthError::Api(prick_api::ApiError::new(
                prick_core::classify::ErrorKind::NotPrick,
                format!(
                    "{url} identifies itself as `{}` rather than as this service",
                    health.service
                ),
            )));
        }
        return Ok(Probe::Unprotected);
    }

    // Anything else: let the transport's own classification explain it. It has
    // the Cloudflare headers and the page title; this function does not.
    match prick_api::response::classify(facts) {
        Some(classified) => {
            Err(AuthError::Api(prick_api::ApiError::from_response(facts.clone(), classified)))
        }
        None => Err(AuthError::Api(prick_api::ApiError::new(
            prick_core::classify::ErrorKind::Unknown,
            format!("{url} answered with HTTP {} and nothing to act on", facts.status),
        ))),
    }
}

/// Extracts `resource_metadata` from a `WWW-Authenticate` challenge.
///
/// RFC 9728 section 5.1. The header looks like
/// `Bearer realm="x", resource_metadata="https://host/.well-known/..."`.
/// Only the quoted form is accepted: an unquoted URL cannot be delimited
/// unambiguously from the parameters that follow it.
pub fn metadata_url(challenge: &str) -> Option<String> {
    for name in ["resource_metadata", "as_uri"] {
        if let Some(value) = quoted_parameter(challenge, name) {
            return Some(value);
        }
    }
    None
}

/// Reads one `name="value"` parameter out of a header value.
fn quoted_parameter(header: &str, name: &str) -> Option<String> {
    let mut rest = header;
    loop {
        let start = rest.find(name)?;
        let after = rest.get(start + name.len()..)?;

        // The match has to be a whole parameter name, not a suffix of a longer
        // one: `client_resource_metadata` is not `resource_metadata`.
        let preceded_ok =
            rest[..start].chars().next_back().is_none_or(|ch| ch == ' ' || ch == ',' || ch == ';');

        let value = after.trim_start();
        if preceded_ok
            && let Some(value) = value.strip_prefix('=')
            && let Some(value) = value.trim_start().strip_prefix('"')
            && let Some(end) = value.find('"')
        {
            return Some(value[..end].to_owned());
        }

        rest = rest.get(start + name.len()..)?;
    }
}

/// RFC 9728 protected resource metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ProtectedResource {
    /// The resource identifier the metadata describes.
    #[serde(default)]
    pub resource: Option<String>,
    /// The issuers that can mint tokens for it.
    #[serde(default)]
    pub authorization_servers: Vec<String>,
}

/// RFC 8414 authorization server metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct AuthorizationServer {
    /// The issuer identifier.
    pub issuer: String,
    /// Where the browser is sent.
    pub authorization_endpoint: String,
    /// Where the code is exchanged.
    pub token_endpoint: String,
    /// Where a client registers itself, when the server supports RFC 7591.
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    /// The PKCE methods on offer.
    #[serde(default)]
    pub code_challenge_methods_supported: Option<Vec<String>>,
    /// The scopes on offer.
    #[serde(default)]
    pub scopes_supported: Option<Vec<String>>,
}

impl AuthorizationServer {
    /// Whether the server advertises PKCE with `S256`.
    ///
    /// A server that advertises only `plain` is refused rather than downgraded
    /// to: `plain` puts the verifier on the wire, which is the thing PKCE
    /// exists to avoid.
    pub fn supports_s256(&self) -> bool {
        self.code_challenge_methods_supported
            .as_ref()
            .is_none_or(|methods| methods.iter().any(|method| method == prick_core::pkce::METHOD))
    }
}

/// Builds the `.well-known` URLs for an issuer, in the order to try them.
///
/// RFC 8414 section 3.1 inserts the well-known segment **between the host and
/// the issuer's path**, which is the opposite of the `OpenID` Connect convention
/// of appending it. An issuer with a path is common behind Access, so both
/// forms are tried rather than assumed.
pub fn well_known_urls(issuer: &str) -> Vec<String> {
    let issuer = issuer.trim_end_matches('/');
    let (origin, path) = split_origin(issuer);

    let mut urls = Vec::with_capacity(3);
    for suffix in [WELL_KNOWN_AS, WELL_KNOWN_OIDC] {
        urls.push(if path.is_empty() {
            format!("{origin}/{suffix}")
        } else {
            format!("{origin}/{suffix}{path}")
        });
    }
    if !path.is_empty() {
        // The OpenID Connect spelling, for servers that only implement that.
        urls.push(format!("{issuer}/{WELL_KNOWN_OIDC}"));
    }
    urls
}

/// Builds the RFC 9728 metadata URLs for a resource, in the order to try them.
///
/// Section 3.1 inserts the well-known segment **between the host and the
/// resource path**, exactly as RFC 8414 does for an issuer -- so the metadata
/// for `https://host/api/v1/health` lives at
/// `https://host/.well-known/oauth-protected-resource/api/v1/health`.
///
/// The path-less form is tried second. A deployment that describes the origin
/// rather than the individual endpoint answers there and nowhere else, and it
/// names the same authorization server either way.
pub fn protected_resource_urls(resource: &str) -> Vec<String> {
    let resource = resource.trim_end_matches('/');
    let (origin, path) = split_origin(resource);

    let mut urls = Vec::with_capacity(2);
    if !path.is_empty() {
        urls.push(format!("{origin}/{WELL_KNOWN_PR}{path}"));
    }
    urls.push(format!("{origin}/{WELL_KNOWN_PR}"));
    urls
}

/// Splits `https://host:port/path` into its origin and its path.
fn split_origin(url: &str) -> (&str, &str) {
    let Some(scheme_end) = url.find("://") else { return (url, "") };
    let after_scheme = scheme_end + 3;
    match url.get(after_scheme..).and_then(|rest| rest.find('/')) {
        Some(offset) => url.split_at(after_scheme + offset),
        None => (url, ""),
    }
}

/// Fetches RFC 9728 protected resource metadata.
///
/// # Errors
///
/// [`AuthError::Discovery`] if the document cannot be fetched or names no
/// authorization server.
pub async fn fetch_protected_resource(
    client: &Client,
    url: &str,
) -> Result<ProtectedResource, AuthError> {
    let metadata: ProtectedResource = client.get_json(url).await.map_err(|err| {
        AuthError::Discovery { reason: format!("{url} could not be read: {err}") }
    })?;

    if metadata.authorization_servers.is_empty() {
        return Err(AuthError::Discovery {
            reason: format!("{url} names no authorization server"),
        });
    }
    Ok(metadata)
}

/// Resolves protected resource metadata, tolerating an advertised URL that
/// does not resolve.
///
/// THE ADVERTISED URL IS TRIED FIRST AND IS NOT TRUSTED TO WORK.
///
/// RFC 9728 says the `WWW-Authenticate` challenge names where the metadata
/// lives, and following it is the correct behaviour. But Cloudflare Access, on
/// the managed-OAuth beta, advertises
/// `/.well-known/cloudflare-access-protected-resource<resource-path>` and
/// serves 404 there -- while serving the same document at that prefix WITHOUT
/// the path, and at the standard `oauth-protected-resource` prefix WITH it.
/// Both working variants name the same authorization server, so a login that
/// gave up at the advertised 404 failed while every fact it needed was one
/// request away.
///
/// So the advertised URL keeps its precedence and stops being load-bearing.
/// The fallbacks are derived from the resource this client is actually talking
/// to, never from the challenge, which means a challenge that points somewhere
/// unexpected cannot redirect discovery to a host of its choosing.
///
/// # Errors
///
/// [`AuthError::Discovery`] when no candidate yields a document naming an
/// authorization server. The message lists every URL tried, because the useful
/// question after this fails is which spellings the deployment answers.
pub async fn resolve_protected_resource(
    client: &Client,
    advertised: Option<&str>,
    resource: &str,
) -> Result<ProtectedResource, AuthError> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(url) = advertised {
        candidates.push(url.to_owned());
    }
    for url in protected_resource_urls(resource) {
        if !candidates.contains(&url) {
            candidates.push(url);
        }
    }

    // `fetch_protected_resource` is the one definition of "usable metadata" --
    // fetched, parsed, and naming at least one authorization server. Reusing it
    // per candidate keeps that rule in one place; the error is discarded because
    // a candidate that does not answer is the expected case here, not a failure.
    for url in &candidates {
        if let Ok(metadata) = fetch_protected_resource(client, url).await {
            return Ok(metadata);
        }
    }

    Err(AuthError::Discovery {
        reason: format!(
            "no protected resource metadata naming an authorization server at any of: {}",
            candidates.join(", ")
        ),
    })
}

/// Fetches RFC 8414 authorization server metadata, trying each well-known URL.
///
/// # Errors
///
/// [`AuthError::Discovery`] if none of the candidate URLs yields a usable
/// document, or if the one that does omits an endpoint the flow needs.
pub async fn fetch_authorization_server(
    client: &Client,
    issuer: &str,
) -> Result<AuthorizationServer, AuthError> {
    let candidates = well_known_urls(issuer);
    let mut last: Option<String> = None;

    for url in &candidates {
        match client.get_json::<AuthorizationServer>(url).await {
            Ok(metadata) => {
                if metadata.authorization_endpoint.is_empty() || metadata.token_endpoint.is_empty()
                {
                    return Err(AuthError::Discovery {
                        reason: format!("{url} omits an authorization or token endpoint"),
                    });
                }
                if !metadata.supports_s256() {
                    return Err(AuthError::Discovery {
                        reason: format!(
                            "{url} does not offer the {} PKCE method, and the `plain` method \
                             would put the verifier on the wire",
                            prick_core::pkce::METHOD
                        ),
                    });
                }
                return Ok(metadata);
            }
            Err(err) => last = Some(format!("{url}: {err}")),
        }
    }

    Err(AuthError::Discovery {
        reason: last.unwrap_or_else(|| format!("no metadata document found for {issuer}")),
    })
}

/// A dynamically registered client.
#[derive(Debug, Clone, Deserialize)]
#[non_exhaustive]
pub struct Registration {
    /// The identifier to send in the authorization request.
    pub client_id: String,
    /// Present only if the server issued one. A native client uses PKCE and no
    /// secret, so this is normally absent; it is carried rather than dropped
    /// because a server that issues one requires it back at the token endpoint.
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// Registers a client for a loopback redirect URI.
///
/// RFC 7591. The registration is per-login and per-port, because the port is
/// whatever the OS assigned to the callback listener moments earlier -- so two
/// concurrent logins cannot collide and nothing is hardcoded.
///
/// # Errors
///
/// [`AuthError::Registration`] if the server refuses, and
/// [`AuthError::ManagedOAuthDisabled`] if it has no registration endpoint --
/// which is what "managed OAuth is off" looks like at this stage.
pub async fn register_client(
    client: &Client,
    server: &AuthorizationServer,
    redirect_uri: &str,
) -> Result<Registration, AuthError> {
    let Some(endpoint) = server.registration_endpoint.as_deref() else {
        return Err(AuthError::ManagedOAuthDisabled);
    };

    let body = serde_json::json!({
        "client_name": "prk",
        "client_uri": "https://github.com/yashau/prick",
        // Exactly the one loopback URI, so an authorization response can only
        // ever be delivered to this process on this port.
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // A public client cannot keep a secret on a user's laptop. PKCE is what
        // takes its place, which is why S256 support is checked during
        // discovery rather than hoped for here.
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });

    client
        .post_json(endpoint, &body)
        .await
        .map_err(|err| AuthError::Registration { reason: err.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE CLOUDFLARE BETA SHAPE.
    ///
    /// Access advertises
    /// `/.well-known/cloudflare-access-protected-resource<path>` and answers 404
    /// there, while serving the same document at the standard spelling WITH the
    /// path and at its own spelling WITHOUT it. The fallback list has to contain
    /// the one that works, derived from the resource rather than the challenge.
    #[test]
    fn the_standard_spelling_is_derived_from_the_resource_path() {
        let urls = protected_resource_urls("https://prick.example.com/api/v1/health");

        assert_eq!(
            urls[0],
            "https://prick.example.com/.well-known/oauth-protected-resource/api/v1/health"
        );
        assert_eq!(urls[1], "https://prick.example.com/.well-known/oauth-protected-resource");
    }

    #[test]
    fn the_well_known_segment_goes_between_host_and_path_not_after_it() {
        // RFC 9728 section 3.1. Appending it -- the OpenID Connect habit --
        // would ask for `/api/v1/health/.well-known/...`, which is a path this
        // Worker routes to the admin UI.
        let urls = protected_resource_urls("https://prick.example.com/api/v1/health");

        assert!(
            !urls.iter().any(|url| url.ends_with("/health/.well-known/oauth-protected-resource"))
        );
    }

    #[test]
    fn a_path_less_resource_yields_one_candidate() {
        assert_eq!(
            protected_resource_urls("https://prick.example.com"),
            ["https://prick.example.com/.well-known/oauth-protected-resource"]
        );
    }

    #[test]
    fn a_trailing_slash_does_not_produce_a_doubled_one() {
        for url in protected_resource_urls("https://prick.example.com/") {
            assert!(!url.contains("com//"), "{url}");
        }
    }

    #[test]
    fn a_challenge_yields_its_metadata_url() {
        let challenge = r#"Bearer realm="prick", resource_metadata="https://prick.example.com/.well-known/oauth-protected-resource""#;
        assert_eq!(
            metadata_url(challenge).as_deref(),
            Some("https://prick.example.com/.well-known/oauth-protected-resource")
        );
    }

    #[test]
    fn the_older_as_uri_spelling_is_accepted() {
        let challenge = r#"Bearer as_uri="https://example.cloudflareaccess.com""#;
        assert_eq!(
            metadata_url(challenge).as_deref(),
            Some("https://example.cloudflareaccess.com")
        );
    }

    #[test]
    fn a_challenge_with_no_pointer_yields_nothing() {
        assert_eq!(metadata_url("Bearer"), None);
        assert_eq!(metadata_url(r#"Bearer realm="prick""#), None);
        assert_eq!(metadata_url(""), None);
    }

    #[test]
    fn a_parameter_name_is_matched_whole_rather_than_as_a_suffix() {
        // `x_resource_metadata` is a different parameter and must not be read
        // as this one.
        let challenge = r#"Bearer x_resource_metadata="https://evil.example/", realm="prick""#;
        assert_eq!(metadata_url(challenge), None);
    }

    #[test]
    fn an_unquoted_value_is_not_accepted() {
        // Without quotes the value cannot be delimited from what follows it.
        assert_eq!(metadata_url("Bearer resource_metadata=https://x/y, realm=z"), None);
    }

    #[test]
    fn whitespace_around_the_parameter_is_tolerated() {
        let challenge = "Bearer  resource_metadata = \"https://x/y\" ";
        assert_eq!(metadata_url(challenge).as_deref(), Some("https://x/y"));
    }

    #[test]
    fn rfc_8414_inserts_the_well_known_segment_before_the_path() {
        // The detail that trips people up: OpenID appends, RFC 8414 inserts.
        let urls = well_known_urls("https://example.cloudflareaccess.com/team");
        assert_eq!(
            urls[0],
            "https://example.cloudflareaccess.com/.well-known/oauth-authorization-server/team"
        );
        assert!(
            urls.contains(
                &"https://example.cloudflareaccess.com/team/.well-known/openid-configuration"
                    .to_owned()
            )
        );
    }

    #[test]
    fn an_issuer_with_no_path_gets_the_plain_well_known_url() {
        let urls = well_known_urls("https://example.cloudflareaccess.com");
        assert_eq!(
            urls[0],
            "https://example.cloudflareaccess.com/.well-known/oauth-authorization-server"
        );
        assert_eq!(urls.len(), 2, "there is no path form to try: {urls:?}");
    }

    #[test]
    fn a_trailing_slash_on_the_issuer_does_not_double_up() {
        let urls = well_known_urls("https://example.cloudflareaccess.com/");
        assert_eq!(
            urls[0],
            "https://example.cloudflareaccess.com/.well-known/oauth-authorization-server"
        );
        assert!(!urls[0].contains("//.well-known"));
    }

    #[test]
    fn the_rfc_8414_name_is_tried_before_the_openid_one() {
        let urls = well_known_urls("https://x");
        assert!(urls[0].contains(WELL_KNOWN_AS));
        assert!(urls[1].contains(WELL_KNOWN_OIDC));
    }

    #[test]
    fn an_origin_is_split_from_its_path() {
        assert_eq!(split_origin("https://host/a/b"), ("https://host", "/a/b"));
        assert_eq!(split_origin("https://host:8443/a"), ("https://host:8443", "/a"));
        assert_eq!(split_origin("https://host"), ("https://host", ""));
        assert_eq!(split_origin("not-a-url"), ("not-a-url", ""));
    }

    #[test]
    fn a_server_advertising_s256_is_accepted_and_one_advertising_only_plain_is_not() {
        let mut server = AuthorizationServer {
            issuer: "https://x".to_owned(),
            authorization_endpoint: "https://x/authorize".to_owned(),
            token_endpoint: "https://x/token".to_owned(),
            registration_endpoint: Some("https://x/register".to_owned()),
            code_challenge_methods_supported: Some(vec!["S256".to_owned()]),
            scopes_supported: None,
        };
        assert!(server.supports_s256());

        server.code_challenge_methods_supported = Some(vec!["plain".to_owned()]);
        assert!(!server.supports_s256(), "`plain` puts the verifier on the wire");

        // A server that says nothing is given the benefit of the doubt: S256 is
        // mandatory to implement, and refusing every server that omits an
        // optional advertisement would break more than it protects.
        server.code_challenge_methods_supported = None;
        assert!(server.supports_s256());
    }

    #[test]
    fn the_unprotected_warning_says_what_is_actually_wrong() {
        assert!(UNPROTECTED_WARNING.contains("NOT protected"));
        assert!(UNPROTECTED_WARNING.contains("read every secret"));
    }

    #[test]
    fn probe_outcomes_are_distinguishable() {
        assert!(Probe::Unprotected.is_unprotected());
        assert!(!Probe::ManagedOAuthDisabled.is_unprotected());
        assert!(!Probe::ManagedOAuth { metadata_url: None }.is_unprotected());
    }

    #[test]
    fn protected_resource_metadata_parses() {
        let metadata: ProtectedResource = serde_json::from_str(
            r#"{"resource":"https://prick.example.com","authorization_servers":["https://example.cloudflareaccess.com"]}"#,
        )
        .expect("the shape matches");
        assert_eq!(metadata.authorization_servers, ["https://example.cloudflareaccess.com"]);
    }

    #[test]
    fn authorization_server_metadata_ignores_fields_it_does_not_need() {
        let metadata: AuthorizationServer = serde_json::from_str(
            r#"{"issuer":"https://i","authorization_endpoint":"https://i/a","token_endpoint":"https://i/t","jwks_uri":"https://i/jwks","response_modes_supported":["query"]}"#,
        )
        .expect("unknown fields must be ignored");
        assert_eq!(metadata.issuer, "https://i");
        assert!(metadata.registration_endpoint.is_none());
    }

    #[test]
    fn a_registration_without_a_secret_parses() {
        let registration: Registration =
            serde_json::from_str(r#"{"client_id":"abc"}"#).expect("the shape matches");
        assert_eq!(registration.client_id, "abc");
        assert!(registration.client_secret.is_none());
    }
}
