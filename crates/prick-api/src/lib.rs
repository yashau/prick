//! HTTP client for the prick API.
//!
//! # Status
//!
//! Skeleton. The module layout and the error contract are settled; the
//! transport is not yet wired.
//!
//! # Planned module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`config`] | Base URL, timeout, request id -- everything a request needs that is not a route |
//! | [`error`] | [`ApiError`], and the mapping from transport and status outcomes to [`prick_core::classify::ErrorKind`] |
//! | [`models`] | Typed request and response bodies |
//! | [`client`] | The transport itself |
//!
//! # Decisions this crate is bound by
//!
//! - `reqwest` with **rustls + ring**, never OpenSSL. Cross-compiling
//!   `openssl-sys` to `aarch64-musl` is the worst part of Rust release
//!   engineering, and `deny.toml` bans the crate outright so the constraint
//!   cannot erode.
//! - `rustls-platform-verifier`, so a corporate TLS proxy with a private
//!   certificate authority works without a flag.
//! - `tokio` current-thread. There is no concurrency to exploit in a CLI that
//!   issues one request at a time.
//! - **Status is checked before the body is deserialised.** Parsing first is
//!   what turns a proxy's HTML error page into an unreadable decoding error;
//!   see [`prick_core::classify`].
//! - `X-Request-Id` is generated per request and echoed in every error, so an
//!   id pasted from a user's terminal locates the exact audit row.

pub mod client;
pub mod config;
pub mod error;
pub mod models;

pub use client::Client;
pub use config::Config;
pub use error::{ApiError, Transport};
