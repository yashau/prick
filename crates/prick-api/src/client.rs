//! The HTTP transport.
//!
//! # The order of operations
//!
//! Every response goes through the same three stages, and the ordering is the
//! reason this module exists at all. See [`crate::response`] for what each one
//! can conclude and why parsing last is not a style preference.
//!
//! # What this client is not
//!
//! No cookie jar: a cookie store is a place for a session to persist where
//! nothing audits it. No redirect following: a redirect to
//! `*.cloudflareaccess.com` is the single most informative thing an
//! unauthenticated request can produce, and following it would replace that
//! with an HTML login page and a `200`. No CORS handling: this is not a
//! browser.

use std::fmt::Write as _;
use std::time::Duration;

use prick_core::classify::ErrorKind;
use serde::de::DeserializeOwned;

use crate::config::Config;
use crate::credential::{Credential, HEADER_REQUEST_ID};
use crate::error::{ApiError, Transport};
use crate::models::ApiErrorBody;
use crate::response::{BODY_CAP, Classified, ResponseFacts, classify, html_title};

/// What a request carries, if anything.
///
/// An enum rather than two entry points, so the retry loop, the credential
/// handling and the three-stage response read exist exactly once. The token
/// endpoint needs form encoding and the API needs JSON; neither is worth a
/// second transport.
#[derive(Debug, Clone, Copy)]
pub enum Body<'a> {
    /// No request body.
    None,
    /// `application/json`.
    Json(&'a serde_json::Value),
    /// `application/x-www-form-urlencoded`, as OAuth 2.0 requires for the token
    /// endpoint.
    ///
    /// Values may include a `code_verifier` or a refresh token. They are
    /// borrowed for the duration of the call and never retained.
    Form(&'a [(&'a str, &'a str)]),
}

impl Body<'_> {
    /// Attaches this body to a request.
    fn apply(self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Self::None => request,
            Self::Json(value) => request.json(value),
            Self::Form(pairs) => request.form(pairs),
        }
    }
}

/// A response, read to the point where it can be classified.
#[derive(Debug, Clone)]
pub struct Received {
    /// What the response said about itself.
    pub facts: ResponseFacts,
    /// The body, capped at [`BODY_CAP`].
    ///
    /// Held only long enough to deserialise or to pull a `<title>` out of. It
    /// never reaches an error, a log line or a diagnostic.
    body: Vec<u8>,
}

impl Received {
    /// The body bytes, capped at [`BODY_CAP`].
    pub fn body(&self) -> &[u8] {
        &self.body
    }
}

/// A configured API client.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    config: Config,
    credential: Credential,
}

impl Client {
    /// Builds a client from a configuration and a credential.
    ///
    /// Must be called with a `tokio` reactor available, because the connection
    /// pool registers with it.
    ///
    /// # Errors
    ///
    /// Returns [`ErrorKind::TlsFailure`] if the platform trust store cannot be
    /// read, and [`ErrorKind::Unknown`] if the HTTP stack cannot be built.
    pub fn new(config: Config, credential: Credential) -> Result<Self, ApiError> {
        let tls = crate::tls::client_config()?;

        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .user_agent(Config::user_agent())
            .timeout(config.timeout())
            // A redirect is diagnostic information, not something to follow.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|err| {
                ApiError::new(ErrorKind::Unknown, format!("could not build an HTTP client: {err}"))
            })?;

        Ok(Self { http, config, credential })
    }

    /// The configuration this client was built with.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The credential this client presents.
    pub fn credential(&self) -> &Credential {
        &self.credential
    }

    /// Replaces the credential, leaving the connection pool intact.
    ///
    /// Used after a transparent token refresh: rebuilding the client would
    /// throw away every warm connection for the sake of one header.
    pub fn set_credential(&mut self, credential: Credential) {
        self.credential = credential;
    }

    /// The absolute URL for a route, with every segment percent-encoded.
    pub fn url(&self, segments: &[&str]) -> String {
        self.config.url(segments)
    }

    /// Sends a request and reads the response far enough to classify it.
    ///
    /// **Does not fail on an HTTP error status.** A `401` carrying a
    /// `WWW-Authenticate` header is the normal, expected first step of
    /// `prk login`, and a transport that turned it into an error would have to
    /// be worked around rather than used.
    ///
    /// # Errors
    ///
    /// Only transport failures: DNS, connection, TLS and the deadline.
    pub async fn fetch(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
    ) -> Result<Received, ApiError> {
        let mut attempt = 0u32;
        loop {
            match self.fetch_once(method.clone(), url, body).await {
                Ok(received) => {
                    let retryable =
                        response_kind(&received.facts).is_some_and(ErrorKind::is_retryable);
                    if retryable && attempt < self.config.max_retries() {
                        self.backoff(attempt).await;
                        attempt += 1;
                        continue;
                    }
                    return Ok(received);
                }
                Err(err) if err.is_retryable() && attempt < self.config.max_retries() => {
                    self.backoff(attempt).await;
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Sleeps for the configured backoff, with jitter.
    ///
    /// Jitter is full rather than partial: several `prk run` invocations
    /// starting from the same CI job would otherwise retry in lockstep and
    /// reproduce the burst that caused the failure.
    async fn backoff(&self, attempt: u32) {
        let ceiling = self.config.backoff(attempt);
        if ceiling.is_zero() {
            return;
        }
        let mut bytes = [0u8; 2];
        let fraction = if getrandom::fill(&mut bytes).is_ok() {
            f64::from(u16::from_le_bytes(bytes)) / f64::from(u16::MAX)
        } else {
            0.5
        };
        tokio::time::sleep(ceiling.mul_f64(fraction).max(Duration::from_millis(1))).await;
    }

    /// One attempt, with no retry logic.
    async fn fetch_once(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
    ) -> Result<Received, ApiError> {
        let request_id = new_request_id();

        let mut request = self
            .http
            .request(method, url)
            .header("accept", "application/json")
            .header(HEADER_REQUEST_ID, &request_id);

        for (name, value) in self.credential.headers() {
            request = request.header(name, value);
        }
        request = body.apply(request);

        // Stage 1: transport. There is no status yet, so nothing else can be
        // concluded and no body exists to be misread.
        let response = request.send().await.map_err(|err| map_transport(&err, url))?;

        // Stage 2: what the response says about itself.
        let mut facts = read_facts(&response);
        if facts.request_id.is_none() {
            facts.request_id = Some(request_id);
        }

        let (body, truncated) = read_capped_body(response).await?;
        facts.truncated = truncated;
        if !facts.is_json() {
            facts.title = html_title(&body);
        }

        Ok(Received { facts, body })
    }

    /// Sends a request and deserialises a successful JSON response.
    ///
    /// Stage 3, and only stage 3. By the time this parses anything, the status,
    /// the content type and the Cloudflare headers have all already been given
    /// the chance to explain the failure.
    ///
    /// # Errors
    ///
    /// Any transport failure, any classified response failure, the server's own
    /// error envelope, or a body that does not match `T`.
    pub async fn request_json<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
    ) -> Result<T, ApiError> {
        let received = self.fetch(method, url, body).await?;
        decode(received)
    }

    /// Sends a request that is not expected to answer with a document.
    ///
    /// A `204`, or a `200` with an empty body, is success. Anything else goes
    /// through the same classification as every other response -- a `DELETE`
    /// that gets an HTML login page must fail for the same reason and with the
    /// same message as a `GET` that does.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`].
    pub async fn request_ok(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Body<'_>,
    ) -> Result<(), ApiError> {
        let received = self.fetch(method, url, body).await?;

        if (200..300).contains(&received.facts.status) && received.body().is_empty() {
            return Ok(());
        }

        // Not empty, so it is either a real error or a document nobody asked
        // for. Either way the ordinary path decides, and a stray document is
        // discarded rather than treated as a failure.
        decode::<serde::de::IgnoredAny>(received).map(|_| ())
    }

    /// `DELETE` a resource.
    ///
    /// # Errors
    ///
    /// See [`Client::request_ok`].
    pub async fn delete(&self, url: &str) -> Result<(), ApiError> {
        self.request_ok(reqwest::Method::DELETE, url, Body::None).await
    }

    /// `GET` a JSON document.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`].
    pub async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, ApiError> {
        self.request_json(reqwest::Method::GET, url, Body::None).await
    }

    /// `PATCH` a JSON document and read one back.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`].
    pub async fn patch_json<T: DeserializeOwned>(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<T, ApiError> {
        self.request_json(reqwest::Method::PATCH, url, Body::Json(body)).await
    }

    /// `POST` a form and read a JSON document back.
    ///
    /// The shape every OAuth 2.0 token endpoint requires.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`].
    pub async fn post_form<T: DeserializeOwned>(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<T, ApiError> {
        self.request_json(reqwest::Method::POST, url, Body::Form(form)).await
    }

    /// `POST` a JSON document and read one back.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`].
    pub async fn post_json<T: DeserializeOwned>(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<T, ApiError> {
        self.request_json(reqwest::Method::POST, url, Body::Json(body)).await
    }

    /// Fetches `/api/v1/health`, and checks that the answer is from a prick
    /// server.
    ///
    /// A `200` with a JSON body is not sufficient evidence on its own: a
    /// captive portal, a status page and a misconfigured proxy all produce one.
    ///
    /// **Under the API prefix, not at the origin.** The Worker hands `/api/*`
    /// to the API and everything else to the admin UI, so probing the origin's
    /// `/health` reads SvelteKit's 404 page and reports that this is not a
    /// prick server -- which is true of the path, and false of the deployment.
    ///
    /// # Errors
    ///
    /// See [`Client::request_json`], plus [`ErrorKind::NotPrick`] when
    /// something answered but did not identify itself as this service.
    pub async fn health(&self) -> Result<crate::models::Health, ApiError> {
        let url = self.config.url(&["health"]);
        let health: crate::models::Health = self.get_json(&url).await?;
        if health.is_prick() {
            Ok(health)
        } else {
            Err(ApiError::new(
                ErrorKind::NotPrick,
                format!(
                    "{url} answered with JSON, but it identifies itself as `{}` rather than as \
                     this service",
                    health.service
                ),
            ))
        }
    }
}

/// The taxonomy entry a response maps to, or `None` if it is a success.
///
/// [`classify`] deliberately returns `None` for a JSON error body, because the
/// server's own envelope is the better message. That leaves the status as the
/// only thing left to decide retryability from, which is what this adds.
fn response_kind(facts: &ResponseFacts) -> Option<ErrorKind> {
    classify(facts)
        .map(|classified| classified.kind)
        .or_else(|| (facts.status >= 400).then(|| ErrorKind::from_status(facts.status)))
}

/// Turns a received response into a value, or into the best available error.
fn decode<T: DeserializeOwned>(received: Received) -> Result<T, ApiError> {
    if let Some(classified) = classify(&received.facts) {
        return Err(ApiError::from_response(received.facts, classified));
    }

    // A JSON error status: the server's own envelope is more specific than
    // anything this client could infer, so it is preferred when present. The
    // envelope is flat -- `{code, message, request_id?, hint?, issues?}` -- and
    // a client expecting a wrapping `error` object silently falls back to
    // "the server returned HTTP 422", discarding the only useful part.
    if received.facts.status >= 400 {
        let body = serde_json::from_slice::<ApiErrorBody>(&received.body).ok();
        let hint = body.as_ref().and_then(|body| body.hint.clone());
        let message = body.map_or_else(
            || format!("the server returned HTTP {}", received.facts.status),
            ApiErrorBody::into_message,
        );

        // The envelope's own `request_id` is deliberately not read: it is the
        // same value the `X-Request-Id` header carries, the header is set by
        // middleware mounted ahead of every route, and taking it from one place
        // means there is no case where the two could be reported differently.
        let err = ApiError::from_server(received.facts, message);
        return Err(match hint {
            Some(hint) => err.with_server_hint(hint),
            None => err,
        });
    }

    serde_json::from_slice(&received.body).map_err(|err| {
        // Names the shape mismatch and its position, never the content. A
        // response body from a secrets manager may contain a secret, and this
        // code cannot tell which fields do.
        ApiError::from_response(
            received.facts,
            Classified {
                kind: ErrorKind::NotPrick,
                message: format!(
                    "the server returned JSON that does not match what this client expects \
                     (at line {}, column {})",
                    err.line(),
                    err.column()
                ),
            },
        )
    })
}

/// Maps `reqwest`'s error surface onto the transport outcomes.
fn map_transport(err: &reqwest::Error, url: &str) -> ApiError {
    let host = url.split('/').nth(2).unwrap_or(url);

    // Connection failures are checked before the deadline, because a connect
    // that never completes is reported as both and "could not connect to the
    // host" is the more useful of the two: it points at DNS, a firewall or the
    // wrong hostname rather than at --timeout.
    if err.is_timeout() && !err.is_connect() {
        return ApiError::transport(
            Transport::Timeout,
            format!("the request to {host} did not complete before the deadline"),
        );
    }

    // `is_connect` covers DNS, refused connections and TLS alike, so the
    // distinction has to come from the chain of sources. Matching on the text
    // is unpleasant; the alternative is telling someone behind a corporate
    // proxy that the host is unreachable, which sends them to the wrong place
    // entirely.
    let mut chain: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut rendered = String::new();
    while let Some(source) = chain {
        rendered.push_str(&source.to_string());
        rendered.push(' ');
        chain = source.source();
    }
    let lowered = rendered.to_lowercase();

    if lowered.contains("certificate")
        || lowered.contains("tls")
        || lowered.contains("handshake")
        || lowered.contains("unknownissuer")
    {
        return ApiError::transport(
            Transport::Tls,
            format!("the TLS handshake with {host} failed"),
        );
    }

    ApiError::transport(Transport::Unreachable, format!("could not connect to {host}"))
}

/// Reads the headers this client reasons about.
fn read_facts(response: &reqwest::Response) -> ResponseFacts {
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };

    ResponseFacts {
        status: response.status().as_u16(),
        content_type: header("content-type")
            .map(|value| value.split(';').next().unwrap_or(&value).trim().to_ascii_lowercase()),
        cf_ray: header("cf-ray"),
        cf_mitigated: header("cf-mitigated"),
        www_authenticate: header("www-authenticate"),
        location: header("location"),
        request_id: header(HEADER_REQUEST_ID),
        title: None,
        truncated: false,
    }
}

/// Reads at most [`BODY_CAP`] bytes, reporting whether there was more.
///
/// Chunk by chunk rather than `bytes()`, so a server that advertises a
/// gigabyte cannot make this allocate one.
async fn read_capped_body(mut response: reqwest::Response) -> Result<(Vec<u8>, bool), ApiError> {
    let mut body = Vec::new();
    let mut truncated = false;

    loop {
        let chunk = response.chunk().await.map_err(|err| {
            if err.is_timeout() {
                ApiError::transport(Transport::Timeout, "the response body stalled")
            } else {
                ApiError::transport(
                    Transport::Unreachable,
                    "the connection closed before the response body was complete",
                )
            }
        })?;

        let Some(chunk) = chunk else { break };
        let room = BODY_CAP.saturating_sub(body.len());
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }

    Ok((body, truncated))
}

/// A per-request identifier, echoed by the server and stored in the audit row.
///
/// Random rather than sequential: a counter would leak how many requests this
/// process has made, and would collide across concurrent invocations.
fn new_request_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // A CSPRNG failure is not a reason to abandon the request; this
        // identifier is for correlation, not for security.
        return "prk-unidentified".to_owned();
    }
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_builds_encoded_routes_from_its_config() {
        let client = Client::new(Config::new("https://prick.example.com/"), Credential::Anonymous)
            .expect("building a client must succeed");
        assert_eq!(
            client.url(&["projects", "a/b"]),
            "https://prick.example.com/api/v1/projects/a%2Fb"
        );
        assert_eq!(client.config().base_url(), "https://prick.example.com");
    }

    #[test]
    fn a_request_id_is_random_and_hex() {
        let first = new_request_id();
        let second = new_request_id();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second, "two request ids collided, which means no entropy");
    }

    #[test]
    fn a_credential_can_be_swapped_without_rebuilding_the_client() {
        let mut client = Client::new(Config::new("https://x"), Credential::Anonymous)
            .expect("building a client must succeed");
        assert!(!client.credential().is_present());

        client.set_credential(Credential::Bearer(secrecy::SecretString::from("t")));
        assert!(client.credential().is_present());
    }
}
