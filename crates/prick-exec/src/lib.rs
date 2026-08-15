//! Child process launch for `prk run`.
//!
//! # Module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`guard`] | Refusing loader-controlling variables unless opted in |
//! | [`launch`] | Resolving the program, building the environment, starting the child |
//! | [`signal`] | Exit codes, signal dispositions and job control |
//! | [`cmdline`] | Escaping arguments for a Windows batch shim |
//! | [`error`] | Why a launch did not happen, and what a shell would have exited with |
//! | `winjob` | Windows job objects and console control handling |
//! | `winsec` | Restricting a file to the current user, for `prick-auth` |
//!
//! # Why this crate can be small
//!
//! Argv is carried as `Vec<OsString>` from `clap`'s `trailing_var_arg` all the
//! way to `Command::args()`, which passes it to `execvp` as a vector. **There
//! is never a command string**, so there is nothing to quote and nothing to
//! escape -- the entire class of shell-quoting bugs is structurally absent
//! rather than defended against, and non-UTF-8 arguments survive byte for byte.
//!
//! The single exception is a Windows `.cmd` shim, where `cmd.exe` genuinely
//! does interpose a string. [`cmdline`] is that exception, it is confined to
//! one module, and it has more tests than anything else here.
//!
//! # The `unsafe` in this crate
//!
//! `prick-core` is `#![forbid(unsafe_code)]` and is the miri target. This crate
//! is the opposite: it is where every `unsafe` in the workspace lives, and it
//! is exactly what miri **cannot** reach, because miri cannot execute a
//! process, a signal handler, or an FFI call.
//!
//! That is stated plainly rather than papered over. The consequences are:
//!
//! - Every `unsafe` block carries a `// SAFETY:` comment naming the invariant
//!   it relies on, not merely asserting that one exists.
//! - The surface is kept as small as it can be: three places on Unix (the
//!   `pre_exec` hook and the two calls inside it) and the Windows job, console
//!   and security bindings.
//! - Verification comes from **real integration tests that start real
//!   processes**, in `tests/`. There is no substitute available.
//!
//! # Nothing is written to disk
//!
//! Secrets reach the child through its environment block and nowhere else. This
//! crate creates no temporary file, no fifo and no dotenv, so there is no
//! window in which a secret exists at a path something else could read.

// This crate is the workspace's single home for `unsafe`; see the module docs
// above. `unsafe_code` is `warn` workspace-wide precisely so that lifting it
// has to be deliberate, visible, and in one place.
#![allow(unsafe_code)]

pub mod cmdline;
pub mod error;
pub mod guard;
pub mod launch;
pub mod signal;

#[cfg(windows)]
pub mod winjob;
#[cfg(windows)]
pub mod winsec;

pub use error::LaunchError;
pub use guard::{EnvGuard, GuardError};
pub use launch::{LaunchSpec, run};
