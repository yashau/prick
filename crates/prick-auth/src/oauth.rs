//! The managed OAuth handshake.
//!
//! # Status
//!
//! Skeleton. The constants and the shape of the flow are settled; nothing
//! opens a socket yet.
//!
//! # The flow `prk login <url>` performs
//!
//! 1. **Probe `/health`.** Three outcomes, all handled explicitly:
//!    - `401` with a `WWW-Authenticate` header pointing at discovery: normal,
//!      continue.
//!    - `401` without it: managed OAuth is not enabled on the application.
//!      Fail with an error naming the exact dashboard path to enable it.
//!    - `200` with a JSON body, unauthenticated: **warn loudly.** An
//!      unauthenticated secrets manager is reachable from the internet, and
//!      that is the most important thing the tool will ever tell this operator.
//! 2. **Discover** via RFC 8414 / RFC 9728 metadata.
//! 3. **Register dynamically** for `http://127.0.0.1:<ephemeral>/callback`.
//!    The port is whatever the OS assigns; nothing is hardcoded, so two
//!    concurrent logins do not collide.
//! 4. **PKCE S256.** Generate a verifier, derive the challenge with
//!    [`prick_core::pkce::challenge_s256`], and **regenerate while
//!    [`prick_core::pkce::is_acceptable_challenge`] is false** -- see that
//!    module for the Cloudflare quirk this works around.
//! 5. **Open the browser**, then accept exactly one request on the loopback
//!    listener. `state` is compared with
//!    [`prick_core::pkce::constant_time_eq`].
//! 6. **Exchange** the code and store the tokens.
//!
//! TODO: implement steps 1-6. The CSPRNG (step 4) and the listener (step 5) are
//! why this module cannot live in `prick-core`.

/// The loopback address the callback listener binds to.
///
/// `127.0.0.1`, never `localhost`: on a dual-stack host `localhost` may resolve
/// to `::1`, and the redirect URI registered with the authorization server is a
/// literal string that must match byte for byte.
pub const CALLBACK_HOST: &str = "127.0.0.1";

/// The path the authorization server redirects back to.
pub const CALLBACK_PATH: &str = "/callback";

/// Bytes of entropy in the OAuth `state` parameter.
pub const STATE_ENTROPY_BYTES: usize = 32;

/// How long to wait for the browser round trip before giving up.
pub const LOGIN_TIMEOUT_SECS: u64 = 300;

/// Builds the redirect URI for an OS-assigned port.
///
/// The port is only known after the listener binds, which is why this takes it
/// as an argument rather than owning it.
pub fn redirect_uri(port: u16) -> String {
    format!("http://{CALLBACK_HOST}:{port}{CALLBACK_PATH}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_redirect_uri_uses_a_literal_loopback_address() {
        assert_eq!(redirect_uri(49152), "http://127.0.0.1:49152/callback");
        // `localhost` may resolve to ::1 and break the byte-for-byte match.
        assert!(!redirect_uri(1).contains("localhost"));
    }

    #[test]
    fn the_redirect_uri_is_plain_http() {
        // Loopback is exempt from the HTTPS requirement in RFC 8252, and a
        // self-signed certificate here would only produce browser warnings.
        assert!(redirect_uri(8080).starts_with("http://"));
    }
}
