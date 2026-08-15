//! Pure logic shared across the `prick` CLI crates.
//!
//! # The contract
//!
//! This crate performs **no I/O of any kind**. No filesystem, no network, no
//! clock, no environment, no randomness, no processes, no async, no `unsafe`,
//! no FFI. Every function is a total function of its arguments.
//!
//! That is enforced two ways. `#![forbid(unsafe_code)]` below covers the crate
//! itself, and `cargo miri test -p prick-core` covers the dependency tree:
//! miri cannot execute a syscall, so the suite stops passing if anyone adds a
//! file read, a `SystemTime::now()`, or a crate with a C shim.
//!
//! Miri will not *find* bugs here -- a `forbid(unsafe_code)` crate has almost
//! nothing for it to find. Its value is entirely as an enforcement mechanism
//! for the paragraph above.
//!
//! # Where the impure parts live
//!
//! | Concern | Crate |
//! |---|---|
//! | HTTP, retries, error classification from responses | `prick-api` |
//! | OAuth handshake, token storage, service tokens | `prick-auth` |
//! | Process launch, signals, job objects | `prick-exec` |
//! | Terminal, argument parsing, rendering | `prk` |

#![forbid(unsafe_code)]

pub mod calver;
pub mod classify;
pub mod dotenv;
pub mod format;
pub mod keyname;
pub mod pkce;
pub mod redact;
pub mod scope;
pub mod slug;
pub mod urlpath;
