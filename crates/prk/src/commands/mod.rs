//! Command implementations.
//!
//! # House rules
//!
//! - A command never writes to a stream directly. It takes an [`Output`] and
//!   calls into it; the workspace lints make anything else a build failure.
//! - A command returns `Result<(), CliError>`. Rendering the failure is
//!   [`crate::run`]'s job, so the `--json` contract is enforced in one place
//!   instead of being reimplemented per command.
//! - Anything that talks to the server goes through [`Context`], so credential
//!   resolution, transparent token refresh and route construction happen once.

pub mod access;
pub mod auth;
pub mod completions;
pub mod doctor;
pub mod env;
pub mod naming;
pub mod projects;
pub mod run;
pub mod secrets;
pub mod version;

use std::future::Future;
use std::io::Read as _;
use std::path::Path;

use prick_auth::{ServiceToken, StorageBackend, TokenSource, TokenStore};
use secrecy::{ExposeSecret, SecretString};

use crate::cli::{Cli, Command, GlobalArgs};
use crate::error::CliError;
use crate::output::Output;

/// Everything a command needs to reach the server.
///
/// Built once per invocation. It owns the `tokio` runtime rather than creating
/// one per call, so `prk run` can fetch secrets and then replace itself with
/// the child without standing a reactor up and tearing it down in between.
#[derive(Debug)]
pub struct Context {
    api_url: String,
    client: prick_api::Client,
    store: TokenStore,
    runtime: tokio::runtime::Runtime,
    /// Resolved once, at construction, so that `--access-client-secret-file -`
    /// reads stdin exactly one time however many requests follow.
    service_token: Option<ServiceToken>,
}

impl Context {
    /// Builds a context from the global flags.
    ///
    /// # Errors
    ///
    /// [`CliError::Other`] if no server URL was configured or a service-token
    /// secret file could not be read, and [`CliError::Api`] if the HTTP stack
    /// or the platform trust store cannot be set up.
    pub fn new(global: &GlobalArgs) -> Result<Self, CliError> {
        let api_url = resolve_api_url(global)?;
        let service_token = resolve_service_token(global)?;

        let config = prick_api::Config::new(&api_url)
            .with_timeout(std::time::Duration::from_secs(global.timeout));

        let runtime = prick_api::runtime()
            .map_err(|err| CliError::Other(format!("could not start the event loop: {err}")))?;

        // Inside the runtime's context: the connection pool registers with the
        // reactor when it is built, not when it is first used.
        let client = runtime
            .block_on(async { prick_api::Client::new(config, prick_api::Credential::Anonymous) })?;

        Ok(Self {
            api_url,
            client,
            store: TokenStore::new(StorageBackend::File)?,
            runtime,
            service_token,
        })
    }

    /// The resolved server URL.
    pub fn api_url(&self) -> &str {
        &self.api_url
    }

    /// The token store this invocation reads and writes.
    pub fn store(&self) -> &TokenStore {
        &self.store
    }

    /// The client, with whatever credential has been resolved so far.
    pub fn client(&self) -> &prick_api::Client {
        &self.client
    }

    /// Runs a future to completion on this invocation's runtime.
    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    /// Resolves a credential and attaches it to the client.
    ///
    /// Renews the access token first if it is within a minute of expiring, so
    /// a short Access session is invisible. The renewal is written back, so the
    /// next invocation does not repeat it.
    ///
    /// # Errors
    ///
    /// [`CliError::Auth`] when nothing is configured or the session has expired
    /// beyond renewal.
    pub fn authenticate(&mut self, out: Output) -> Result<(), CliError> {
        let resolved = self.runtime.block_on(prick_auth::resolve(
            &self.client,
            &self.store,
            &self.api_url,
            self.service_token.clone(),
        ))?;

        if resolved.refreshed {
            out.debug(1, "renewed the access token before sending the request");
        }
        out.debug(2, &format!("authenticating from the {}", resolved.source.as_str()));

        self.client.set_credential(resolved.credential);
        Ok(())
    }
}

/// Resolves the server URL from the flags, the environment, or a stored login.
///
/// # Errors
///
/// [`CliError::Other`] naming both ways to supply it.
fn resolve_api_url(global: &GlobalArgs) -> Result<String, CliError> {
    if let Some(url) = global.api_url.as_deref().filter(|url| !url.is_empty()) {
        return Ok(url.trim_end_matches('/').to_owned());
    }

    // A previous `prk login` recorded which server it logged in to, so the
    // common case needs neither a flag nor an environment variable.
    if let Ok(store) = TokenStore::new(StorageBackend::File)
        && let Ok(Some(session)) = store.load()
    {
        return Ok(session.api_url);
    }

    Err(CliError::Other(
        "no server URL is configured; pass --api-url <URL>, set PRK_API_URL, or run \
         `prk login <URL>` once"
            .to_owned(),
    ))
}

/// Resolves the service token, if one is configured.
///
/// # Precedence
///
/// `--access-client-secret-file` first, then the flags, then
/// `PRK_ACCESS_CLIENT_ID` / `PRK_ACCESS_CLIENT_SECRET`, then
/// `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. Everything below the file
/// is [`prick_auth::credential::resolve_service_token`]'s decision, not this
/// function's -- including the rule that both halves must come from the same
/// place.
///
/// # The one thing clap cannot tell us
///
/// `--access-client-id` and `--access-client-secret` carry `env` attributes so
/// that `--help` documents the variables, which means clap folds
/// `PRK_ACCESS_CLIENT_*` into the flag values before this function sees them.
/// The credential is identical either way and the precedence is unchanged --
/// clap prefers a command-line value over its `env` -- but a token that came
/// from `PRK_*` is reported by `prk -vv` as having come from the command line,
/// because at this point nothing distinguishes them. The `CF_*` fallback, which
/// is the distinction an operator actually chases, is still reported exactly.
///
/// # Errors
///
/// [`CliError::Other`] if the secret file cannot be read, is empty, or names no
/// client id to go with it.
fn resolve_service_token(global: &GlobalArgs) -> Result<Option<ServiceToken>, CliError> {
    // A file is an explicit act, so it is never quietly overridden by an
    // environment variable and never falls back to the CF_* pair. Silently
    // authenticating as somebody other than the identity whose secret was just
    // read from disk is the failure mode worth designing out.
    if let Some(path) = global.access_client_secret_file.as_deref() {
        let secret = read_secret_file(path)?;
        let Some(id) = global.access_client_id.as_deref().filter(|value| !value.is_empty()) else {
            return Err(CliError::Other(format!(
                "read a service-token secret from {}, but no client id was given; \
                 pass --access-client-id <ID> or set PRK_ACCESS_CLIENT_ID",
                path.display()
            )));
        };
        return Ok(Some(ServiceToken::new(id, secret, TokenSource::Flag)));
    }

    Ok(prick_auth::service_token_from_env(
        global.access_client_id.as_deref(),
        global.access_client_secret.as_ref().map(ExposeSecret::expose_secret),
    ))
}

/// Reads a client secret from a file, or from stdin when the path is `-`.
///
/// One trailing newline is stripped: `echo secret > token` is what people
/// actually run, and a secret with a stray `\n` fails authentication with a
/// message that points nowhere near the cause.
///
/// # Errors
///
/// [`CliError::Other`] naming the path -- never the contents.
fn read_secret_file(path: &Path) -> Result<SecretString, CliError> {
    let raw = if path == Path::new("-") {
        let mut buffer = String::new();
        std::io::stdin().read_to_string(&mut buffer).map_err(|err| {
            CliError::Other(format!("could not read the client secret from stdin: {err}"))
        })?;
        buffer
    } else {
        std::fs::read_to_string(path).map_err(|err| {
            CliError::Other(format!(
                "could not read the client secret from {}: {err}",
                path.display()
            ))
        })?
    };

    let trimmed = raw.strip_suffix('\n').unwrap_or(&raw);
    let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);

    if trimmed.is_empty() {
        let source =
            if path == Path::new("-") { "stdin".to_owned() } else { path.display().to_string() };
        return Err(CliError::Other(format!("{source} contains no client secret")));
    }

    Ok(SecretString::from(trimmed))
}

/// Routes a parsed invocation to its implementation.
///
/// # Errors
///
/// Whatever the command returns.
pub fn dispatch(cli: &Cli, out: Output) -> Result<(), CliError> {
    out.debug(1, &format!("dispatching `prk {}`", cli.command.path()));

    match &cli.command {
        Command::Completions(args) => completions::run(args, out),
        Command::Version => version::run(out),

        Command::Login(args) => auth::login(args, &cli.global, out),
        Command::Logout => auth::logout(&cli.global, out),
        Command::Whoami => auth::whoami(&cli.global, out),
        Command::Doctor => doctor::run(&cli.global, out),

        Command::Run(args) => run::run(args, &cli.global, out),

        Command::Projects(sub) => projects::run(sub, &cli.global, out),
        Command::Env(sub) => env::run(sub, &cli.global, out),
        Command::Secrets(sub) => secrets::run(sub, &cli.global, out),
        Command::Access(sub) => access::run(sub, &cli.global, out),
    }
}

/// The project a command operates in.
///
/// # Errors
///
/// [`CliError::Other`] naming the flag and the environment variable, or the
/// slug grammar when what was supplied is not addressable.
pub fn require_project(global: &GlobalArgs) -> Result<&str, CliError> {
    let project = global.project.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::Other("no project selected; pass --project <SLUG> or set PRK_PROJECT".to_owned())
    })?;
    naming::require_slug("project", project)?;
    Ok(project)
}

/// The project and environment a command operates on.
///
/// Both are **slugs**. An environment is addressed by its slug rather than by
/// its display name, so `eu-west` reaches the environment displayed as
/// "EU West"; the two are separate fields on the server and only one of them
/// is in a URL.
///
/// # Errors
///
/// [`CliError::Other`] naming the flag and the environment variable that supply
/// whichever one is missing, or the slug grammar when one of them cannot be
/// addressed.
pub fn require_scope(global: &GlobalArgs) -> Result<(&str, &str), CliError> {
    let project = require_project(global)?;
    let environment = global.env.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::Other("no environment selected; pass --env <SLUG> or set PRK_ENV".to_owned())
    })?;
    naming::require_slug("environment", environment)?;

    Ok((project, environment))
}

#[cfg(test)]
mod tests {
    use clap::Parser as _;

    use super::*;
    use crate::cli::ColorChoice;

    fn quiet() -> Output {
        Output::new(false, true, 0, ColorChoice::Auto)
    }

    fn global_with(project: Option<&str>, env: Option<&str>) -> GlobalArgs {
        GlobalArgs {
            json: false,
            color: ColorChoice::Auto,
            quiet: true,
            verbose: 0,
            no_input: true,
            yes: false,
            api_url: None,
            access_client_id: None,
            access_client_secret: None,
            access_client_secret_file: None,
            project: project.map(str::to_owned),
            env: env.map(str::to_owned),
            timeout: 30,
        }
    }

    #[test]
    fn the_wired_commands_succeed() {
        for argv in [vec!["prk", "version"], vec!["prk", "completions", "bash"]] {
            let cli = Cli::try_parse_from(&argv).unwrap();
            assert!(dispatch(&cli, quiet()).is_ok(), "{argv:?} failed");
        }
    }

    #[test]
    fn a_command_with_no_server_configured_says_how_to_configure_one() {
        let global = global_with(None, None);
        let err = resolve_api_url(&global).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("--api-url"), "{message}");
        assert!(message.contains("PRK_API_URL"), "{message}");
        assert!(message.contains("prk login"), "{message}");
    }

    #[test]
    fn an_explicit_url_wins_and_is_normalised() {
        let mut global = global_with(None, None);
        global.api_url = Some("https://prick.example.com/".to_owned());
        assert_eq!(resolve_api_url(&global).unwrap(), "https://prick.example.com");
    }

    #[test]
    fn a_scope_is_required_before_a_secret_can_be_addressed() {
        let none = global_with(None, None);
        assert!(require_scope(&none).unwrap_err().to_string().contains("--project"));

        let project_only = global_with(Some("billing"), None);
        assert!(require_scope(&project_only).unwrap_err().to_string().contains("--env"));

        let global = global_with(Some("billing"), Some("eu-west"));
        assert_eq!(require_scope(&global).unwrap(), ("billing", "eu-west"));
    }

    #[test]
    fn a_name_no_route_could_address_is_refused_before_a_request_is_made() {
        // Every path parameter is validated against the slug grammar, so these
        // are 422s. Refusing here names the argument instead of a schema.
        for name in [".", "..", "eu:west", "EU-West", "eu west"] {
            let global = global_with(Some("billing"), Some(name));
            let err = require_scope(&global).unwrap_err();
            assert!(err.to_string().contains(name), "{name} was accepted");
        }
    }

    #[test]
    fn a_mistyped_environment_is_told_what_it_should_have_been() {
        let global = global_with(Some("billing"), Some("EU West"));
        let message = require_scope(&global).unwrap_err().to_string();
        assert!(message.contains("eu-west"), "{message}");
    }

    /// Writes a secret file and returns the directory guarding its lifetime.
    fn secret_file(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("client-secret");
        std::fs::write(&path, contents).expect("write");
        (dir, path)
    }

    #[test]
    fn a_secret_file_loses_exactly_one_trailing_newline() {
        // `echo secret > token` is what people run. A secret carrying a stray
        // "\n" fails authentication with a message that points nowhere useful.
        for (written, expected) in
            [("shh\n", "shh"), ("shh\r\n", "shh"), ("shh", "shh"), ("shh\n\n", "shh\n")]
        {
            let (_dir, path) = secret_file(written);
            assert_eq!(
                read_secret_file(&path).unwrap().expose_secret(),
                expected,
                "{written:?} was mishandled"
            );
        }
    }

    #[test]
    fn an_empty_secret_file_is_an_error_rather_than_an_empty_credential() {
        // The CI failure mode: a secret that did not get injected leaves an
        // empty file, and authenticating as nobody produces a 403 that reads
        // like a permissions problem.
        for written in ["", "\n"] {
            let (_dir, path) = secret_file(written);
            let err = read_secret_file(&path).unwrap_err();
            assert!(err.to_string().contains("no client secret"), "{err}");
        }
    }

    #[test]
    fn a_missing_secret_file_names_the_path_and_nothing_else() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("absent");
        let err = read_secret_file(&path).unwrap_err();
        assert!(err.to_string().contains("absent"), "{err}");
    }

    #[test]
    fn a_secret_file_with_a_client_id_resolves_to_a_service_token() {
        let (_dir, path) = secret_file("shh\n");
        let mut global = global_with(None, None);
        global.access_client_id = Some("abc.access".to_owned());
        global.access_client_secret_file = Some(path);

        let token = resolve_service_token(&global).unwrap().expect("a token resolves");
        assert_eq!(token.client_id(), "abc.access");
        match token.into_api_credential() {
            prick_api::Credential::ServiceToken { client_secret, .. } => {
                assert_eq!(client_secret.expose_secret(), "shh");
            }
            other => panic!("expected a service token, got {other:?}"),
        }
    }

    #[test]
    fn a_secret_file_without_a_client_id_fails_instead_of_falling_back() {
        // Falling through to CF_ACCESS_CLIENT_ID here would authenticate as an
        // identity other than the one whose secret was just read from disk.
        let (_dir, path) = secret_file("shh\n");
        let mut global = global_with(None, None);
        global.access_client_secret_file = Some(path);

        let err = resolve_service_token(&global).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("--access-client-id"), "{message}");
        assert!(message.contains("PRK_ACCESS_CLIENT_ID"), "{message}");
    }

    #[test]
    fn a_secret_file_beats_an_inline_secret() {
        let (_dir, path) = secret_file("from-the-file");
        let mut global = global_with(None, None);
        global.access_client_id = Some("abc.access".to_owned());
        global.access_client_secret = Some(SecretString::from("from-argv"));
        global.access_client_secret_file = Some(path);

        let token = resolve_service_token(&global).unwrap().expect("a token resolves");
        match token.into_api_credential() {
            prick_api::Credential::ServiceToken { client_secret, .. } => {
                assert_eq!(client_secret.expose_secret(), "from-the-file");
            }
            other => panic!("expected a service token, got {other:?}"),
        }
    }
}
