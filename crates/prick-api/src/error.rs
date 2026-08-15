//! The API error type and its mapping into the shared taxonomy.

use prick_core::classify::ErrorKind;

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
/// find the exact audit row. It deliberately carries no response *body*: an
/// error rendering path must not be able to echo a value the server sent.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    kind: ErrorKind,
    message: String,
    request_id: Option<String>,
}

impl ApiError {
    /// Builds an error of a given kind.
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), request_id: None }
    }

    /// Builds an error from a transport outcome.
    pub fn transport(transport: Transport, message: impl Into<String>) -> Self {
        Self::new(transport.kind(), message)
    }

    /// Attaches the `X-Request-Id` the server echoed.
    #[must_use]
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
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

    /// The actionable next step for this failure.
    pub fn hint(&self) -> Option<&'static str> {
        self.kind.hint()
    }

    /// The process exit code this failure should produce.
    pub fn exit_code(&self) -> u8 {
        self.kind.exit_code()
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
}
