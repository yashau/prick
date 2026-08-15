//! Authentication against Cloudflare Access.
//!
//! # Module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`credential`] | The two identity types, and where each is discovered |
//! | [`discovery`] | Probing `/health`, RFC 9728 and RFC 8414 metadata, RFC 7591 registration |
//! | [`oauth`] | PKCE, the authorization request, the token endpoint, the whole login |
//! | [`callback`] | The loopback listener and its forty-line HTTP parser |
//! | [`session`] | Turning stored state into the credential a request carries |
//! | [`store`] | Persisting tokens |
//! | [`browser`] | Opening the system browser |
//! | [`error`] | Why authentication failed, and what to do about it |
//!
//! # Two identity types, one login path
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
//! # Token storage
//!
//! The default is a **0600 file, not the OS keyring**, and that is deliberate:
//!
//! - Over SSH or in CI there is no D-Bus session, so a keyring lookup fails or
//!   blocks.
//! - On macOS the Keychain ACL is bound to the binary's code signature, so
//!   every update re-prompts for authorisation -- unusable from inside
//!   `prk run`, which is exactly where a prompt cannot be answered.
//!
//! `--storage keyring` exists in the interface and currently reports that the
//! backend is not available in this build, rather than silently writing a file
//! instead. See [`store::StorageBackend`].
//!
//! # What this crate never does
//!
//! It does not write a service token to disk. A token that arrived in the
//! environment stays in the environment: persisting it would copy a credential
//! out of a CI system's control and into a file the CI system does not clean
//! up. `--save` is the only thing that changes that, and it is the caller's
//! decision, not this crate's.

pub mod browser;
pub mod callback;
pub mod credential;
pub mod discovery;
pub mod error;
pub mod oauth;
pub mod session;
pub mod store;

pub use credential::{Credential, ServiceToken, TokenSource, service_token_from_env};
pub use discovery::Probe;
pub use error::AuthError;
pub use oauth::{LoginOptions, LoginOutcome, login};
pub use session::{Resolved, resolve};
pub use store::{StorageBackend, StoredSession, TokenStore, Tokens};
