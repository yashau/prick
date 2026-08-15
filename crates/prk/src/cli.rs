//! Argument definitions.
//!
//! This module is the single source of truth for the interface: the binary
//! parses with it, xtask generates shell completions and man pages from it, and
//! the docs are checked against it. There is no second description to drift.

use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};

use crate::commands;

/// A self-hosted secrets manager on Cloudflare Workers.
#[derive(Debug, Parser)]
#[command(
    name = "prk",
    version,
    about,
    long_about = None,
    propagate_version = true,
    arg_required_else_help = true
)]
pub struct Cli {
    /// Flags accepted by every subcommand.
    #[command(flatten)]
    pub global: GlobalArgs,

    /// The subcommand to run.
    #[command(subcommand)]
    pub command: Command,
}

/// When to colourise output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, ValueEnum)]
pub enum ColorChoice {
    /// Colourise when stderr is a terminal, and respect `NO_COLOR`.
    #[default]
    Auto,
    /// Always colourise, even when redirected.
    Always,
    /// Never colourise.
    Never,
}

impl ColorChoice {
    /// The lowercase name accepted on the command line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Always => "always",
            Self::Never => "never",
        }
    }
}

impl std::fmt::Display for ColorChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Flags accepted by every subcommand.
///
/// All of these are `global`, so `prk secrets list --json` and
/// `prk --json secrets list` are the same command.
// The bools here are independent switches defined by the command-line
// interface, not a state machine that wants to be an enum. Collapsing them
// would change the interface to fit a lint.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Args)]
pub struct GlobalArgs {
    /// Emit machine-readable JSON.
    ///
    /// On success: one document on stdout, nothing on stderr. On failure: one
    /// error envelope on stderr, nothing on stdout.
    #[arg(long, global = true)]
    pub json: bool,

    /// When to colourise output.
    #[arg(long, global = true, value_name = "WHEN", default_value_t = ColorChoice::Auto)]
    pub color: ColorChoice,

    /// Suppress progress and diagnostics. Does not suppress results.
    #[arg(short, long, global = true, conflicts_with = "verbose")]
    pub quiet: bool,

    /// Increase diagnostic detail. Repeat for more.
    #[arg(short, long, global = true, action = ArgAction::Count)]
    pub verbose: u8,

    /// Never prompt. Fails instead of asking, which is what CI wants.
    #[arg(long, global = true)]
    pub no_input: bool,

    /// Assume yes for confirmation prompts.
    #[arg(short = 'y', long, global = true)]
    pub yes: bool,

    /// Base URL of the prick server.
    #[arg(long, global = true, value_name = "URL", env = "PRK_API_URL")]
    pub api_url: Option<String>,

    /// Project to operate on.
    #[arg(short = 'P', long, global = true, value_name = "PROJECT", env = "PRK_PROJECT")]
    pub project: Option<String>,

    /// Environment to operate on. May contain colons.
    #[arg(short = 'E', long = "env", global = true, value_name = "ENVIRONMENT", env = "PRK_ENV")]
    pub env: Option<String>,

    /// Request deadline in seconds.
    #[arg(long, global = true, value_name = "SECONDS", default_value_t = 30)]
    pub timeout: u64,
}

/// The top-level subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Authenticate against a prick server.
    Login(commands::auth::LoginArgs),

    /// Discard stored credentials.
    Logout,

    /// Show the identity the server sees.
    Whoami,

    /// Check connectivity, credentials and configuration.
    Doctor,

    /// Manage projects.
    #[command(subcommand)]
    Projects(commands::projects::ProjectsCommand),

    /// Manage environments.
    #[command(subcommand, name = "env")]
    Env(commands::env::EnvCommand),

    /// Read and write secrets.
    #[command(subcommand)]
    Secrets(commands::secrets::SecretsCommand),

    /// Run a command with secrets in its environment.
    Run(commands::run::RunArgs),

    /// Manage identities and grants.
    #[command(subcommand)]
    Access(commands::access::AccessCommand),

    /// Generate a shell completion script.
    Completions(commands::completions::CompletionsArgs),

    /// Print the version.
    Version,
}

impl Command {
    /// The command path as a user would type it, for diagnostics.
    pub fn path(&self) -> &'static str {
        match self {
            Self::Login(_) => "login",
            Self::Logout => "logout",
            Self::Whoami => "whoami",
            Self::Doctor => "doctor",
            Self::Projects(sub) => sub.path(),
            Self::Env(sub) => sub.path(),
            Self::Secrets(sub) => sub.path(),
            Self::Run(_) => "run",
            Self::Access(sub) => sub.path(),
            Self::Completions(_) => "completions",
            Self::Version => "version",
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory as _;

    use super::*;

    #[test]
    fn the_interface_is_internally_consistent() {
        // Catches duplicate short flags, conflicting argument ids and every
        // other structural mistake clap can detect.
        Cli::command().debug_assert();
    }

    #[test]
    fn global_flags_are_accepted_before_and_after_the_subcommand() {
        let before = Cli::try_parse_from(["prk", "--json", "whoami"]).unwrap();
        let after = Cli::try_parse_from(["prk", "whoami", "--json"]).unwrap();
        assert!(before.global.json && after.global.json);
    }

    #[test]
    fn every_global_flag_parses() {
        let cli = Cli::try_parse_from([
            "prk",
            "--json",
            "--color",
            "never",
            "-v",
            "-v",
            "--no-input",
            "-y",
            "--api-url",
            "https://prick.example.com",
            "--project",
            "billing",
            "--env",
            "eu:west",
            "--timeout",
            "5",
            "whoami",
        ])
        .unwrap();

        assert!(cli.global.json);
        assert_eq!(cli.global.color, ColorChoice::Never);
        assert_eq!(cli.global.verbose, 2);
        assert!(cli.global.no_input);
        assert!(cli.global.yes);
        assert_eq!(cli.global.api_url.as_deref(), Some("https://prick.example.com"));
        assert_eq!(cli.global.project.as_deref(), Some("billing"));
        assert_eq!(cli.global.env.as_deref(), Some("eu:west"));
        assert_eq!(cli.global.timeout, 5);
    }

    #[test]
    fn quiet_and_verbose_are_mutually_exclusive() {
        assert!(Cli::try_parse_from(["prk", "-q", "-v", "whoami"]).is_err());
    }

    #[test]
    fn the_defaults_are_the_conservative_ones() {
        let cli = Cli::try_parse_from(["prk", "whoami"]).unwrap();
        assert!(!cli.global.json);
        assert_eq!(cli.global.color, ColorChoice::Auto);
        assert!(!cli.global.no_input, "prompting must be the default");
        assert!(!cli.global.yes, "confirmation must be the default");
        assert_eq!(cli.global.timeout, 30);
    }

    #[test]
    fn an_environment_name_may_contain_colons() {
        let cli = Cli::try_parse_from(["prk", "--env", "eu:west:1", "whoami"]).unwrap();
        assert_eq!(cli.global.env.as_deref(), Some("eu:west:1"));
    }

    #[test]
    fn every_top_level_command_parses() {
        let invocations: &[&[&str]] = &[
            &["prk", "login", "https://prick.example.com"],
            &["prk", "logout"],
            &["prk", "whoami"],
            &["prk", "doctor"],
            &["prk", "projects", "list"],
            &["prk", "env", "list"],
            &["prk", "secrets", "list"],
            &["prk", "run", "--", "echo", "hi"],
            &["prk", "access", "list"],
            &["prk", "completions", "bash"],
            &["prk", "version"],
        ];

        for argv in invocations {
            assert!(Cli::try_parse_from(*argv).is_ok(), "failed to parse {argv:?}");
        }
    }

    #[test]
    fn every_command_reports_a_path() {
        for argv in [
            vec!["prk", "logout"],
            vec!["prk", "secrets", "download"],
            vec!["prk", "projects", "list"],
            vec!["prk", "access", "grant", "ci@example.com", "--role", "writer"],
        ] {
            let cli = Cli::try_parse_from(&argv).unwrap();
            assert!(!cli.command.path().is_empty(), "{argv:?} has no path");
        }
    }

    #[test]
    fn bare_invocation_shows_help_rather_than_doing_something() {
        let err = Cli::try_parse_from(["prk"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand);
    }
}
