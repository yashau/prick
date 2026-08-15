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
pub mod projects;
pub mod run;
pub mod secrets;
pub mod version;

use std::future::Future;

use prick_auth::{StorageBackend, TokenStore};

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
}

impl Context {
    /// Builds a context from the global flags.
    ///
    /// # Errors
    ///
    /// [`CliError::Other`] if no server URL was configured, and
    /// [`CliError::Api`] if the HTTP stack or the platform trust store cannot
    /// be set up.
    pub fn new(global: &GlobalArgs) -> Result<Self, CliError> {
        let api_url = resolve_api_url(global)?;

        let config = prick_api::Config::new(&api_url)
            .with_timeout(std::time::Duration::from_secs(global.timeout));

        let runtime = prick_api::runtime()
            .map_err(|err| CliError::Other(format!("could not start the event loop: {err}")))?;

        // Inside the runtime's context: the connection pool registers with the
        // reactor when it is built, not when it is first used.
        let client = runtime
            .block_on(async { prick_api::Client::new(config, prick_api::Credential::Anonymous) })?;

        Ok(Self { api_url, client, store: TokenStore::new(StorageBackend::File)?, runtime })
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
        // Flags for the two halves belong on `GlobalArgs`, which this module
        // does not own; the precedence they slot into is already implemented
        // and tested in `prick_auth::resolve_service_token`. Until they land,
        // CI configures a service token through PRK_* or CF_*, which is what
        // an existing `cloudflared` pipeline already exports.
        let service_token = prick_auth::service_token_from_env(None, None);

        let resolved = self.runtime.block_on(prick_auth::resolve(
            &self.client,
            &self.store,
            &self.api_url,
            service_token,
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

/// The project and environment a command operates on.
///
/// # Errors
///
/// [`CliError::Other`] naming the flag and the environment variable that supply
/// whichever one is missing.
pub fn require_scope(global: &GlobalArgs) -> Result<(&str, &str), CliError> {
    let project = global.project.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::Other("no project selected; pass --project <NAME> or set PRK_PROJECT".to_owned())
    })?;
    let environment = global.env.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::Other("no environment selected; pass --env <NAME> or set PRK_ENV".to_owned())
    })?;

    // `.` and `..` are resolved by the path grammar itself rather than by any
    // character rule, so they are rejected as names rather than encoded.
    for name in [project, environment] {
        if !prick_core::urlpath::is_usable_segment(name) {
            return Err(CliError::Other(format!("`{name}` is not a usable name")));
        }
    }

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

        let global = global_with(Some("billing"), Some("eu:west"));
        assert_eq!(require_scope(&global).unwrap(), ("billing", "eu:west"));
    }

    #[test]
    fn dot_segments_are_refused_as_names() {
        for name in [".", ".."] {
            let global = global_with(Some(name), Some("prod"));
            let err = require_scope(&global).unwrap_err();
            assert!(err.to_string().contains(name), "{name} was accepted");
        }
    }

    #[test]
    fn an_environment_name_may_contain_colons() {
        let global = global_with(Some("billing"), Some("eu:west:1"));
        assert_eq!(require_scope(&global).unwrap().1, "eu:west:1");
    }
}
