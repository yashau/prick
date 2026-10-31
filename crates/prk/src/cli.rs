//! Argument definitions.
//!
//! This module is the single source of truth for the interface: the binary
//! parses with it, xtask generates shell completions and man pages from it, and
//! the docs are checked against it. There is no second description to drift.

use std::path::PathBuf;

use clap::builder::TypedValueParser as _;
use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};
use secrecy::SecretString;

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

    /// Base URL of the prick server, instead of a saved profile.
    ///
    /// Also read from `PRK_API_URL`. A flag wins over any environment
    /// variable; `--profile` and `--api-url` together are refused, as are
    /// `PRK_PROFILE` and `PRK_API_URL` together. If exactly one profile is
    /// for this URL, its stored session is used.
    #[arg(long, global = true, value_name = "URL")]
    pub api_url: Option<String>,

    /// Saved profile to use. See `prk profile --help`.
    ///
    /// Also read from `PRK_PROFILE`. The order is `--profile` or `--api-url`,
    /// then `PRK_PROFILE` or `PRK_API_URL`, then a project's `.prick.toml`,
    /// then the default profile.
    #[arg(long, global = true, value_name = "NAME")]
    pub profile: Option<String>,

    /// Refuse to run unless the server reports this instance id.
    ///
    /// Also read from `PRK_EXPECT_INSTANCE`. A script that sets it is immune to
    /// profile renames, a changed default, and a name reused for another
    /// deployment: it reaches the one deployment it names or nothing.
    #[arg(long, global = true, value_name = "ID")]
    pub expect_instance: Option<String>,

    /// Whether the command being run changes data on the server.
    ///
    /// Not a flag: set from the parsed command before dispatch, so the
    /// server-selection rules for writes are applied in one place.
    #[arg(skip)]
    pub writes: bool,

    /// Access service-token client id, for machine authentication.
    ///
    /// Not secret: this is the `common_name` the server records as the caller,
    /// so it is safe on a command line and in a log. Its secret half is not.
    ///
    /// When neither this flag nor `PRK_ACCESS_CLIENT_ID` is set,
    /// `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are read instead, so
    /// a pipeline already configured for `cloudflared access` works unchanged.
    #[arg(long, global = true, value_name = "ID", env = "PRK_ACCESS_CLIENT_ID")]
    pub access_client_id: Option<String>,

    /// Access service-token client secret. Visible to other processes.
    ///
    /// A value passed here appears in `ps` output for every user on the machine
    /// and is written to your shell history. That is a property of how
    /// arguments are passed, not of this program, and nothing done here can
    /// remove it.
    ///
    /// Prefer `PRK_ACCESS_CLIENT_SECRET`, or `--access-client-secret-file`, on
    /// any machine you do not exclusively control.
    #[arg(
        long,
        global = true,
        value_name = "SECRET",
        env = "PRK_ACCESS_CLIENT_SECRET",
        // Without this clap prints the variable's VALUE in --help. On a machine
        // where the token is configured, `prk --help` would display it.
        hide_env_values = true,
        // Wrapped the moment clap produces it. `GlobalArgs` derives `Debug` and
        // `-vv` renders diagnostics, so a plain `String` here would be one
        // `{:?}` away from putting a live credential in a log; `SecretString`'s
        // own `Debug` is the redaction, which makes that a non-event rather
        // than a rule somebody has to remember.
        value_parser = clap::builder::StringValueParser::new().map(SecretString::from),
    )]
    pub access_client_secret: Option<SecretString>,

    /// Read the Access service-token client secret from FILE, or from stdin if
    /// FILE is `-`.
    ///
    /// One trailing newline is stripped, so a file written by `echo` works. The
    /// secret never reaches argv this way. Takes precedence over
    /// `--access-client-secret` and `PRK_ACCESS_CLIENT_SECRET`, and requires
    /// `--access-client-id` or `PRK_ACCESS_CLIENT_ID` rather than silently
    /// falling back to the `CF_*` pair.
    #[arg(long, global = true, value_name = "FILE")]
    pub access_client_secret_file: Option<PathBuf>,

    /// Project to operate on, by slug.
    #[arg(short = 'P', long, global = true, value_name = "PROJECT", env = "PRK_PROJECT")]
    pub project: Option<String>,

    /// Environment to operate on, by slug.
    ///
    /// The slug, not the display name: `eu-west` addresses the environment
    /// shown as "EU West". Lowercase letters, digits and single hyphens --
    /// which is also what makes `--scope project:environment` unambiguous,
    /// since a slug cannot contain a colon.
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

    /// Revoke the session and discard stored credentials.
    Logout(commands::auth::LogoutArgs),

    /// Show the identity the server sees.
    Whoami,

    /// Check connectivity, credentials and configuration.
    Doctor,

    /// Manage saved server profiles.
    #[command(subcommand)]
    Profile(commands::profile::ProfileCommand),

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

    /// Inspect the master key ring and advance a rotation.
    #[command(subcommand)]
    Keyring(commands::keyring::KeyringCommand),

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
            Self::Logout(_) => "logout",
            Self::Whoami => "whoami",
            Self::Doctor => "doctor",
            Self::Profile(sub) => sub.path(),
            Self::Projects(sub) => sub.path(),
            Self::Env(sub) => sub.path(),
            Self::Secrets(sub) => sub.path(),
            Self::Run(_) => "run",
            Self::Access(sub) => sub.path(),
            Self::Keyring(sub) => sub.path(),
            Self::Completions(_) => "completions",
            Self::Version => "version",
        }
    }

    /// Whether this command changes data on the server.
    ///
    /// With more than one profile, a write must name its server deliberately
    /// -- a flag, an environment variable or a project file -- rather than
    /// reaching whichever profile was made the default last. This list is what
    /// that rule is only as good as, so it is exhaustive by construction: every
    /// subcommand is matched by name, and a new one does not compile until it
    /// is classified.
    pub fn writes_server(&self) -> bool {
        use commands::access::AccessCommand as A;
        use commands::access_token::TokenCommand as T;
        use commands::env::EnvCommand as E;
        use commands::keyring::KeyringCommand as K;
        use commands::projects::ProjectsCommand as P;
        use commands::secrets::SecretsCommand as S;

        match self {
            Self::Login(_)
            | Self::Logout(_)
            | Self::Whoami
            | Self::Doctor
            | Self::Profile(_)
            | Self::Run(_)
            | Self::Completions(_)
            | Self::Version => false,
            Self::Projects(sub) => match sub {
                P::List | P::Get { .. } => false,
                P::Create { .. } | P::Rename { .. } | P::Remove { .. } => true,
            },
            Self::Env(sub) => match sub {
                E::List => false,
                E::Create { .. } | E::Remove { .. } => true,
            },
            Self::Secrets(sub) => match sub {
                S::List | S::Get { .. } | S::Download(_) | S::History { .. } => false,
                S::Set(_) | S::Remove { .. } | S::Upload(_) | S::Rollback { .. } => true,
            },
            Self::Access(sub) => match sub {
                A::List | A::Identities { .. } | A::Explain { .. } => false,
                A::Grant { .. }
                | A::Revoke { .. }
                | A::Disable { .. }
                | A::Enable { .. }
                | A::Rename { .. } => true,
                A::Token(sub) => match sub {
                    T::List { .. } => false,
                    T::Create { .. }
                    | T::Rotate { .. }
                    | T::Refresh { .. }
                    | T::Revoke { .. }
                    | T::Adopt { .. }
                    | T::Reconcile { .. } => true,
                },
            },
            Self::Keyring(sub) => match sub {
                K::Status => false,
                K::Rekey(_) => true,
            },
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
            "--access-client-id",
            "abc.access",
            "--project",
            "billing",
            "--env",
            "eu-west",
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
        assert_eq!(cli.global.access_client_id.as_deref(), Some("abc.access"));
        assert_eq!(cli.global.project.as_deref(), Some("billing"));
        assert_eq!(cli.global.env.as_deref(), Some("eu-west"));
        assert_eq!(cli.global.timeout, 5);
    }

    #[test]
    fn a_client_secret_never_survives_being_formatted() {
        use secrecy::ExposeSecret;

        let cli =
            Cli::try_parse_from(["prk", "--access-client-secret", "hunter2", "whoami"]).unwrap();

        assert_eq!(
            cli.global.access_client_secret.as_ref().map(ExposeSecret::expose_secret),
            Some("hunter2")
        );

        // `GlobalArgs` is `Debug`, and `-vv` renders diagnostics. This is the
        // property that makes that combination safe.
        let rendered = format!("{:?}", cli.global);
        assert!(!rendered.contains("hunter2"), "a client secret leaked through Debug: {rendered}");
    }

    #[test]
    fn the_client_secret_can_come_from_a_file_or_stdin_instead_of_argv() {
        let from_file =
            Cli::try_parse_from(["prk", "--access-client-secret-file", "/run/token", "whoami"])
                .unwrap();
        assert_eq!(
            from_file.global.access_client_secret_file.as_deref(),
            Some(std::path::Path::new("/run/token"))
        );

        let from_stdin =
            Cli::try_parse_from(["prk", "--access-client-secret-file", "-", "whoami"]).unwrap();
        assert_eq!(
            from_stdin.global.access_client_secret_file.as_deref(),
            Some(std::path::Path::new("-"))
        );
    }

    #[test]
    fn the_client_secrets_help_says_that_an_inline_value_is_visible() {
        // The flag exists because some pipelines have nothing else, but its
        // cost has to be stated where somebody will read it.
        let command = Cli::command();
        let arg = command
            .get_arguments()
            .find(|arg| arg.get_id() == "access_client_secret")
            .expect("--access-client-secret exists");

        let help = arg.get_long_help().map(ToString::to_string).unwrap_or_default();
        assert!(help.contains("ps"), "{help}");
        assert!(help.contains("history"), "{help}");
        assert!(help.contains("--access-client-secret-file"), "{help}");

        // Without this, `prk --help` on a machine where the token is configured
        // prints the token.
        assert!(arg.is_hide_env_values_set(), "--help would display the secret's value");
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
    fn the_parser_does_not_second_guess_a_name_it_cannot_validate() {
        // Whether `eu:west` names anything is a question about the server's
        // slug grammar, and it is answered by `commands::require_slug` with a
        // message that can suggest `eu-west`. A `value_parser` here would answer it
        // with clap's generic "invalid value" and exit 2 -- a usage error for
        // something that is not a usage mistake.
        let cli = Cli::try_parse_from(["prk", "--env", "eu:west:1", "whoami"]).unwrap();
        assert_eq!(cli.global.env.as_deref(), Some("eu:west:1"));
    }

    #[test]
    fn the_environment_flag_says_it_takes_a_slug() {
        let command = Cli::command();
        let arg = command.get_arguments().find(|arg| arg.get_id() == "env").expect("--env exists");

        let help = arg.get_long_help().map(ToString::to_string).unwrap_or_default();
        assert!(help.contains("slug"), "{help}");
        assert!(help.contains("eu-west"), "{help}");
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
            &["prk", "access", "explain", "bob@example.com"],
            &["prk", "keyring", "status"],
            &["prk", "keyring", "rekey", "--until-done"],
            &["prk", "completions", "bash"],
            &["prk", "version"],
            &["prk", "login"],
            &["prk", "login", "--profile", "acme"],
            &["prk", "logout", "--all"],
            &["prk", "profile", "list"],
            &["prk", "profile", "show"],
            &["prk", "profile", "add", "acme", "https://prick.acme.example", "--default"],
            &["prk", "profile", "use", "acme"],
            &["prk", "profile", "rename", "acme", "acme-eu"],
            &["prk", "profile", "forget", "acme"],
            &["prk", "profile", "set", "acme", "--default-project", "api"],
            &["prk", "profile", "rm", "acme", "--yes"],
            &["prk", "profile", "pin", "--local"],
            &["prk", "--profile", "acme", "--expect-instance", "x", "whoami"],
            &["prk", "run", "--allow-prk-vars", "--", "env"],
        ];

        for argv in invocations {
            assert!(Cli::try_parse_from(*argv).is_ok(), "failed to parse {argv:?}");
        }
    }

    /// The invocation `docs/guides/secrets.md` prints, character for
    /// character.
    ///
    /// The documentation promised `--description` for a release in which the
    /// flag did not exist, so the command in the guide was a `clap` error. A
    /// test that constructs `SetArgs` directly would not have caught that; only
    /// parsing the published argv does.
    #[test]
    fn the_documented_set_invocation_parses_with_its_description() {
        let cli = Cli::try_parse_from([
            "prk",
            "secrets",
            "set",
            "STRIPE_SECRET_KEY",
            "--description",
            "Live mode, rotates quarterly",
            "--project",
            "api",
            "--env",
            "production",
        ])
        .expect("the invocation printed in docs/guides/secrets.md must parse");

        let Command::Secrets(commands::secrets::SecretsCommand::Set(args)) = cli.command else {
            panic!("`secrets set` did not parse as itself");
        };

        assert_eq!(args.key, "STRIPE_SECRET_KEY");
        assert_eq!(args.description.as_deref(), Some("Live mode, rotates quarterly"));
        // The value is still not expressible on the command line, and adding a
        // flag beside it must not have changed that.
        assert!(!args.stdin);
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

    /// Command lines printed in `docs/reference/cli/profile.md`,
    /// `sign-in.md`, `run.md` and `docs/guides/multiple-servers.md`, character
    /// for character, so a documented invocation cannot drift into a clap
    /// error.
    #[test]
    fn the_documented_profile_invocations_parse() {
        let invocations: &[&[&str]] = &[
            &["prk", "profile", "list", "--json"],
            &["prk", "--profile", "globex", "profile", "show", "--json"],
            &["prk", "profile", "add", "globex", "https://prick.globex.example"],
            &["prk", "profile", "rename", "prod", "acme"],
            &["prk", "--profile", "prod", "whoami"],
            &["prk", "profile", "forget", "prod"],
            &[
                "prk",
                "profile",
                "set",
                "acme",
                "--default-project",
                "api",
                "--default-env",
                "production",
            ],
            &[
                "prk",
                "profile",
                "set",
                "acme",
                "--service-token-client-id",
                "e367826f93b8d71185e03fe518aff3b4.access",
            ],
            &["prk", "profile", "set", "acme", "--default-env", ""],
            &["prk", "profile", "rm", "globex", "--yes"],
            &["prk", "profile", "remove", "acme"],
            &["prk", "login", "https://prick.acme.example", "--profile", "acme"],
            &["prk", "profile", "pin", "--profile", "acme"],
            &["prk", "login", "https://prick.example.com", "--no-browser"],
            &["prk", "logout", "--profile", "globex"],
            &["prk", "logout", "--all"],
            &[
                "prk",
                "run",
                "--api-url",
                "https://prick.example.com",
                "-P",
                "api",
                "-E",
                "production",
                "--",
                "./deploy.sh",
            ],
            &[
                "prk",
                "run",
                "--expect-instance",
                "3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
                "-P",
                "api",
                "-E",
                "production",
                "--",
                "./deploy.sh",
            ],
            &[
                "prk",
                "run",
                "--allow-prk-vars",
                "-P",
                "api",
                "-E",
                "production",
                "--",
                "./deploy.sh",
            ],
        ];
        for argv in invocations {
            assert!(Cli::try_parse_from(*argv).is_ok(), "failed to parse {argv:?}");
        }
    }

    #[test]
    fn writes_are_classified_and_reads_are_not() {
        for (argv, writes) in [
            (vec!["prk", "secrets", "set", "KEY"], true),
            (vec!["prk", "secrets", "upload", ".env"], true),
            (vec!["prk", "secrets", "rollback", "KEY", "--to", "1"], true),
            (vec!["prk", "projects", "create", "api"], true),
            (vec!["prk", "access", "grant", "ci@example.com", "--role", "writer"], true),
            (vec!["prk", "keyring", "rekey"], true),
            (vec!["prk", "access", "token", "create", "ci"], true),
            (vec!["prk", "access", "token", "rotate", "ci"], true),
            (vec!["prk", "access", "token", "refresh", "ci"], true),
            (vec!["prk", "access", "token", "revoke", "ci"], true),
            (vec!["prk", "access", "token", "adopt", "abc.access"], true),
            (vec!["prk", "access", "token", "reconcile"], true),
            (vec!["prk", "access", "token", "list"], false),
            (vec!["prk", "access", "token", "list", "--all"], false),
            (vec!["prk", "secrets", "list"], false),
            (vec!["prk", "secrets", "download"], false),
            (vec!["prk", "run", "--", "env"], false),
            (vec!["prk", "whoami"], false),
            (vec!["prk", "profile", "list"], false),
        ] {
            let cli = Cli::try_parse_from(&argv).unwrap_or_else(|err| panic!("{argv:?}: {err}"));
            assert_eq!(cli.command.writes_server(), writes, "{argv:?}");
        }
    }

    #[test]
    fn the_server_selection_flags_say_where_else_they_are_read() {
        let command = Cli::command();
        for (id, variable) in [
            ("api_url", "PRK_API_URL"),
            ("profile", "PRK_PROFILE"),
            ("expect_instance", "PRK_EXPECT_INSTANCE"),
        ] {
            let arg = command.get_arguments().find(|arg| arg.get_id() == id).expect(id);
            let help = arg.get_long_help().map(ToString::to_string).unwrap_or_default();
            assert!(help.contains(variable), "--{id} does not mention {variable}: {help}");
        }
    }

    #[test]
    fn bare_invocation_shows_help_rather_than_doing_something() {
        let err = Cli::try_parse_from(["prk"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand);
    }
}
