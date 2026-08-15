//! HTTP client for the prick API.
//!
//! # Module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`config`] | Base URL, timeout, retry policy -- everything a request needs that is not a route |
//! | [`credential`] | What a request authenticates as |
//! | [`error`] | [`ApiError`], and the mapping from transport and status outcomes to [`prick_core::classify::ErrorKind`] |
//! | [`models`] | Typed request and response bodies |
//! | [`ops`] | One typed function per route, and the request shapes they send |
//! | [`response`] | Reading a response in the order that produces a useful error |
//! | [`tls`] | rustls with ring, and the platform trust store |
//! | [`client`] | The transport itself |
//!
//! # Where a route lives
//!
//! In [`ops`], never in a command. A route is a fact about the server, and
//! `docs/openapi.json` -- generated from the router and kept fresh by a CI gate
//! -- is what it is checked against. Keeping paths and request bodies in one
//! module is what lets a test assert the method, the path and the body of every
//! call this client can make.
//!
//! # The defect this crate is shaped around
//!
//! Parsing a body before checking the status. When the server is unreachable
//! and a proxy answers with HTML, the JSON decoder fails first and the user is
//! told `SyntaxError: Unexpected token '<'` -- a message about the wrong layer,
//! naming nothing they can act on.
//!
//! So the order is fixed and enforced by the shape of the code rather than by a
//! convention: [`client::Client::fetch`] produces a
//! [`response::ResponseFacts`], [`response::classify`] gets to conclude from
//! those alone, and only [`client::Client::request_json`] parses. There is no
//! path that reaches a deserialiser without passing the classifier first.
//!
//! # Decisions this crate is bound by
//!
//! - `reqwest` with **rustls + ring**, never OpenSSL. `deny.toml` bans the
//!   crate outright so the constraint cannot erode.
//! - `rustls-platform-verifier`, so a corporate TLS proxy with a private
//!   certificate authority works without a flag.
//! - The cryptographic provider is installed **by name** at startup, so a
//!   transitive dependency cannot change which implementation the process uses.
//! - `tokio` current-thread. There is no concurrency to exploit in a CLI that
//!   issues one request at a time.
//! - `X-Request-Id` is generated per request and echoed in every error, so an
//!   id pasted from a user's terminal locates the exact audit row.
//! - The response body is capped, and nothing from it reaches an error except
//!   an HTML `<title>`.

pub mod client;
pub mod config;
pub mod credential;
pub mod error;
pub mod models;
pub mod ops;
pub mod response;
pub mod tls;

pub use client::{Body, Client, Received};
pub use config::Config;
pub use credential::Credential;
pub use error::{ApiError, Transport};
pub use ops::{BatchRequest, GrantScope, ImportFormat, ImportRequest, RevealReason, WriteMode};
pub use response::ResponseFacts;

/// Builds the runtime the CLI drives every request from.
///
/// Current-thread, because a CLI issues one request at a time and a
/// work-stealing scheduler would only add threads and a scheduling hop. It is
/// built by the binary and passed down, rather than created per call, so that
/// `prk run` does not stand up and tear down a reactor between fetching secrets
/// and replacing itself with the child.
///
/// # Errors
///
/// Whatever `tokio` reported. In practice this fails only when the process
/// cannot create the event loop's file descriptors.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread().enable_all().build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_runtime_is_single_threaded_and_usable() {
        let runtime = super::runtime().expect("building a runtime must succeed");
        let answer = runtime.block_on(async { 1 + 1 });
        assert_eq!(answer, 2);
    }
}
