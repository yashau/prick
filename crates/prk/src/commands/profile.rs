//! `prk profile`: the saved servers.
//!
//! A profile is a local name for one server and the session signed in to it.
//! The name is a label and can change at any time; what identifies the server
//! is the instance id it reports, which the profile pins. Every display shows
//! the host and the instance next to the name for that reason.

use std::path::{Path, PathBuf};

use clap::Subcommand;

use prick_auth::profiles::{
    LOCAL_FILE_NAME, PROJECT_FILE_NAME, ProfileStore, parse_local_file, parse_project_file,
    serialize_toml,
};
use prick_core::profile::{
    Allow, Config, LocalFile, Profile, ProjectFile, edit, host_of, is_profile_name, short_instance,
    validate_url,
};
use prick_core::slug::is_slug;

use crate::cli::GlobalArgs;
use crate::commands::{Context, auth, projects};
use crate::error::CliError;
use crate::output::Output;
use crate::target::TargetError;

/// `prk profile` subcommands.
#[derive(Debug, Clone, Subcommand)]
pub enum ProfileCommand {
    /// List every profile, with its server, instance and sign-in state.
    List,

    /// Show one profile, or the one this command line and directory select.
    Show {
        /// The profile. Omit it to see which one is selected, and why.
        name: Option<String>,
    },

    /// Save a server as a profile, without signing in.
    ///
    /// No request is made. The profile is pinned to the server's instance the
    /// first time it is used.
    Add {
        /// The profile's name: lowercase letters, digits and single hyphens.
        name: String,
        /// The server's base URL. https, or http to a loopback address.
        url: String,
        /// Make it the default. The first profile always is.
        #[arg(long)]
        default: bool,
        /// Allow a name a renamed profile left behind, for a different deployment.
        #[arg(long)]
        reuse_name: bool,
    },

    /// Make a profile the default.
    ///
    /// The default is used for reads when nothing else selects a server. With
    /// more than one profile, a command that changes data must name its server
    /// explicitly.
    Use {
        /// The profile.
        name: String,
    },

    /// Rename a profile.
    ///
    /// Only the name changes: the session stays signed in and the instance pin
    /// is kept. The old name then fails with a message naming the new one, and
    /// cannot be reused for a different deployment without `--reuse-name`.
    Rename {
        /// The current name.
        old: String,
        /// The new name.
        new: String,
    },

    /// Free a name a rename left behind, so it can be used for anything.
    Forget {
        /// The old name.
        name: String,
    },

    /// Change a profile's defaults, and the service token it expects.
    ///
    /// Pass an empty string to clear a value.
    Set {
        /// The profile.
        name: String,
        /// The project used when neither `--project` nor `PRK_PROJECT` names one.
        #[arg(long, value_name = "SLUG")]
        default_project: Option<String>,
        /// The environment used when neither `--env` nor `PRK_ENV` names one.
        #[arg(long, value_name = "SLUG")]
        default_env: Option<String>,
        /// Refuse any service token from the environment but this client id.
        #[arg(long, value_name = "ID")]
        service_token_client_id: Option<String>,
    },

    /// Sign out of a profile and delete it.
    #[command(alias = "rm")]
    Remove {
        /// The profile.
        name: String,
        /// Discard the session without asking the server to forget it.
        #[arg(long)]
        no_revoke: bool,
    },

    /// Record the selected server's instance in this project's `.prick.toml`.
    ///
    /// Adds an `[[allow]]` entry, creating the file if needed, so the project
    /// selects this deployment on every machine. With `--local`, writes the
    /// choice to the git-ignored `.prick.local.toml` instead, for a project
    /// that allows several deployments.
    Pin {
        /// Write `.prick.local.toml` instead.
        #[arg(long)]
        local: bool,
    },
}

impl ProfileCommand {
    /// The command path, for diagnostics.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "profile list",
            Self::Show { .. } => "profile show",
            Self::Add { .. } => "profile add",
            Self::Use { .. } => "profile use",
            Self::Rename { .. } => "profile rename",
            Self::Forget { .. } => "profile forget",
            Self::Set { .. } => "profile set",
            Self::Remove { .. } => "profile rm",
            Self::Pin { .. } => "profile pin",
        }
    }
}

/// Runs a `prk profile` subcommand.
///
/// # Errors
///
/// Whatever the subcommand reports.
pub fn run(command: &ProfileCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let store = ProfileStore::new()?;
    match command {
        ProfileCommand::List => list(&store, out),
        ProfileCommand::Show { name } => show(&store, name.as_deref(), global, out),
        ProfileCommand::Add { name, url, default, reuse_name } => {
            add(&store, name, url, *default, *reuse_name, out)
        }
        ProfileCommand::Use { name } => {
            store.update(|config| -> Result<(), CliError> {
                *config = edit::set_default(config, name).map_err(TargetError::from)?;
                Ok(())
            })?;
            report(
                out,
                &format!("Default profile is now {name}."),
                &serde_json::json!({ "default": name }),
            );
            Ok(())
        }
        ProfileCommand::Rename { old, new } => rename(&store, old, new, out),
        ProfileCommand::Forget { name } => {
            store.update(|config| -> Result<(), CliError> {
                *config = edit::forget(config, name).map_err(TargetError::from)?;
                Ok(())
            })?;
            report(
                out,
                &format!("`{name}` is free to use."),
                &serde_json::json!({ "forgotten": name }),
            );
            Ok(())
        }
        ProfileCommand::Set { name, default_project, default_env, service_token_client_id } => set(
            &store,
            name,
            default_project.as_deref(),
            default_env.as_deref(),
            service_token_client_id.as_deref(),
            out,
        ),
        ProfileCommand::Remove { name, no_revoke } => remove(&store, name, *no_revoke, global, out),
        ProfileCommand::Pin { local } => pin(*local, global, out),
    }
}

/// Prints a one-line confirmation, or its JSON form.
fn report(out: Output, text: &str, json: &serde_json::Value) {
    if out.is_json() {
        out.json(json);
    } else {
        out.data(text);
    }
}

/// What `list` and `show` say about one profile. Never a token.
fn describe(
    store: &ProfileStore,
    config: &Config,
    name: &str,
    profile: &Profile,
) -> serde_json::Value {
    let session = store.tokens(profile).load();
    let (signed_in, expires_at, unreadable) = match &session {
        Ok(Some(session)) => (session.api_url == profile.api_url, session.tokens.expires_at, false),
        Ok(None) => (false, None, false),
        Err(_) => (false, None, true),
    };
    serde_json::json!({
        "name": name,
        "default": config.default_profile.as_deref() == Some(name),
        "api_url": profile.api_url,
        "server": host_of(&profile.api_url),
        "instance": profile.instance,
        "issuer": profile.issuer,
        "signed_in": signed_in,
        "expires_at": expires_at,
        "credential_unreadable": unreadable,
        "project": profile.project,
        "env": profile.env,
        "service_token_client_id": profile.service_token_client_id,
    })
}

fn list(store: &ProfileStore, out: Output) -> Result<(), CliError> {
    let config = store.load().map_err(TargetError::from)?.config;
    let rows: Vec<_> = config
        .profiles
        .iter()
        .map(|(name, profile)| describe(store, &config, name, profile))
        .collect();

    if out.is_json() {
        out.json(&serde_json::Value::Array(rows));
        return Ok(());
    }
    if config.profiles.is_empty() {
        out.data("No profiles. Run `prk login <URL>` to create one.");
        return Ok(());
    }

    let width = config.profiles.keys().map(String::len).max().unwrap_or(0);
    let host_width = config.profiles.values().map(|p| host_of(&p.api_url).len()).max().unwrap_or(0);
    for (name, profile) in &config.profiles {
        let marker = if config.default_profile.as_deref() == Some(name) { "*" } else { " " };
        let instance = profile
            .instance
            .as_deref()
            .map_or_else(|| "unverified".to_owned(), |id| short_instance(id).to_owned());
        let state = match store.tokens(profile).load() {
            Ok(Some(session)) if session.api_url == profile.api_url => "signed in",
            Ok(_) => "signed out",
            Err(_) => "credential unreadable",
        };
        out.data(&format!(
            "{marker} {name:<width$}  {host:<host_width$}  instance {instance:<10}  {state}",
            host = host_of(&profile.api_url),
        ));
    }
    Ok(())
}

fn show(
    store: &ProfileStore,
    name: Option<&str>,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let config = store.load().map_err(TargetError::from)?.config;
    let (name, source) = if let Some(name) = name {
        (name.to_owned(), None)
    } else {
        let target = crate::target::resolve(global)?;
        let source = crate::target::describe_source(target.selection.source(), &target);
        let Some(name) = target.selection.profile().map(str::to_owned) else {
            report(
                out,
                &format!("{} (no profile; {source})", target.api_url),
                &serde_json::json!({
                    "api_url": target.api_url,
                    "profile": null,
                    "source": target.selection.source().as_str(),
                }),
            );
            return Ok(());
        };
        (name, Some((source, target.selection.source().as_str())))
    };
    let profile = config.profiles.get(&name).ok_or_else(|| {
        TargetError::Select(prick_core::profile::SelectError::Unknown {
            name: name.clone(),
            known: config.profiles.keys().cloned().collect(),
        })
    })?;

    let mut value = describe(store, &config, &name, profile);
    if let Some((_, source)) = &source {
        value["source"] = serde_json::json!(source);
    }
    if out.is_json() {
        out.json(&value);
        return Ok(());
    }

    let selected = source.map(|(text, _)| format!(" (selected {text})")).unwrap_or_default();
    out.data(&format!("{name}{selected}"));
    out.data(&format!("  server:   {}", profile.api_url));
    out.data(&format!("  instance: {}", profile.instance.as_deref().unwrap_or("unverified")));
    if let Some(issuer) = &profile.issuer {
        out.data(&format!("  access:   {issuer}"));
    }
    let signed_in = value["signed_in"].as_bool().unwrap_or(false);
    out.data(&format!("  session:  {}", if signed_in { "signed in" } else { "signed out" }));
    for (label, field) in [
        ("project", &profile.project),
        ("env", &profile.env),
        ("token", &profile.service_token_client_id),
    ] {
        if let Some(value) = field {
            out.data(&format!("  {label}:{:pad$}{value}", "", pad = 9 - label.len()));
        }
    }
    if config.default_profile.as_deref() == Some(name.as_str()) {
        out.data("  default:  yes");
    }
    Ok(())
}

fn add(
    store: &ProfileStore,
    name: &str,
    url: &str,
    make_default: bool,
    reuse: bool,
    out: Output,
) -> Result<(), CliError> {
    let url = validate_url(url).map_err(TargetError::from)?;
    let config = store.load().map_err(TargetError::from)?.config;
    let credential = auth::fresh_credential(&config, store)?;
    let config = store.update(|config| -> Result<Config, CliError> {
        *config = edit::add(config, name, Profile::new(&url, &credential), make_default, reuse)
            .map_err(TargetError::from)?;
        Ok(config.clone())
    })?;
    let is_default = config.default_profile.as_deref() == Some(name);
    report(
        out,
        &format!(
            "Added profile {name} for {}{}. Run `prk login --profile {name}` to sign in.",
            host_of(&url),
            if is_default { " (default)" } else { "" }
        ),
        &serde_json::json!({ "name": name, "api_url": url, "default": is_default }),
    );
    Ok(())
}

fn rename(store: &ProfileStore, old: &str, new: &str, out: Output) -> Result<(), CliError> {
    let instance = store.update(|config| -> Result<Option<String>, CliError> {
        *config = edit::rename(config, old, new).map_err(TargetError::from)?;
        Ok(config.profiles.get(new).and_then(|profile| profile.instance.clone()))
    })?;
    report(
        out,
        &format!("Renamed {old} to {new}. `--profile {old}` now fails with a pointer here."),
        &serde_json::json!({ "from": old, "to": new, "instance": instance }),
    );
    Ok(())
}

fn set(
    store: &ProfileStore,
    name: &str,
    project: Option<&str>,
    env: Option<&str>,
    client_id: Option<&str>,
    out: Output,
) -> Result<(), CliError> {
    for (label, value) in [("project", project), ("environment", env)] {
        if let Some(value) = value.filter(|value| !value.is_empty())
            && !is_slug(value)
        {
            return Err(CliError::Other(format!("`{value}` is not a usable {label} name")));
        }
    }
    let clear = |value: Option<&str>, field: &mut Option<String>| {
        if let Some(value) = value {
            *field = Some(value.to_owned()).filter(|value| !value.is_empty());
        }
    };
    let profile = store.update(|config| -> Result<Profile, CliError> {
        let profile = config.profiles.get_mut(name).ok_or_else(|| {
            TargetError::Edit(prick_core::profile::EditError::Unknown { name: name.to_owned() })
        })?;
        clear(project, &mut profile.project);
        clear(env, &mut profile.env);
        clear(client_id, &mut profile.service_token_client_id);
        Ok(profile.clone())
    })?;
    report(
        out,
        &format!("Updated profile {name}."),
        &serde_json::json!({
            "name": name,
            "project": profile.project,
            "env": profile.env,
            "service_token_client_id": profile.service_token_client_id,
        }),
    );
    Ok(())
}

fn remove(
    store: &ProfileStore,
    name: &str,
    no_revoke: bool,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    if !is_profile_name(name) {
        return Err(TargetError::Edit(prick_core::profile::EditError::InvalidName {
            name: name.to_owned(),
        })
        .into());
    }
    let config = store.load().map_err(TargetError::from)?.config;
    let profile = config.profiles.get(name).cloned().ok_or_else(|| {
        TargetError::Edit(prick_core::profile::EditError::Unknown { name: name.to_owned() })
    })?;
    let host = host_of(&profile.api_url);
    if !projects::confirm(global, out, &format!("Remove profile {name} and sign out of {host}"))? {
        return Err(CliError::Other("not confirmed; nothing was removed".to_owned()));
    }

    let tokens = store.tokens(&profile);
    if let Some(session) = tokens.load().unwrap_or(None)
        && session.api_url == profile.api_url
        && !no_revoke
    {
        auth::revoke_quietly(&session, global, out);
    }
    tokens.clear()?;

    store.update(|config| -> Result<(), CliError> {
        if config.profiles.contains_key(name) {
            *config = edit::remove(config, name).map_err(TargetError::from)?.0;
        }
        Ok(())
    })?;
    report(
        out,
        &format!("Removed profile {name} ({host})."),
        &serde_json::json!({ "removed": name, "server": host }),
    );
    Ok(())
}

fn pin(local: bool, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    // Resolved without the project's allow list: pinning is how a deployment
    // gets onto it, so that list cannot be what decides whether it may.
    let mut target = crate::target::resolve(global)?;
    let project_dir = target.project.as_ref().map(|found| found.dir.clone());
    target.project = None;

    let mut context = Context::with_target(global, target)?;
    context.authenticate(out)?;
    let instance = context.target().verified_instance.clone().ok_or_else(|| {
        CliError::Other(format!(
            "{} reports no instance id, so there is nothing to pin",
            context.target().host()
        ))
    })?;

    let dir = match project_dir {
        Some(dir) => dir,
        None => std::env::current_dir().map_err(|err| {
            CliError::Other(format!("could not read the current directory: {err}"))
        })?,
    };
    let written = if local { pin_local(&dir, &instance)? } else { pin_shared(&dir, &instance)? };

    report(
        out,
        &format!(
            "Pinned instance {} ({}) in {}.",
            short_instance(&instance),
            context.target().host(),
            written.display()
        ),
        &serde_json::json!({ "instance": instance, "server": context.target().host(), "file": written.display().to_string() }),
    );
    if local && !is_git_ignored(&dir) {
        out.warn(&format!("{LOCAL_FILE_NAME} is not ignored by git; add it to .gitignore, or prk refuses to use it"));
    }
    Ok(())
}

fn pin_shared(dir: &Path, instance: &str) -> Result<PathBuf, CliError> {
    let path = dir.join(PROJECT_FILE_NAME);
    let mut file = match read(&path)? {
        Some(text) => parse_project_file(&text, &path).map_err(TargetError::from)?,
        None => ProjectFile::default(),
    };
    if !file.allow.iter().any(|allow| allow.instance == instance) {
        file.allow.push(Allow { instance: instance.to_owned(), issuer: None });
    }
    if file.allow.len() > 1 {
        // A file that lists several deployments cannot also choose one.
        file.profile = None;
    }
    write(&path, &serialize_toml(&file))?;
    Ok(path)
}

fn pin_local(dir: &Path, instance: &str) -> Result<PathBuf, CliError> {
    let shared = dir.join(PROJECT_FILE_NAME);
    let allows = match read(&shared)? {
        Some(text) => parse_project_file(&text, &shared)
            .map_err(TargetError::from)?
            .allow
            .iter()
            .any(|allow| allow.instance == instance),
        None => false,
    };
    if !allows {
        return Err(CliError::Other(format!(
            "{} does not allow this instance; run `prk profile pin` first so the project lists it",
            shared.display()
        )));
    }
    let path = dir.join(LOCAL_FILE_NAME);
    let mut file = match read(&path)? {
        Some(text) => parse_local_file(&text, &path).map_err(TargetError::from)?,
        None => LocalFile::default(),
    };
    file.instance = Some(instance.to_owned());
    write(&path, &serialize_toml(&file))?;
    Ok(path)
}

fn read(path: &Path) -> Result<Option<String>, CliError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(CliError::Other(format!("could not read {}: {err}", path.display()))),
    }
}

fn write(path: &Path, text: &str) -> Result<(), CliError> {
    std::fs::write(path, text)
        .map_err(|err| CliError::Other(format!("could not write {}: {err}", path.display())))
}

fn is_git_ignored(dir: &Path) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "-q", LOCAL_FILE_NAME])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::*;

    #[test]
    fn what_list_and_show_report_never_includes_a_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::in_dir(dir.path());
        let profile = Profile::new("https://prick.acme.example", "0000000000000001");
        store
            .tokens(&profile)
            .save(&prick_auth::StoredSession {
                api_url: profile.api_url.clone(),
                issuer: "https://acme.cloudflareaccess.com".to_owned(),
                client_id: "client".to_owned(),
                token_endpoint: "https://acme.cloudflareaccess.com/token".to_owned(),
                resource: None,
                revocation_endpoint: None,
                tokens: prick_auth::Tokens {
                    access_token: SecretString::from("canary-access-token"),
                    refresh_token: Some(SecretString::from("canary-refresh-token")),
                    expires_at: Some(42),
                },
            })
            .unwrap();
        let config = edit::add(&Config::default(), "acme", profile.clone(), true, false).unwrap();

        let rendered = describe(&store, &config, "acme", &profile).to_string();
        assert!(!rendered.contains("canary"), "a token reached profile output: {rendered}");
        assert!(rendered.contains("\"signed_in\":true"), "{rendered}");
        assert!(rendered.contains("\"expires_at\":42"), "{rendered}");
    }

    #[test]
    fn pinning_adds_the_instance_and_a_shared_file_with_several_stops_choosing() {
        let dir = tempfile::tempdir().unwrap();
        let acme = "a".repeat(32);
        let globex = "b".repeat(32);
        std::fs::write(
            dir.path().join(PROJECT_FILE_NAME),
            format!(
                "profile = \"acme\"
project = \"api\"
[[allow]]
instance = \"{acme}\"
"
            ),
        )
        .unwrap();
        pin_shared(dir.path(), &globex).unwrap();
        pin_shared(dir.path(), &globex).unwrap();

        let path = dir.path().join(PROJECT_FILE_NAME);
        let file = parse_project_file(&std::fs::read_to_string(&path).unwrap(), &path).unwrap();
        assert_eq!(file.allow.len(), 2, "pinning twice adds once");
        assert_eq!(file.profile, None, "a file listing several deployments cannot choose one");
        assert_eq!(file.project.as_deref(), Some("api"));

        pin_local(dir.path(), &globex).unwrap();
        let local_path = dir.path().join(LOCAL_FILE_NAME);
        let local =
            parse_local_file(&std::fs::read_to_string(&local_path).unwrap(), &local_path).unwrap();
        assert_eq!(local.instance.as_deref(), Some(globex.as_str()));
        assert!(
            pin_local(dir.path(), &"c".repeat(32)).is_err(),
            "a local pin must be allowed first"
        );
    }
}
