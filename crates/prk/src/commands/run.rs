//! `prk run`.
//!
//! Fetch the environment's secrets, run every name past the guard, then hand
//! the captured argv to `prick-exec` and stop being `prk`.
//!
//! # Nothing is written to disk
//!
//! Secrets reach the child through its environment block and nowhere else.
//! There is no temporary `.env`, no fifo and no file descriptor passed by path,
//! so there is no window in which a secret exists somewhere another process
//! could read it.
//!
//! # This function does not return
//!
//! [`prick_exec::run`] never returns on success: on Unix it becomes the child
//! through `execvp`, and on Windows it waits and then exits with the child's
//! status. Either way the exit code and the signal disposition are the
//! command's own, so a script cannot tell whether it ran under `prk run`.

use std::ffi::OsString;

use clap::Args;

use prick_api::ops;
use prick_exec::{EnvGuard, LaunchSpec};

use crate::cli::GlobalArgs;
use crate::commands::{Context, require_scope};
use crate::error::CliError;
use crate::output::Output;

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

/// Runs a command with the environment's secrets in its environment.
///
/// # Errors
///
/// [`CliError::Auth`] or [`CliError::Api`] while fetching the secrets, and
/// [`CliError::Launch`] if the command cannot be started -- 127 when it is not
/// found, 126 when it is found but cannot be executed.
pub fn run(args: &RunArgs, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let (project, environment) = require_scope(global)?;

    let mut context = Context::new(global)?;
    context.authenticate(out)?;

    // One request for the whole environment, and one audit row for it: an
    // export is a single decision at a single instant, and a row per secret
    // would make the log worse rather than more complete.
    let export = context.block_on(ops::export_secrets(context.client(), project, environment))?;
    let secrets = export.into_pairs();

    out.debug(1, &format!("injecting {} secrets into the child environment", secrets.len()));

    let guard = if args.allow_unsafe_env { EnvGuard::permissive() } else { EnvGuard::strict() };

    let spec = LaunchSpec::new(args.argv.clone())?.with_secrets(guard, secrets)?;
    out.debug(2, &format!("variables: {}", spec.env_names().collect::<Vec<_>>().join(", ")));

    // Never returns on success. The `Ok` type is uninhabited, so there is no
    // arm to write for it and no way to accidentally fall through and report
    // success for a command that has not run.
    match prick_exec::run(&spec) {
        Err(err) => Err(CliError::Launch(err)),
    }
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

    #[test]
    fn a_launch_failure_keeps_the_shells_own_exit_codes() {
        use crate::error::CliError;

        let not_found =
            CliError::Launch(prick_exec::LaunchError::NotFound { program: "npm".to_owned() });
        assert_eq!(not_found.exit_code(), 127);
        assert_eq!(not_found.code(), "LAUNCH_FAILED");
        assert!(not_found.hint().is_some_and(|hint| hint.contains("PATH")));

        let not_executable = CliError::Launch(prick_exec::LaunchError::PermissionDenied {
            program: "/etc/hosts".to_owned(),
        });
        assert_eq!(not_executable.exit_code(), 126);
    }
}
