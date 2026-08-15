//! `prk run`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! TODO: fetch the environment's secrets, run them past
//! [`prick_exec::EnvGuard`], then hand the captured argv to `prick-exec`. See
//! that crate for the `SIGPIPE` reset, the Windows batch-shim resolution and
//! the job object.

use std::ffi::OsString;

use clap::Args;

/// Arguments to `prk run`.
#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    /// Permit secrets whose names the dynamic loader or a language runtime
    /// interprets before the program starts.
    ///
    /// Without this, names like `LD_PRELOAD`, `DYLD_*`, `PATH`, `NODE_OPTIONS`
    /// and `BASH_ENV` are refused, because a server that can set them can run
    /// arbitrary code in the child.
    #[arg(long)]
    pub allow_unsafe_env: bool,

    /// The command to run, followed by its arguments.
    ///
    /// Captured as raw OS strings and passed straight to the process API, so
    /// quoting, backslashes and non-UTF-8 bytes survive exactly. Nothing is
    /// ever joined into a command line, so there is no quoting to get wrong.
    #[arg(
        trailing_var_arg = true,
        allow_hyphen_values = true,
        required = true,
        value_name = "COMMAND"
    )]
    pub argv: Vec<OsString>,
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use crate::cli::Cli;

    fn argv_of(args: &[&str]) -> Vec<String> {
        let cli = Cli::try_parse_from(args).unwrap();
        match cli.command {
            crate::cli::Command::Run(run) => {
                run.argv.iter().map(|a| a.to_string_lossy().into_owned()).collect()
            }
            other => panic!("expected run, got {other:?}"),
        }
    }

    #[test]
    fn argv_is_captured_verbatim() {
        assert_eq!(argv_of(&["prk", "run", "--", "echo", "hello world"]), ["echo", "hello world"]);
    }

    #[test]
    fn the_childs_own_flags_are_not_interpreted_as_ours() {
        // Without trailing_var_arg + allow_hyphen_values, `--json` here would
        // be swallowed by the global flag of the same name.
        assert_eq!(
            argv_of(&["prk", "run", "--", "npm", "test", "--json", "-q"]),
            ["npm", "test", "--json", "-q"]
        );
    }

    #[test]
    fn shell_metacharacters_survive_as_single_arguments() {
        // Nothing is ever joined into a command line, so there is no quoting to
        // get wrong.
        assert_eq!(
            argv_of(&["prk", "run", "--", "sh", "-c", "echo $(id) `id`"]),
            ["sh", "-c", "echo $(id) `id`"]
        );
    }

    #[test]
    fn our_flags_still_work_before_the_separator() {
        let cli = Cli::try_parse_from(["prk", "run", "--allow-unsafe-env", "--", "true"]).unwrap();
        match cli.command {
            crate::cli::Command::Run(run) => {
                assert!(run.allow_unsafe_env);
                assert_eq!(run.argv.len(), 1);
            }
            other => panic!("expected run, got {other:?}"),
        }
    }

    #[test]
    fn a_command_is_required() {
        assert!(Cli::try_parse_from(["prk", "run"]).is_err());
    }
}
