//! Child process launch for `prk run`.
//!
//! # Status
//!
//! Skeleton. The hazards are enumerated and the environment guard is
//! implemented; process launch is not yet wired.
//!
//! # Planned module layout
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`guard`] | Refusing loader-controlling variables unless opted in |
//! | [`launch`] | Resolving the program and building the argv |
//! | [`signal`] | Exit codes, signals and job control |
//!
//! # Why this crate can be small
//!
//! Argv is carried as `Vec<OsString>` from `clap`'s `trailing_var_arg` all the
//! way to `Command::args()`, which passes it to `execvp` as a vector. **There
//! is never a command string**, so there is nothing to quote and nothing to
//! escape -- the entire class of shell-quoting bugs is structurally absent
//! rather than defended against. Non-UTF-8 arguments survive byte for byte.
//!
//! # Where the `unsafe` will be
//!
//! In [`signal`] and in the Windows job-object code. Note the honest limit of
//! the verification story: miri covers `prick-core`, and cannot execute a
//! process, so the `unsafe` here -- exactly where miri would be most valuable
//! -- is the part it can never reach. That is a reason for the surface to stay
//! as small as possible, not a reason to claim coverage.

pub mod guard;
pub mod launch;
pub mod signal;

pub use guard::{EnvGuard, GuardError};
