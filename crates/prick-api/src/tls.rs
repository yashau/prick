//! TLS configuration.
//!
//! # rustls and ring, never OpenSSL
//!
//! `deny.toml` bans `openssl`, `openssl-sys`, `native-tls` and `hyper-tls`
//! outright, and `reqwest` is pulled in with `default-features = false` so
//! nothing can re-enable them transitively. The reason is release engineering
//! rather than cryptography: cross-compiling `openssl-sys` to `aarch64-musl`
//! needs a C toolchain, a vendored source tree and a set of environment
//! variables per target, and a dynamically linked `libssl` would defeat the
//! point of shipping a static binary.
//!
//! `ring` rather than `aws-lc-rs` for the same reason -- `aws-lc-sys` builds C
//! with cmake, which puts a compiler on the critical path of every target.
//!
//! # Why the provider is installed explicitly
//!
//! `rustls` resolves its cryptographic provider from a **process-global**
//! default. When exactly one provider feature is enabled the default is
//! implied, but that is a property of the whole dependency graph, not of this
//! crate: a transitive dependency that enables `aws-lc-rs` silently changes
//! which implementation every TLS handshake in the process uses, and nothing
//! fails to compile.
//!
//! [`install_crypto_provider`] therefore installs `ring` by name at startup.
//! After it has run, the answer to "which cryptography is this binary using"
//! is a line of code rather than an inference over the lock file.
//!
//! # The platform verifier
//!
//! Certificate roots come from the operating system, not from a bundle
//! compiled into the binary. On a corporate network that terminates TLS at a
//! proxy, the proxy's certificate authority is installed in the OS trust store
//! and nowhere else, so a binary with a baked-in root set fails every request
//! with an error that reads like the server is broken. This is the difference
//! between `prk` working on a managed laptop and not.

use std::sync::OnceLock;

use prick_core::classify::ErrorKind;
use rustls::ClientConfig;
use rustls_platform_verifier::ConfigVerifierExt as _;

use crate::error::ApiError;

/// ALPN protocols offered, in preference order.
const ALPN: [&[u8]; 2] = [b"h2", b"http/1.1"];

/// Installs `ring` as the process-wide `rustls` cryptographic provider.
///
/// Idempotent, and safe to call from anywhere. If a provider is already
/// installed -- which happens when a library got there first -- the existing
/// one is left alone rather than the call failing: replacing a provider mid
/// process is not something `rustls` supports, and refusing to run would be a
/// worse outcome than using the provider that is already there.
pub fn install_crypto_provider() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        // The error case carries the provider that was already installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Builds the `rustls` client configuration used by every request.
///
/// # Errors
///
/// Returns [`ErrorKind::TlsFailure`] if the platform's trust store cannot be
/// read, which is a real and diagnosable state -- an empty or unreadable
/// certificate store on a locked-down machine.
pub fn client_config() -> Result<ClientConfig, ApiError> {
    install_crypto_provider();

    let mut config = ClientConfig::with_platform_verifier().map_err(|err| {
        ApiError::new(
            ErrorKind::TlsFailure,
            format!("could not read the operating system's certificate store: {err}"),
        )
    })?;
    config.alpn_protocols = ALPN.iter().map(|protocol| protocol.to_vec()).collect();
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_installs_and_installing_twice_is_a_no_op() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "no cryptographic provider was installed"
        );
    }

    #[test]
    fn the_platform_trust_store_is_usable() {
        // A failure here is a genuine finding rather than a flaky test: it
        // means this machine's certificate store cannot be read, and every
        // request would fail with a TLS error.
        let config = client_config().expect("the platform trust store must be readable");
        assert_eq!(config.alpn_protocols, vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
    }

    #[test]
    fn http2_is_offered_before_http11() {
        assert_eq!(ALPN[0], b"h2");
    }
}
