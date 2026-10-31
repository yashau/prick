//! `prk access token`: Cloudflare Access service tokens, managed by the server.
//!
//! # Who holds the Cloudflare credential
//!
//! The Worker does. It keeps a Cloudflare API token as a Worker secret and
//! creates, rotates and deletes Access service tokens on a global
//! administrator's behalf, so this command never sees a Cloudflare credential
//! and needs nothing beyond the prick session it already has.
//!
//! # The capabilities check comes first
//!
//! Before any request of its own, every subcommand asks `GET /capabilities`
//! whether this deployment manages service tokens and whether this caller may.
//! A deployment without the Cloudflare configuration, or a caller without a
//! global admin grant, stops here with the server's own explanation -- before a
//! name, a scope or a rotation has been sent anywhere. A Worker that answers
//! `404` predates the feature, and the message says to upgrade it.
//!
//! # A secret is shown once
//!
//! Create and rotate are the only moments a client secret exists outside
//! Cloudflare; the server stores no copy. So delivering it is this command's
//! one irreversible step, and `--secret-file` decides where it goes: a file
//! written atomically with owner-only permissions, stdout alone for a pipe, or
//! the terminal with a note that it will not be shown again. A file destination
//! is checked before anything is sent, so a typo in a path is found before a
//! secret exists rather than after.
//!
//! # A token belongs to one deployment
//!
//! Every answer names the server host and its instance id, because a token is
//! valid for the deployment that created it and for no other.

mod render;
mod resolve;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use clap::Subcommand;
use secrecy::{ExposeSecret as _, SecretString};

use prick_api::models::Capabilities;
use prick_api::{ApiError, GrantScope, NewServiceToken, ServiceTokenGrant, ops};
use prick_core::classify::ErrorKind;
use prick_core::scope::Scope;

use crate::cli::GlobalArgs;
use crate::commands::access::{RoleArg, expires_at_from_now, require_scope_slugs};
use crate::commands::{Context, projects::confirm};
use crate::error::CliError;
use crate::output::Output;

pub(crate) use resolve::{parse_duration, parse_grace, resolve};

/// The longest grace a rotation may keep the previous secret valid: 30 days.
pub const GRACE_MAX_SECONDS: u32 = 2_592_000;

/// Service-token subcommands.
#[derive(Debug, Subcommand)]
pub enum TokenCommand {
    /// Create a service token, and print its client secret once.
    ///
    /// With `--role`, the token is created holding that grant, in the same
    /// transaction. Without it, the token holds no grant until one is given
    /// with `prk access grant <CLIENT_ID>`.
    Create {
        /// The display name, at most 128 characters. Names the token
        /// everywhere prick lists identities.
        #[arg(value_name = "NAME")]
        name: String,

        /// Grant this role to the new token.
        #[arg(long, value_name = "ROLE")]
        role: Option<RoleArg>,

        /// The grant's scope, written `project:environment`. `*` is a wildcard.
        ///
        /// `*:*` is global, `billing:*` is a whole project, `billing:eu-west` is
        /// one environment. Defaults to `*:*` when `--role` is given.
        #[arg(long, value_name = "SCOPE", requires = "role")]
        scope: Option<String>,

        /// Expire the grant after this many days.
        #[arg(long, value_name = "DAYS", requires = "role")]
        expires_in: Option<u32>,

        /// The token's lifetime in Cloudflare: whole hours such as `8760h`, or
        /// `forever`. The server's default is `8760h`, one year.
        #[arg(long, value_name = "DURATION", value_parser = parse_duration)]
        duration: Option<String>,

        /// Write the client secret to PATH, owner-only, instead of printing it.
        /// `-` writes the secret alone to stdout, for a pipe.
        #[arg(long, value_name = "PATH")]
        secret_file: Option<PathBuf>,
    },

    /// List managed service tokens.
    ///
    /// Flags a token that expires within 30 days, and one Cloudflare has
    /// reported as leaked.
    List {
        /// Include revoked tokens.
        #[arg(long)]
        all: bool,
    },

    /// Replace a token's client secret. The client id, identity and grants
    /// stay.
    Rotate {
        /// The token: its prick id, its client id, or its name.
        #[arg(value_name = "TOKEN")]
        token: String,

        /// Keep the previous secret valid this long, such as `30m`, `24h` or
        /// `7d`; at most `30d`. The previous secret stops working immediately
        /// when this is absent.
        #[arg(long, value_name = "DURATION", value_parser = parse_grace)]
        grace: Option<u32>,

        /// Write the new client secret to PATH, owner-only, instead of printing
        /// it. `-` writes the secret alone to stdout, for a pipe.
        #[arg(long, value_name = "PATH")]
        secret_file: Option<PathBuf>,
    },

    /// Re-read a token's expiry and last use from Cloudflare.
    Refresh {
        /// The token: its prick id, its client id, or its name.
        #[arg(value_name = "TOKEN")]
        token: String,
    },

    /// Revoke a token: disable its identity, then delete it in Cloudflare.
    Revoke {
        /// The token: its prick id, its client id, or its name.
        #[arg(value_name = "TOKEN")]
        token: String,
    },

    /// Bring a service token made in the Cloudflare dashboard under
    /// management. Its secret stays wherever it already is.
    Adopt {
        /// The token's client id, `<hex>.access`.
        #[arg(value_name = "CLIENT_ID")]
        client_id: String,

        /// The display name to give it.
        #[arg(long, value_name = "NAME")]
        name: Option<String>,
    },

    /// Compare prick's records with Cloudflare's.
    Reconcile {
        /// Repair the differences found, after confirming.
        #[arg(long)]
        apply: bool,
    },
}

impl TokenCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::Create { .. } => "access token create",
            Self::List { .. } => "access token list",
            Self::Rotate { .. } => "access token rotate",
            Self::Refresh { .. } => "access token refresh",
            Self::Revoke { .. } => "access token revoke",
            Self::Adopt { .. } => "access token adopt",
            Self::Reconcile { .. } => "access token reconcile",
        }
    }
}

/// Where a client secret goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SecretSink {
    /// The terminal, alongside the client id, with a note that it is shown once.
    Show,
    /// A file, written atomically with owner-only permissions.
    File(PathBuf),
    /// stdout, alone, with nothing after it.
    Stdout,
}

impl SecretSink {
    /// The sink a `--secret-file` value names.
    pub(crate) fn from_flag(flag: Option<&Path>) -> Self {
        match flag {
            None => Self::Show,
            Some(path) if path == Path::new("-") => Self::Stdout,
            Some(path) => Self::File(path.to_owned()),
        }
    }

    /// Refuses a destination that cannot work, before any secret exists.
    ///
    /// # Errors
    ///
    /// [`CliError::Other`] for `-` under `--json`, where stdout already carries
    /// the document, for a path whose directory does not exist, and for a path
    /// that is a directory.
    pub(crate) fn check(&self, json: bool) -> Result<(), CliError> {
        match self {
            Self::Stdout if json => Err(CliError::Other(
                "--secret-file - writes the secret alone to stdout, which --json also claims; \
                 drop --json, or give --secret-file a path"
                    .to_owned(),
            )),
            Self::Show | Self::Stdout => Ok(()),
            Self::File(path) => {
                if path.is_dir() {
                    return Err(CliError::Other(format!(
                        "--secret-file {} is a directory; name a file inside it",
                        path.display()
                    )));
                }
                let parent = match path.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => parent,
                    _ => Path::new("."),
                };
                if parent.is_dir() {
                    Ok(())
                } else {
                    Err(CliError::Other(format!(
                        "--secret-file {}: the directory {} does not exist",
                        path.display(),
                        parent.display()
                    )))
                }
            }
        }
    }
}

/// The deployment a token belongs to, as every answer names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deployment {
    /// The server's host.
    pub host: String,
    /// The deployment's instance id, when it reports one.
    pub instance: Option<String>,
}

impl Deployment {
    /// `prick.example.com (instance 3f9c01ab)`.
    pub(crate) fn label(&self) -> String {
        match self.instance.as_deref() {
            Some(id) => {
                format!("{} (instance {})", self.host, prick_core::profile::short_instance(id))
            }
            None => format!("{} (no instance id reported)", self.host),
        }
    }
}

/// Runs a service-token subcommand.
///
/// # Errors
///
/// [`CliError::Api`] when the server predates the feature, does not have it
/// configured, refuses this caller, or reports a failure; [`CliError::Other`]
/// for a token that cannot be resolved or a secret that cannot be delivered.
pub fn run(command: &TokenCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    // Everything that can be refused locally is refused before a request.
    let prepared = prepare(command, global)?;

    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let capabilities =
        require_service_tokens(context.block_on(ops::capabilities(context.client())))?;
    let deployment = Deployment {
        host: context.target().host(),
        instance: capabilities
            .instance
            .clone()
            .or_else(|| context.target().verified_instance.clone()),
    };

    match command {
        TokenCommand::Create { name, duration, .. } => {
            let grant = prepared.grant.as_ref().map(PreparedGrant::as_request).transpose()?;
            let request = NewServiceToken { name, duration: duration.as_deref(), grant };
            let issued = context.block_on(ops::create_service_token(context.client(), &request))?;
            let sink = &prepared.sink;
            deliver(&issued.client_secret, sink, out)
                .map_err(|err| undelivered(&err, "created", &issued.client_id))?;
            render::created(&issued, prepared.grant.as_ref(), &deployment, sink, global, out);
        }

        TokenCommand::List { all } => {
            let list = context.block_on(ops::list_service_tokens(context.client()))?;
            render::list(&list, *all, now_ms(), &deployment, global, out);
        }

        TokenCommand::Rotate { token, grace, .. } => {
            rotate(&context, &deployment, token, *grace, &prepared.sink, global, out)?;
        }

        TokenCommand::Refresh { token } => {
            let tokens = context.block_on(ops::list_service_tokens(context.client()))?.tokens;
            let found = resolve(&tokens, token)?;
            let refreshed =
                context.block_on(ops::refresh_service_token(context.client(), &found.id))?;
            render::one(&refreshed, "Refreshed", now_ms(), &deployment, global, out);
        }

        TokenCommand::Revoke { token } => {
            let tokens = context.block_on(ops::list_service_tokens(context.client()))?.tokens;
            let found = resolve(&tokens, token)?;
            let question = format!(
                "Revoke `{}` ({}) on {}, disabling its identity and deleting the token in \
                 Cloudflare",
                found.label(),
                found.client_id,
                deployment.label()
            );
            if !confirm(global, out, &question)? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            context.block_on(ops::revoke_service_token(context.client(), &found.id))?;
            render::revoked(found, &deployment, global, out);
        }

        TokenCommand::Adopt { client_id, name } => {
            let adopted = context.block_on(ops::adopt_service_token(
                context.client(),
                client_id,
                name.as_deref(),
            ))?;
            render::one(&adopted, "Adopted", now_ms(), &deployment, global, out);
            if !global.json {
                out.note(&format!(
                    "Grant it a role with `prk access grant {} --role <ROLE> --scope \
                     <PROJECT>:<ENVIRONMENT>`.",
                    adopted.client_id
                ));
            }
        }

        TokenCommand::Reconcile { apply } => {
            reconcile(&context, &deployment, *apply, global, out)?;
        }
    }

    Ok(())
}

/// `rotate`: resolve, confirm, rotate, deliver.
fn rotate(
    context: &Context,
    deployment: &Deployment,
    token: &str,
    grace: Option<u32>,
    sink: &SecretSink,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let tokens = context.block_on(ops::list_service_tokens(context.client()))?.tokens;
    let found = resolve(&tokens, token)?;
    let ending = match grace {
        Some(seconds) if seconds > 0 => {
            format!("keeping the current secret valid for {}", render::seconds(seconds))
        }
        _ => "ending the current secret immediately".to_owned(),
    };
    let question = format!(
        "Rotate the secret of `{}` ({}) on {}, {ending}",
        found.label(),
        found.client_id,
        deployment.label()
    );
    if !confirm(global, out, &question)? {
        return Err(CliError::Other("cancelled".to_owned()));
    }
    let rotated =
        context.block_on(ops::rotate_service_token(context.client(), &found.id, grace))?;
    deliver(&rotated.client_secret, sink, out)
        .map_err(|err| undelivered(&err, "rotated", &rotated.client_id))?;
    render::rotated(&rotated, deployment, sink, global, out);
    Ok(())
}

/// `reconcile`: always a dry run first, so an `--apply` confirms a list the
/// operator has seen.
fn reconcile(
    context: &Context,
    deployment: &Deployment,
    apply: bool,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let found = context.block_on(ops::reconcile_service_tokens(context.client(), false))?;
    // `foreign` entries belong to another deployment and are never repaired.
    let repairs = found.entries.iter().filter(|entry| entry.kind != "foreign").count();
    if !apply || repairs == 0 {
        render::reconciled(&found, deployment, global, out);
        return Ok(());
    }
    render::reconcile_preview(&found, out);
    let question = format!("Apply {repairs} repair(s) on {}", deployment.label());
    if !confirm(global, out, &question)? {
        return Err(CliError::Other("cancelled".to_owned()));
    }
    let applied = context.block_on(ops::reconcile_service_tokens(context.client(), true))?;
    render::reconciled(&applied, deployment, global, out);
    Ok(())
}

/// What a subcommand settled before contacting the server.
#[derive(Debug)]
struct Prepared {
    /// Where a secret goes, for create and rotate.
    sink: SecretSink,
    /// The grant to create a token holding, for create.
    grant: Option<PreparedGrant>,
}

/// A grant, parsed and validated.
#[derive(Debug)]
pub(crate) struct PreparedGrant {
    /// The role.
    pub role: RoleArg,
    /// The scope, as typed.
    pub scope: Scope,
    /// The absolute expiry, epoch milliseconds.
    pub expires_at: Option<i64>,
}

impl PreparedGrant {
    /// The request member this grant becomes.
    ///
    /// # Errors
    ///
    /// [`CliError::Api`] for `*:something`, which [`prepare_grant`] has already
    /// refused, so in practice never.
    fn as_request(&self) -> Result<ServiceTokenGrant<'_>, CliError> {
        Ok(ServiceTokenGrant {
            role: self.role.as_str(),
            scope: GrantScope::from_scope(&self.scope)?,
            expires_at: self.expires_at,
        })
    }
}

/// Parses and checks everything a subcommand can check without the server.
fn prepare(command: &TokenCommand, global: &GlobalArgs) -> Result<Prepared, CliError> {
    let (secret_file, grant) = match command {
        TokenCommand::Create { role, scope, expires_in, secret_file, .. } => {
            let grant =
                role.map(|role| prepare_grant(role, scope.as_deref(), *expires_in)).transpose()?;
            (secret_file.as_deref(), grant)
        }
        TokenCommand::Rotate { secret_file, .. } => (secret_file.as_deref(), None),
        _ => (None, None),
    };
    let sink = SecretSink::from_flag(secret_file);
    sink.check(global.json)?;
    Ok(Prepared { sink, grant })
}

/// Parses a grant the way `prk access grant` does, so `*:*` means the same.
pub(crate) fn prepare_grant(
    role: RoleArg,
    scope: Option<&str>,
    expires_in: Option<u32>,
) -> Result<PreparedGrant, CliError> {
    let scope: Scope = scope.unwrap_or("*:*").parse()?;
    require_scope_slugs(&scope)?;
    GrantScope::from_scope(&scope)?;
    let expires_at = expires_in.map(expires_at_from_now).transpose()?;
    Ok(PreparedGrant { role, scope, expires_at })
}

/// Turns the capabilities answer into permission to proceed, or the reason not.
///
/// # Errors
///
/// [`ErrorKind::NotFound`] when the Worker predates `/capabilities` or does not
/// report the feature, [`ErrorKind::ServiceUnavailable`] (exit 8) when the
/// deployment lacks the Cloudflare configuration, and [`ErrorKind::Forbidden`]
/// (exit 4) for a caller without a global admin grant -- the same codes the
/// routes themselves answer with.
pub(crate) fn require_service_tokens(
    answer: Result<Capabilities, ApiError>,
) -> Result<Capabilities, CliError> {
    let capabilities = match answer {
        Ok(capabilities) => capabilities,
        Err(err) if err.kind() == ErrorKind::NotFound => return Err(predates()),
        Err(err) => return Err(err.into()),
    };

    let Some(feature) = capabilities.service_tokens() else { return Err(predates()) };

    if feature.allowed {
        return Ok(capabilities);
    }

    if feature.reason.is_some() || feature.hint.is_some() {
        let err = ApiError::new(
            ErrorKind::ServiceUnavailable,
            "this server does not have service-token management configured \
             (SERVICE_TOKENS_UNCONFIGURED)",
        );
        return Err(match feature.hint.as_deref() {
            Some(hint) => err.with_server_hint(hint),
            None => err,
        }
        .into());
    }

    Err(ApiError::new(
        ErrorKind::Forbidden,
        "managing service tokens needs a global admin grant on this server",
    )
    .with_server_hint(
        "A global administrator can grant one with `prk access grant <SUBJECT> --role admin \
         --scope '*:*'`. `prk whoami` shows the identity the server sees.",
    )
    .into())
}

/// The error for a Worker that predates service-token management.
fn predates() -> CliError {
    ApiError::new(
        ErrorKind::NotFound,
        "this server predates service-token management: it does not report the feature at \
         /api/v1/capabilities",
    )
    .with_server_hint(
        "Deploy a newer release of the prick Worker. `prk doctor` shows the version it runs.",
    )
    .into()
}

/// Delivers a secret to a file or to stdout. [`SecretSink::Show`] is printed by
/// the renderer, alongside the client id.
///
/// # Errors
///
/// The I/O error writing the file.
fn deliver(secret: &SecretString, sink: &SecretSink, out: Output) -> std::io::Result<()> {
    match sink {
        SecretSink::Show => Ok(()),
        SecretSink::Stdout => {
            out.secret_data_raw(secret.expose_secret());
            Ok(())
        }
        SecretSink::File(path) => {
            prick_auth::write_owner_only_file(path, secret.expose_secret().as_bytes())
        }
    }
}

/// The error for a secret that exists and could not be written down.
///
/// The token was created or rotated, and its secret went with the response, so
/// the way forward is another rotation -- which this says, by client id.
fn undelivered(err: &std::io::Error, what: &str, client_id: &str) -> CliError {
    CliError::Other(format!(
        "the token was {what}, but its secret could not be written ({err}); the secret is not \
         recoverable, so issue a new one with `prk access token rotate {client_id}`"
    ))
}

/// Now, in epoch milliseconds. Zero for a clock before 1970, which makes every
/// expiry read as far away rather than as past.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|now| i64::try_from(now.as_millis()).ok())
        .unwrap_or(0)
}
