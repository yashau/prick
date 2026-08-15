//! `prk doctor`.
//!
//! # Status
//!
//! Not implemented.
//!
//! TODO: report, in order, and continue past failures rather than stopping at
//! the first -- the value of a diagnostic command is the whole picture:
//!
//! 1. The resolved API URL and where it came from (flag, environment, config).
//! 2. DNS resolution and TCP reachability of that host.
//! 3. The TLS handshake, naming the trust anchor on failure so a corporate
//!    proxy is identifiable rather than merely broken.
//! 4. `/health`, and whether the response actually identifies a prick server.
//! 5. Which credential was found, and its expiry. Never the credential itself.
//! 6. Token file permissions -- a token readable by group or other is a finding.
//! 7. Whether the binary is being invoked through the npm shim, mentioning the
//!    direct-install alternatives once. The shim routes every call through Node
//!    and keeps a Node parent alive for the child's lifetime during `prk run`,
//!    which defeats the point of replacing the process.
