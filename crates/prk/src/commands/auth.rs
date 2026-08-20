//! `prk login`, `prk logout`, `prk whoami`.

use std::io::IsTerminal as _;

use clap::Args;

use prick_auth::{
    AuthError, Probe, RedirectSource, StorageBackend, StoredSession, TokenStore, discovery,
};

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;

/// Arguments to `prk login`.
#[derive(Debug, Clone, Args)]
pub struct LoginArgs {
    /// Base URL of the prick server.
    #[arg(value_name = "URL")]
    pub url: String,

    /// Where to keep the resulting token.
    ///
    /// The default is a file with owner-only permissions. The OS keyring is
    /// available but breaks over SSH and in CI, where there is no session to
    /// unlock it, and on macOS re-prompts after every update because the
    /// Keychain ACL is bound to the binary's code signature.
    #[arg(long, value_name = "BACKEND", default_value = "file")]
    pub storage: StorageBackendArg,

    /// Print the authorization URL instead of opening a browser.
    ///
    /// For a machine with no display. The login then completes by whichever
    /// route works: the loopback listener, when the port is reachable from the
    /// browser -- an SSH session forwarding it, or WSL sharing loopback with
    /// Windows -- or by pasting the address the browser was redirected to.
    ///
    /// Detected already when there is no display to open a browser on, so this
    /// flag is for the case where there is one and you want the URL anyway.
    #[arg(long)]
    pub no_browser: bool,
}

/// Arguments to `prk logout`.
#[derive(Debug, Clone, Args)]
pub struct LogoutArgs {
    /// Discard the local credential without asking the server to forget it.
    ///
    /// For a machine with no route to the authorization server, where the
    /// request would only stall. The token keeps working until it expires, so
    /// this trades a live credential for not waiting.
    #[arg(long)]
    pub no_revoke: bool,
}

/// Command-line spelling of [`StorageBackend`].
///
/// A separate type so the `clap` derive does not have to reach into
/// `prick-auth`, which would make the library depend on the CLI's argument
/// parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum StorageBackendArg {
    /// A file with owner-only permissions.
    #[default]
    File,
    /// The operating system keyring.
    Keyring,
}

impl From<StorageBackendArg> for StorageBackend {
    fn from(value: StorageBackendArg) -> Self {
        match value {
            StorageBackendArg::File => Self::File,
            StorageBackendArg::Keyring => Self::Keyring,
        }
    }
}

/// What to tell an operator whose browser cannot reach this machine.
///
/// Printed for every interactive login rather than behind a flag, because
/// whether the browser can reach this machine's loopback is not knowable before
/// it tries -- see [`prick_auth::callback::await_redirect`]. Both channels are
/// open, so this is an offer, not an instruction: a login that completes in the
/// browser needs nothing from here.
const PASTE_PROMPT: &str = "If the browser cannot reach this machine, it will fail to load a 127.0.0.1 address.\n\
     That is expected. Paste that whole address here and press Enter:";

/// Runs the interactive login.
///
/// # Errors
///
/// [`CliError::Auth`] for any stage of the handshake. The two an operator acts
/// on are managed OAuth being disabled, which names the dashboard setting, and
/// the browser round trip timing out.
pub fn login(args: &LoginArgs, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut with_url = global.clone();
    with_url.api_url = Some(args.url.clone());
    let context = Context::new(&with_url)?;

    let store = TokenStore::in_dir(context.store().dir(), args.storage.into());

    out.note(&format!("Signing in to {}", context.api_url()));

    let no_browser = args.no_browser || !prick_auth::browser::is_available();

    // Whether there is anyone to paste. `--no-input` is a promise not to ask,
    // and a stdin that is not a terminal is either a pipe carrying something
    // else or a job with no operator -- reading either would consume input that
    // was not an answer.
    let accept_pasted = !global.no_input && std::io::stdin().is_terminal();

    let options = prick_auth::LoginOptions {
        accept_pasted_redirect: accept_pasted,
        ..prick_auth::LoginOptions::default()
    };

    let outcome = context.block_on(prick_auth::login(
        context.client(),
        context.api_url(),
        &options,
        |authorize_url: &str| {
            if no_browser {
                // Not `data`: this is a diagnostic, and stdout belongs to the
                // answer. A login has no answer to print.
                out.note(&format!("Open this URL to continue:\n  {authorize_url}"));
            } else if let Err(err) = prick_auth::browser::open(authorize_url) {
                // Recoverable: the listener is already waiting, so printing the
                // URL is enough to finish the login by hand.
                out.warn(&format!("{err}"));
                out.note(&format!("Open this URL to continue:\n  {authorize_url}"));
            } else {
                out.note("Waiting for the browser to complete the sign-in...");
            }

            if accept_pasted {
                out.note(PASTE_PROMPT);
            }
            Ok(())
        },
    ))?;

    if outcome.probe.is_unprotected() {
        warn_unprotected(out);
    }

    store.save(&outcome.session)?;

    if global.json {
        out.json(&serde_json::json!({
            "api_url": outcome.session.api_url,
            "issuer": outcome.session.issuer,
            "storage": StorageBackend::from(args.storage).as_str(),
            "expires_at": outcome.session.tokens.expires_at,
            "redirect": redirect_label(outcome.redirect_source),
        }));
    } else {
        out.data(&format!("Signed in to {}", outcome.session.api_url));
    }

    Ok(())
}

/// Names the channel a redirect arrived on, for `--json`.
///
/// Reported because it is the one part of a login an operator cannot otherwise
/// see, and it is what tells them whether loopback works from wherever they run
/// this -- which decides whether the next login needs a person at the terminal.
fn redirect_label(source: RedirectSource) -> &'static str {
    match source {
        RedirectSource::Loopback => "loopback",
        RedirectSource::Pasted => "pasted",
    }
}

/// Emits the warning for a server nothing is protecting.
///
/// Through [`Output::warn`], which `--json` does not suppress. Every other
/// diagnostic is silenced under `--json` so a successful run leaves stderr
/// byte-empty; this one is the exception, because an unauthenticated secrets
/// manager is worth breaking that rule for.
fn warn_unprotected(out: Output) {
    out.warn(discovery::UNPROTECTED_WARNING);
    out.warn("Put the application behind Cloudflare Access before storing anything in it.");
}

/// Discards stored credentials, and asks the server to forget them.
///
/// # Deleting the file is not signing out
///
/// A refresh token stays valid at the authorization server until it expires on
/// its own or someone revokes it. Removing the local copy makes it unreachable
/// from this machine and does nothing about the copy the server will still
/// honour, so a logout that only deleted the file would leave a live credential
/// behind while reporting success.
///
/// So the token is handed back first, then the file goes.
///
/// # Revocation is advisory, deletion is not
///
/// Revocation needs the network; deletion does not. If asking the server were
/// allowed to fail the command, a laptop with no connectivity could not be
/// signed out at all -- and "could not sign out" is a worse outcome than "signed
/// out here, tell the server later", because the operator wanted the local
/// credential gone and it is the one thing this machine controls.
///
/// So the credential is discarded whatever the server said, and a revocation
/// that did not happen is a warning naming what is still live rather than a
/// silent omission.
///
/// Idempotent: the state it establishes is "no credentials", and running it
/// twice does not make that less true.
///
/// # Errors
///
/// [`CliError::Auth`] if the token file exists and cannot be removed. A failed
/// revocation is reported, not returned.
pub fn logout(args: &LogoutArgs, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let store = TokenStore::new(StorageBackend::File)?;
    let session = store.load().unwrap_or(None);

    let revocation = match &session {
        Some(session) if !args.no_revoke => Some(revoke_session(session, global, out)),
        // Nothing to revoke, or the operator asked for the local half only.
        _ => None,
    };

    // Unconditional, and after the attempt: the token is needed to revoke it,
    // and the file must go even when the attempt failed.
    store.clear()?;

    report_logout(session.is_some(), revocation, global, out);
    Ok(())
}

/// What became of the attempt to have the server forget the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Revocation {
    /// The server accepted it.
    Revoked,
    /// The server advertises no revocation endpoint, so there is nothing to ask.
    Unsupported,
    /// The attempt failed. The token is still live until it expires.
    Failed,
}

/// Hands the session's token back to the authorization server.
///
/// The refresh token when there is one, because revoking it is what ends the
/// session; otherwise the access token, which is all there is to give back.
fn revoke_session(session: &StoredSession, global: &GlobalArgs, out: Output) -> Revocation {
    let (token, hint) = match session.tokens.refresh_token.clone() {
        Some(refresh) => (refresh, prick_auth::oauth::HINT_REFRESH_TOKEN),
        None => (session.tokens.access_token.clone(), prick_auth::oauth::HINT_ACCESS_TOKEN),
    };

    let mut with_url = global.clone();
    with_url.api_url = Some(session.api_url.clone());
    let context = match Context::new(&with_url) {
        Ok(context) => context,
        Err(err) => {
            out.warn(&format!("could not prepare the revocation request: {err}"));
            return Revocation::Failed;
        }
    };

    context.block_on(async {
        let endpoint = match session.revocation_endpoint.clone() {
            Some(endpoint) => endpoint,
            // A credential stored before the endpoint was recorded -- which is
            // every credential that exists at the moment this ships. The issuer
            // is in the file, so ask it once rather than declining to revoke the
            // very sessions most likely to be signed out first.
            None => {
                match discovery::fetch_authorization_server(context.client(), &session.issuer).await
                {
                    Ok(server) => match server.revocation_endpoint {
                        Some(endpoint) => endpoint,
                        None => return Revocation::Unsupported,
                    },
                    Err(err) => {
                        out.warn(&format!("could not find where to revoke the token: {err}"));
                        return Revocation::Failed;
                    }
                }
            }
        };

        match prick_auth::oauth::revoke(
            context.client(),
            &endpoint,
            &session.client_id,
            &token,
            hint,
        )
        .await
        {
            Ok(()) => Revocation::Revoked,
            Err(err) => {
                out.warn(&format!("the token could not be revoked: {err}"));
                Revocation::Failed
            }
        }
    })
}

/// Reports what happened, and what is still live if anything.
///
/// The warning for a token left behind goes through [`Output::warn`], which
/// `--json` does not suppress, for the same reason the unprotected-server
/// warning does: a credential that still works somewhere is worth breaking the
/// byte-empty-stderr rule for.
fn report_logout(
    had_session: bool,
    revocation: Option<Revocation>,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        out.json(&serde_json::json!({
            "logged_out": had_session,
            "revoked": match revocation {
                Some(Revocation::Revoked) => Some(true),
                Some(Revocation::Unsupported | Revocation::Failed) => Some(false),
                None => None,
            },
        }));
    } else if had_session {
        out.data("Signed out.");
    } else {
        out.data("No stored credentials.");
    }

    match revocation {
        Some(Revocation::Failed) => out.warn(
            "The credential is gone from this machine, but the server was not told. It keeps \
             working until it expires -- revoke the session in Zero Trust > Access if that matters.",
        ),
        Some(Revocation::Unsupported) => out.warn(
            "This authorization server advertises no revocation endpoint, so the token could only \
             be discarded locally. It keeps working until it expires.",
        ),
        Some(Revocation::Revoked) | None => (),
    }
}

/// Shows the identity the server resolved for this caller.
///
/// # Errors
///
/// [`CliError::Auth`] if no credential is available, and [`CliError::Api`] for
/// anything the server reported.
pub fn whoami(global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let mut context = Context::new(global)?;
    context.authenticate(out)?;

    let identity = context.block_on(prick_api::ops::whoami(context.client()))?;

    if global.json {
        out.json(&serde_json::json!({
            "kind": identity.kind,
            "subject": identity.subject,
            "identity_id": identity.identity_id,
            "role": identity.role,
            "bootstrap": identity.bootstrap,
        }));
    } else {
        // A service token's subject is a `common_name` like
        // `e367826f93b8d71185e03fe518aff3b4.access`, which is exactly the
        // string an administrator needs in order to grant it something.
        out.data(&format!("{} ({})", identity.subject, identity.kind));
        // The GLOBAL role, and only that. A project-scoped admin reports none
        // here and is still an administrator of that project.
        if let Some(role) = identity.role.as_deref() {
            out.data(&format!("role: {role} (global)"));
        }
        if identity.bootstrap {
            out.warn(
                "you are an administrator by BOOTSTRAP_ADMINS alone; the self-heal turns that \
                 into a real, revocable grant on the next authenticated request",
            );
        }
    }

    Ok(())
}

/// Whether a probe outcome should stop a login before the browser opens.
///
/// Split out so the mapping is testable without a server.
pub fn probe_blocks_login(probe: &Probe) -> Option<AuthError> {
    match probe {
        Probe::ManagedOAuthDisabled => Some(AuthError::ManagedOAuthDisabled),
        Probe::ManagedOAuth { .. } | Probe::Unprotected => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_storage_is_the_headless_safe_one() {
        assert_eq!(StorageBackend::from(StorageBackendArg::default()), StorageBackend::File);
        assert!(StorageBackend::from(StorageBackendArg::default()).works_headless());
    }

    #[test]
    fn the_argument_spelling_maps_onto_the_library_type() {
        assert_eq!(StorageBackend::from(StorageBackendArg::Keyring), StorageBackend::Keyring);
    }

    #[test]
    fn managed_oauth_being_off_stops_the_login_before_a_browser_opens() {
        let blocked = probe_blocks_login(&Probe::ManagedOAuthDisabled)
            .expect("there is no authorization server to use");
        assert!(matches!(blocked, AuthError::ManagedOAuthDisabled));
        assert!(blocked.hint().is_some_and(|hint| hint.contains("Zero Trust")));
    }

    #[test]
    fn an_unprotected_server_does_not_stop_the_login_but_is_still_reported() {
        // The secrets are reachable either way, so refusing to log in would
        // help nobody. The warning is what matters.
        assert!(probe_blocks_login(&Probe::Unprotected).is_none());
        assert!(Probe::Unprotected.is_unprotected());
    }

    #[test]
    fn a_normal_probe_does_not_stop_the_login() {
        assert!(probe_blocks_login(&Probe::ManagedOAuth { metadata_url: None }).is_none());
    }
}
