//! Authentication against Cloudflare Access.
//!
//! # Status
//!
//! Skeleton. The credential model and the storage decision are settled; the
//! handshake is not yet wired.
//!
//! # Planned module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`credential`] | The two identity types, and where each is discovered |
//! | [`oauth`] | Discovery, dynamic client registration, the PKCE handshake |
//! | [`store`] | Persisting and loading tokens |
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
//! Keyring support stays available behind `--storage keyring` for people whose
//! threat model wants it.

pub mod credential;
pub mod oauth;
pub mod store;

pub use credential::Credential;
pub use store::StorageBackend;
