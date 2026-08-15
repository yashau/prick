//! The API error type and its mapping into the shared taxonomy.

use prick_core::classify::ErrorKind;

use crate::response::{Classified, ResponseFacts};

/// A transport-level outcome, before any HTTP status exists.
///
/// Named separately from [`ErrorKind`] because producing one requires a socket;
/// classifying one does not. `prick-api` maps `reqwest`'s error surface onto
/// this enum, and everything downstream sees only the classified kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Transport {
    /// The host did not resolve, or nothing accepted the connection.
    Unreachable,
    /// The TLS handshake failed.
    Tls,
    /// The deadline expired.
    Timeout,
}

impl Transport {
    /// Maps a transport outcome into the shared taxonomy.
    pub fn kind(self) -> ErrorKind {
        match self {
            Self::Unreachable => ErrorKind::Unreachable,
            Self::Tls => ErrorKind::TlsFailure,
            Self::Timeout => ErrorKind::Timeout,
        }
    }
}

/// A failed API call.
///
/// Carries the request id so an operator can quote it and an administrator can
/// find the exact audit row, and the response facts so `prk doctor` can say
/// what actually answered. It deliberately carries no response **body**: an
/// error rendering path must not be able to echo something the server sent,
/// because this client cannot tell a diagnostic from a secret.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    kind: ErrorKind,
    message: String,
    request_id: Option<String>,
    server_hint: Option<String>,
    // Boxed so the common `ApiError` stays small; a failure carrying nine
    // optional strings by value would widen every `Result` in the crate.
    facts: Option<Box<ResponseFacts>>,
}

impl ApiError {
    /// Builds an error of a given kind.
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), request_id: None, server_hint: None, facts: None }
    }

    /// Builds an error from a transport outcome.
    pub fn transport(transport: Transport, message: impl Into<String>) -> Self {
        Self::new(transport.kind(), message)
    }

    /// Builds an error from a classified response.
    ///
    /// The request id is taken from the response rather than supplied, so it is
    /// impossible to attach the wrong one.
    pub fn from_response(facts: ResponseFacts, classified: Classified) -> Self {
        Self {
            kind: classified.kind,
            message: classified.message,
            request_id: facts.request_id.clone(),
            server_hint: None,
            facts: Some(Box::new(facts)),
        }
    }

    /// Builds an error from a status code and the server's own message.
    ///
    /// Used when the server answered with a JSON error envelope, where its
    /// message is more specific than anything this client could infer.
    pub fn from_server(facts: ResponseFacts, message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::from_status(facts.status),
            message: message.into(),
            request_id: facts.request_id.clone(),
            server_hint: None,
            facts: Some(Box::new(facts)),
        }
    }

    /// Attaches the `X-Request-Id` the server echoed.
    #[must_use]
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    /// Attaches the `hint` from the server's error envelope.
    ///
    /// Kept apart from [`ApiError::hint`], which is the client's own static
    /// advice for a *kind* of failure. The server's is about this one request
    /// -- which route to use instead, which variable to set -- and is therefore
    /// the better of the two whenever it exists.
    #[must_use]
    pub fn with_server_hint(mut self, hint: impl Into<String>) -> Self {
        self.server_hint = Some(hint.into());
        self
    }

    /// The classified kind.
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    /// The request id, when the response carried one.
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// What the response said about itself, when there was a response.
    pub fn facts(&self) -> Option<&ResponseFacts> {
        self.facts.as_deref()
    }

    /// The actionable next step for this *kind* of failure.
    ///
    /// Static, because it is this client's advice rather than the server's. See
    /// [`ApiError::server_hint`] for what the failing request itself said.
    pub fn hint(&self) -> Option<&'static str> {
        self.kind.hint()
    }

    /// The `hint` the server's error envelope carried, if any.
    pub fn server_hint(&self) -> Option<&str> {
        self.server_hint.as_deref()
    }

    /// The process exit code this failure should produce.
    pub fn exit_code(&self) -> u8 {
        self.kind.exit_code()
    }

    /// Whether retrying the identical request could plausibly succeed.
    pub fn is_retryable(&self) -> bool {
        self.kind.is_retryable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_outcomes_map_into_the_taxonomy() {
        assert_eq!(Transport::Unreachable.kind(), ErrorKind::Unreachable);
        assert_eq!(Transport::Tls.kind(), ErrorKind::TlsFailure);
        assert_eq!(Transport::Timeout.kind(), ErrorKind::Timeout);
    }

    #[test]
    fn every_transport_failure_carries_a_hint_and_exit_code_7() {
        for transport in [Transport::Unreachable, Transport::Tls, Transport::Timeout] {
            let err = ApiError::transport(transport, "could not reach the server");
            assert!(err.hint().is_some(), "{transport:?} has no hint");
            assert_eq!(err.exit_code(), 7);
        }
    }

    #[test]
    fn the_request_id_survives_onto_the_error() {
        let err = ApiError::new(ErrorKind::ServerError, "internal error")
            .with_request_id("01J8Z3K9X0000000000000000");
        assert_eq!(err.request_id(), Some("01J8Z3K9X0000000000000000"));
        assert_eq!(err.to_string(), "internal error");
    }

    #[test]
    fn an_error_without_a_request_id_reports_none() {
        assert_eq!(ApiError::new(ErrorKind::NotFound, "no such project").request_id(), None);
    }

    #[test]
    fn a_classified_response_carries_its_facts_and_its_request_id() {
        let facts = ResponseFacts {
            status: 403,
            content_type: Some("text/html".to_owned()),
            cf_ray: Some("8f0c-LHR".to_owned()),
            request_id: Some("req-1".to_owned()),
            ..ResponseFacts::default()
        };
        let err = ApiError::from_response(
            facts,
            Classified { kind: ErrorKind::Forbidden, message: "denied".to_owned() },
        );

        assert_eq!(err.kind(), ErrorKind::Forbidden);
        assert_eq!(err.request_id(), Some("req-1"));
        assert_eq!(err.facts().and_then(|f| f.cf_ray.as_deref()), Some("8f0c-LHR"));
        assert_eq!(err.exit_code(), 4);
    }

    #[test]
    fn a_server_envelope_keeps_the_servers_own_message() {
        let facts = ResponseFacts { status: 409, ..ResponseFacts::default() };
        let err = ApiError::from_server(facts, "another writer changed this environment");
        assert_eq!(err.kind(), ErrorKind::Conflict);
        assert_eq!(err.to_string(), "another writer changed this environment");
        assert!(err.is_retryable());
    }

    #[test]
    fn the_servers_own_hint_is_kept_apart_from_this_clients() {
        let facts = ResponseFacts { status: 400, ..ResponseFacts::default() };
        let err = ApiError::from_server(facts, "This operation does not support a precondition.")
            .with_server_hint("Only `secrets:batch` and `secrets:import` evaluate If-Match.");

        assert_eq!(
            err.server_hint(),
            Some("Only `secrets:batch` and `secrets:import` evaluate If-Match.")
        );
        // Validation carries no static hint, so the server's is the only one.
        assert_eq!(err.hint(), None);
    }

    #[test]
    fn an_error_never_carries_a_response_body() {
        // The type has nowhere to put one. This test exists so that adding a
        // body field is a deliberate act with a failing test attached.
        let facts = ResponseFacts { status: 500, ..ResponseFacts::default() };
        let err = ApiError::from_server(facts, "boom");
        let rendered = format!("{:?}", err.facts());
        assert!(!rendered.contains("body"), "the facts grew a body field: {rendered}");
    }
}
