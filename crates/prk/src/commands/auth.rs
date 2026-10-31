//! `prk login`, `prk logout`, `prk whoami`.

use std::io::IsTerminal as _;

use clap::Args;

use prick_auth::profiles::{ProfileStore, new_credential_id};
use prick_auth::{
    AuthError, Probe, RedirectSource, StorageBackend, StoredSession, TokenStore, discovery,
};
use prick_core::profile::{
    Config, EditError, LEGACY_CREDENTIAL, Profile, SelectError, Selection, Source, edit,
    validate_url,
};

use crate::cli::GlobalArgs;
use crate::commands::Context;
use crate::error::CliError;
use crate::output::Output;
use crate::target::{EnvVars, Target, TargetError};

/// Arguments to `prk login`.
#[derive(Debug, Clone, Args)]
pub struct LoginArgs {
    /// Base URL of the prick server.
    ///
    /// Optional when `--profile` (or `PRK_PROFILE`) names an existing profile,
    /// or a default profile exists: the sign-in then renews that profile.
    /// Signing in to a URL no profile is for creates one, named `default` if
    /// it is the first and after the host otherwise, unless `--profile` names
    /// it.
    #[arg(value_name = "URL")]
    pub url: Option<String>,

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
    /// Sign out of every profile, not only the selected one.
    #[arg(long)]
    pub all: bool,

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
    let profiles = ProfileStore::new()?;
    let config = profiles.load().map_err(TargetError::from)?.config;
    let plan = plan_login(&config, args.url.as_deref(), global, &EnvVars::from_process())?;

    let context = Context::with_target(global, Target::bare(&plan.url, profiles.clone()))?;

    let credential = match &plan.existing {
        Some(existing) => existing.credential.clone(),
        None => fresh_credential(&config, &profiles)?,
    };
    let store =
        profiles.tokens(&Profile::new(&plan.url, &credential)).with_backend(args.storage.into());

    // Before anything else: a backend that cannot hold the session must refuse
    // now, not after the operator has finished a browser sign-in for nothing.
    store.check_available()?;

    out.note(&format!("Signing in to {} as profile `{}`", context.api_url(), plan.name));

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

    // The new session is checked against everything the profile has pinned
    // before it is saved. A refusal hands the fresh token back, so a sign-in
    // that reached the wrong deployment leaves nothing live behind.
    let instance = match check_new_session(&context, &plan, &outcome.session, global) {
        Ok(instance) => instance,
        Err(err) => {
            let _ = revoke_session(&outcome.session, global, out);
            return Err(err);
        }
    };

    store.save(&outcome.session)?;
    record_profile(&profiles, &plan, &credential, &outcome.session, instance.as_deref())?;

    if global.json {
        out.json(&serde_json::json!({
            "api_url": outcome.session.api_url,
            "profile": plan.name,
            "instance": instance,
            "issuer": outcome.session.issuer,
            "storage": StorageBackend::from(args.storage).as_str(),
            "expires_at": outcome.session.tokens.expires_at,
            "redirect": redirect_label(outcome.redirect_source),
        }));
    } else {
        out.data(&format!("Signed in to {} (profile {})", outcome.session.api_url, plan.name));
        if instance.is_none() {
            out.warn("this server reports no instance id, so the profile is not pinned to it");
        }
    }

    Ok(())
}

/// Which profile a sign-in is for, and which server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginPlan {
    /// The profile's name.
    pub name: String,
    /// The server.
    pub url: String,
    /// The profile as it is now, if it exists.
    pub existing: Option<Profile>,
}

/// Decides which profile a sign-in renews or creates.
///
/// # Errors
///
/// [`TargetError`] when the request names nothing to sign in to, names an
/// existing profile with a different server (a profile's server never
/// changes), or names a URL several profiles share.
pub fn plan_login(
    config: &Config,
    url: Option<&str>,
    global: &GlobalArgs,
    env: &EnvVars,
) -> Result<LoginPlan, CliError> {
    let set = |value: Option<&str>| {
        value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
    };
    let named = set(global.profile.as_deref()).or_else(|| set(env.profile.as_deref()));
    let url =
        set(url).or_else(|| set(global.api_url.as_deref())).or_else(|| set(env.api_url.as_deref()));
    let url = match url {
        Some(url) => Some(validate_url(&url).map_err(TargetError::from)?),
        None => None,
    };
    let unknown = |name: &str| {
        TargetError::Select(SelectError::Unknown {
            name: name.to_owned(),
            known: config.profiles.keys().cloned().collect(),
        })
    };

    match (named, url) {
        (Some(name), Some(url)) => match config.profiles.get(&name) {
            Some(existing) if !prick_core::profile::same_server(&existing.api_url, &url) => {
                Err(TargetError::Edit(EditError::UrlMismatch {
                    name,
                    existing: existing.api_url.clone(),
                    requested: url,
                })
                .into())
            }
            Some(existing) => Ok(LoginPlan { name, url, existing: Some(existing.clone()) }),
            None => {
                // Refused here, before the browser, rather than at save time.
                edit::add(config, &name, Profile::new(&url, "0000000000000000"), false, false)
                    .map_err(TargetError::from)?;
                Ok(LoginPlan { name, url, existing: None })
            }
        },
        (Some(name), None) => {
            let existing = config.profiles.get(&name).cloned().ok_or_else(|| unknown(&name))?;
            Ok(LoginPlan { name, url: existing.api_url.clone(), existing: Some(existing) })
        }
        (None, Some(url)) => match config.profiles_for_url(&url).as_slice() {
            [] => Ok(LoginPlan { name: config.auto_name(&url), url, existing: None }),
            [one] => Ok(LoginPlan {
                name: (*one).to_owned(),
                existing: config.profiles.get(*one).cloned(),
                url,
            }),
            many => Err(TargetError::Select(SelectError::AmbiguousUrl {
                url,
                profiles: many.iter().map(|name| (*name).to_owned()).collect(),
            })
            .into()),
        },
        (None, None) => {
            let name = config.default_profile.clone().ok_or(TargetError::Select(
                SelectError::Nothing { has_profiles: !config.profiles.is_empty() },
            ))?;
            let existing = config.profiles.get(&name).cloned().ok_or_else(|| unknown(&name))?;
            Ok(LoginPlan { url: existing.api_url.clone(), name, existing: Some(existing) })
        }
    }
}

/// The credential file a new profile gets.
///
/// The legacy file when no profile uses it and it does not exist, so the
/// first profile on a machine is readable by an older build too; a fresh id
/// otherwise.
pub(crate) fn fresh_credential(
    config: &Config,
    profiles: &ProfileStore,
) -> Result<String, CliError> {
    let legacy_in_use =
        config.profiles.values().any(|profile| profile.credential == LEGACY_CREDENTIAL);
    if !legacy_in_use && !profiles.legacy_tokens().path().exists() {
        return Ok(LEGACY_CREDENTIAL.to_owned());
    }
    Ok(new_credential_id()?)
}

/// Checks a fresh session against the profile's pins and `--expect-instance`,
/// and returns the instance the server reports.
fn check_new_session(
    context: &Context,
    plan: &LoginPlan,
    session: &StoredSession,
    global: &GlobalArgs,
) -> Result<Option<String>, CliError> {
    if let Some(pinned) = plan.existing.as_ref().and_then(|profile| profile.issuer.as_deref())
        && pinned != session.issuer
    {
        return Err(TargetError::IssuerMismatch {
            profile: plan.name.clone(),
            host: prick_core::profile::host_of(&plan.url),
            pinned: pinned.to_owned(),
            found: session.issuer.clone(),
        }
        .into());
    }

    let expected = global
        .expect_instance
        .clone()
        .or_else(|| EnvVars::from_process().expect_instance)
        .filter(|value| !value.trim().is_empty());
    let pinned = plan.existing.as_ref().and_then(|profile| profile.instance.clone());

    let mut client = context.client().clone();
    client.set_credential(prick_api::Credential::Bearer(session.tokens.access_token.clone()));
    let reported = match context.block_on(prick_api::ops::whoami(&client)) {
        Ok(identity) => identity.instance.filter(|id| prick_core::profile::is_instance_id(id)),
        // Nothing pinned and nothing expected: the sign-in stands, unpinned,
        // and the first command against this profile pins it.
        Err(_) if pinned.is_none() && expected.is_none() => return Ok(None),
        Err(err) => return Err(err.into()),
    };

    // Verified against a throwaway target carrying the same pins. Recording
    // the pin is `record_profile`'s job, under the lock, with everything else.
    let mut target = Target::bare(&plan.url, ProfileStore::in_dir(context.store().dir()));
    target.expect_instance = expected;
    if let Some(existing) = &plan.existing {
        let instance = pinned.or_else(|| reported.clone());
        target.profile = Some((plan.name.clone(), Profile { instance, ..existing.clone() }));
        target.selection = Selection::Profile { name: plan.name.clone(), source: Source::Flag };
    }
    target.verify(reported.as_deref())?;
    Ok(reported)
}

/// Records the profile: created if new, pinned where it was not.
fn record_profile(
    profiles: &ProfileStore,
    plan: &LoginPlan,
    credential: &str,
    session: &StoredSession,
    instance: Option<&str>,
) -> Result<(), CliError> {
    profiles.update(|config| -> Result<(), CliError> {
        if let Some(profile) = config.profiles.get_mut(&plan.name) {
            if !prick_core::profile::same_server(&profile.api_url, &plan.url) {
                return Err(TargetError::Edit(EditError::UrlMismatch {
                    name: plan.name.clone(),
                    existing: profile.api_url.clone(),
                    requested: plan.url.clone(),
                })
                .into());
            }
            if profile.issuer.is_none() {
                profile.issuer = Some(session.issuer.clone());
            }
            if profile.instance.is_none() {
                profile.instance = instance.map(str::to_owned);
            }
            return Ok(());
        }
        let mut profile = Profile::new(&plan.url, credential);
        profile.issuer = Some(session.issuer.clone());
        profile.instance = instance.map(str::to_owned);
        *config =
            edit::add(config, &plan.name, profile, false, false).map_err(TargetError::from)?;
        Ok(())
    })
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
    let profiles = ProfileStore::new()?;

    let mut signed_out = Vec::new();
    let mut had_session = false;
    let mut worst: Option<Revocation> = None;

    for (name, store) in logout_stores(args, global, &profiles)? {
        let session = store.load().unwrap_or(None);

        let revocation = match &session {
            Some(session) if !args.no_revoke => Some(revoke_session(session, global, out)),
            // Nothing to revoke, or the operator asked for the local half only.
            _ => None,
        };

        // Unconditional, and after the attempt: the token is needed to revoke
        // it, and the file must go even when the attempt failed.
        store.clear()?;

        if session.is_some() {
            had_session = true;
            signed_out.extend(name);
        }
        worst = match (worst, revocation) {
            (Some(Revocation::Failed), _) | (_, Some(Revocation::Failed)) => {
                Some(Revocation::Failed)
            }
            (Some(Revocation::Unsupported), _) | (_, Some(Revocation::Unsupported)) => {
                Some(Revocation::Unsupported)
            }
            (Some(Revocation::Revoked), _) | (_, Some(Revocation::Revoked)) => {
                Some(Revocation::Revoked)
            }
            (None, None) => None,
        };
    }

    report_logout(had_session, &signed_out, worst, global, out);
    Ok(())
}

/// The token stores a logout clears, with the profile each belongs to.
///
/// The selected profile's, or every profile's with `--all`. A server addressed
/// by URL with no profile for it reaches the legacy file only if that file's
/// session is for that server: signing out of one server never discards the
/// session of another.
fn logout_stores(
    args: &LogoutArgs,
    global: &GlobalArgs,
    profiles: &ProfileStore,
) -> Result<Vec<(Option<String>, TokenStore)>, CliError> {
    let legacy = profiles.legacy_tokens().clone();

    if args.all {
        let config = profiles.load().map_err(TargetError::from)?.config;
        let mut stores: Vec<_> = config
            .profiles
            .iter()
            .map(|(name, profile)| (Some(name.clone()), profiles.tokens(profile)))
            .collect();
        if !stores.iter().any(|(_, store)| store.path() == legacy.path()) {
            stores.push((None, legacy));
        }
        return Ok(stores);
    }

    match crate::target::resolve(global) {
        Ok(target) => {
            if let Some(name) = target.selection.profile() {
                return Ok(vec![(Some(name.to_owned()), target.tokens())]);
            }
            let ours = legacy.load().ok().flatten().is_some_and(|session| {
                prick_core::profile::same_server(&session.api_url, &target.api_url)
            });
            Ok(if ours { vec![(None, legacy)] } else { Vec::new() })
        }
        // Nothing selects a server and no profile exists: there is at most the
        // legacy file to clear, which is what signing out has always meant on
        // such a machine. With profiles but no default, the operator has to
        // say which one, because the legacy file may be any profile's.
        Err(CliError::Target(TargetError::Select(SelectError::Nothing {
            has_profiles: false,
        }))) => Ok(vec![(None, legacy)]),
        Err(err) => Err(err),
    }
}

/// Hands a session back to the server that issued it, reporting a failure as
/// a warning. For `prk profile remove`, which discards the session either way.
pub(crate) fn revoke_quietly(session: &StoredSession, global: &GlobalArgs, out: Output) {
    if revoke_session(session, global, out) == Revocation::Failed {
        out.warn("the session could not be revoked; it keeps working until it expires");
    }
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

    // A bare target for the session's own server: revocation goes to the
    // authorization server that issued the token, whatever is selected.
    let context = match ProfileStore::new()
        .map_err(CliError::from)
        .and_then(|store| Context::with_target(global, Target::bare(&session.api_url, store)))
    {
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
    profiles: &[String],
    revocation: Option<Revocation>,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        out.json(&serde_json::json!({
            "logged_out": had_session,
            "profiles": profiles,
            "revoked": match revocation {
                Some(Revocation::Revoked) => Some(true),
                Some(Revocation::Unsupported | Revocation::Failed) => Some(false),
                None => None,
            },
        }));
    } else if had_session && profiles.is_empty() {
        out.data("Signed out.");
    } else if had_session {
        out.data(&format!("Signed out of {}.", profiles.join(", ")));
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

    let identity = context.identity()?;
    let target = context.target();
    let instance = identity.instance.clone();

    if global.json {
        out.json(&serde_json::json!({
            "kind": identity.kind,
            "subject": identity.subject,
            "identity_id": identity.identity_id,
            "role": identity.role,
            "bootstrap": identity.bootstrap,
            "server": target.host(),
            "profile": target.selection.profile(),
            "instance": instance,
        }));
    } else {
        // A service token's subject is a `common_name` like
        // `e367826f93b8d71185e03fe518aff3b4.access`, which is exactly the
        // string an administrator needs in order to grant it something.
        out.data(&format!("{} ({})", identity.subject, identity.kind));
        // The profile name is a local label; the host and the instance are
        // what identify the deployment on every machine.
        let profile = target
            .selection
            .profile()
            .map_or_else(|| "no profile".to_owned(), |name| format!("profile {name}"));
        out.data(&format!("server: {} ({profile})", target.host()));
        out.data(&format!("instance: {}", instance.as_deref().unwrap_or("not reported")));
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

    fn global(flags: &[&str]) -> GlobalArgs {
        use clap::Parser as _;
        let mut argv = vec!["prk"];
        argv.extend_from_slice(flags);
        argv.push("whoami");
        crate::cli::Cli::try_parse_from(argv).unwrap().global
    }

    fn one_profile() -> Config {
        edit::add(
            &Config::default(),
            "acme",
            Profile::new("https://prick.acme.example", LEGACY_CREDENTIAL),
            true,
            false,
        )
        .unwrap()
    }

    #[test]
    fn the_first_sign_in_creates_the_default_profile() {
        let plan = plan_login(
            &Config::default(),
            Some("https://prick.example.com/"),
            &global(&[]),
            &EnvVars::default(),
        )
        .unwrap();
        assert_eq!(plan.name, "default");
        assert_eq!(plan.url, "https://prick.example.com");
        assert!(plan.existing.is_none());
    }

    #[test]
    fn signing_in_to_a_second_server_creates_a_second_profile_instead_of_replacing_the_first() {
        let plan = plan_login(
            &one_profile(),
            Some("https://prick.globex.example"),
            &global(&[]),
            &EnvVars::default(),
        )
        .unwrap();
        assert_eq!(plan.name, "prick-globex-example");
        assert!(plan.existing.is_none());
    }

    #[test]
    fn signing_in_again_renews_the_profile_for_that_url_or_the_default() {
        let config = one_profile();
        let by_url = plan_login(
            &config,
            Some("https://prick.acme.example"),
            &global(&[]),
            &EnvVars::default(),
        )
        .unwrap();
        assert_eq!(by_url.name, "acme");
        assert!(by_url.existing.is_some());

        let bare = plan_login(&config, None, &global(&[]), &EnvVars::default()).unwrap();
        assert_eq!(bare.name, "acme");
        assert_eq!(bare.url, "https://prick.acme.example");
    }

    #[test]
    fn a_profile_never_changes_server() {
        let err = plan_login(
            &one_profile(),
            Some("https://prick.globex.example"),
            &global(&["--profile", "acme"]),
            &EnvVars::default(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "PROFILE_EDIT_REFUSED");
    }

    #[test]
    fn a_tombstoned_name_is_refused_before_the_browser_opens() {
        let config = edit::rename(&one_profile(), "acme", "acme-eu").unwrap();
        let err = plan_login(
            &config,
            Some("https://prick.globex.example"),
            &global(&["--profile", "acme"]),
            &EnvVars::default(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "PROFILE_EDIT_REFUSED");
    }

    #[test]
    fn a_sign_in_url_must_be_https_or_loopback() {
        let err = plan_login(
            &Config::default(),
            Some("http://prick.example.com"),
            &global(&[]),
            &EnvVars::default(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_URL");
        plan_login(
            &Config::default(),
            Some("http://127.0.0.1:7788"),
            &global(&[]),
            &EnvVars::default(),
        )
        .expect("loopback is allowed for local development");
    }

    #[test]
    fn a_normal_probe_does_not_stop_the_login() {
        assert!(probe_blocks_login(&Probe::ManagedOAuth { metadata_url: None }).is_none());
    }
}
