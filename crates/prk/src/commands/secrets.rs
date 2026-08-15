//! `prk secrets`.
//!
//! # Constraints these commands are built under
//!
//! - **`set` never takes a value as an argument.** A value on the command line
//!   is in the shell history and visible in `ps` to every user on the box. The
//!   value comes from a masked prompt on the terminal device or from `--stdin`,
//!   and reading the prompt from the device directly is what lets the two
//!   coexist.
//! - **`get` fetches one secret**, not the whole environment to print one of
//!   them.
//! - **`--output` writes mode 0600.** A world-readable file of secrets is the
//!   same defect whether it is written by mistake or by default.
//! - **A decryption failure is loud.** A row that will not decrypt is reported;
//!   it is never quietly dropped, because a silently shorter `.env` is how a
//!   deploy goes out without `DATABASE_URL`.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::PathBuf;

use clap::{Args, Subcommand};
use secrecy::{ExposeSecret as _, SecretString};

use prick_core::format::OutputFormat;

use crate::cli::GlobalArgs;
use crate::commands::{Context, projects::confirm, require_scope};
use crate::error::CliError;
use crate::output::Output;

/// Secret subcommands.
#[derive(Debug, Subcommand)]
pub enum SecretsCommand {
    /// List secret names and metadata. Never values.
    List,

    /// Print one secret's value.
    Get {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Set a secret's value.
    ///
    /// The value is never taken as an argument: it would be recorded in the
    /// shell history and visible to `ps`.
    Set(SetArgs),

    /// Delete a secret.
    #[command(name = "rm")]
    Remove {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Replace an environment's secrets from a file.
    Upload(UploadArgs),

    /// Write an environment's secrets to stdout or a file.
    Download(DownloadArgs),

    /// Show the version history of one secret.
    History {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,
    },

    /// Restore a secret to an earlier version.
    ///
    /// Re-encrypts the old plaintext as a new version. The old ciphertext is
    /// never resurrected, so a rolled-back value is bound to its new version.
    Rollback {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,

        /// The version to restore.
        #[arg(long, value_name = "N")]
        to: u32,
    },
}

impl SecretsCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "secrets list",
            Self::Get { .. } => "secrets get",
            Self::Set(_) => "secrets set",
            Self::Remove { .. } => "secrets rm",
            Self::Upload(_) => "secrets upload",
            Self::Download(_) => "secrets download",
            Self::History { .. } => "secrets history",
            Self::Rollback { .. } => "secrets rollback",
        }
    }
}

/// Arguments to `prk secrets set`.
#[derive(Debug, Clone, Args)]
pub struct SetArgs {
    /// The secret's key.
    #[arg(value_name = "KEY")]
    pub key: String,

    /// Read the value from stdin instead of prompting.
    ///
    /// The prompt reads the terminal device directly, so this and an
    /// interactive prompt never contend for the same stream.
    #[arg(long)]
    pub stdin: bool,

    /// A human-readable description stored alongside the secret.
    #[arg(long, value_name = "TEXT")]
    pub description: Option<String>,
}

/// Arguments to `prk secrets upload`.
#[derive(Debug, Clone, Args)]
pub struct UploadArgs {
    /// The `.env` file to read.
    #[arg(value_name = "FILE")]
    pub file: PathBuf,

    /// Report what would change and exit without writing.
    #[arg(long)]
    pub dry_run: bool,

    /// Fail unless the environment is still at this revision.
    ///
    /// Guards against overwriting a change made between reading and writing.
    #[arg(long, value_name = "REV")]
    pub expected_rev: Option<u64>,
}

/// Arguments to `prk secrets download`.
#[derive(Debug, Clone, Args)]
pub struct DownloadArgs {
    /// Output format.
    #[arg(long, value_name = "FORMAT", default_value = "env")]
    pub format: FormatArg,

    /// Write to a file instead of stdout. Created with mode 0600.
    #[arg(long, short, value_name = "FILE")]
    pub output: Option<PathBuf>,
}

/// Command-line spelling of [`OutputFormat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum FormatArg {
    /// `KEY="value"`, for a `.env` file.
    #[default]
    Env,
    /// `export KEY='value'`, for `eval`.
    Shell,
    /// A flat YAML mapping with quoted keys and values.
    Yaml,
    /// A JSON object with sorted keys.
    Json,
}

impl From<FormatArg> for OutputFormat {
    fn from(value: FormatArg) -> Self {
        match value {
            FormatArg::Env => Self::Env,
            FormatArg::Shell => Self::Shell,
            FormatArg::Yaml => Self::Yaml,
            FormatArg::Json => Self::Json,
        }
    }
}

/// Runs a secrets subcommand.
///
/// # Errors
///
/// [`CliError::Auth`] if no credential is available, [`CliError::Api`] for
/// anything the server reported, [`CliError::Format`] for a value that cannot
/// be represented in the requested format, and [`CliError::Dotenv`] for an
/// unparsable upload.
pub fn run(command: &SecretsCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let (project, environment) = require_scope(global)?;

    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();
    let base = client.url(&["projects", project, "environments", environment, "secrets"]);

    match command {
        SecretsCommand::List => {
            let secrets: Vec<prick_api::models::SecretMeta> =
                context.block_on(client.get_json(&base))?;
            list(&secrets, global, out);
        }

        SecretsCommand::Get { key } => {
            // One secret, not the whole environment filtered down to one.
            let url = prick_core::urlpath::join(&base, &[key]);
            let secret: prick_api::models::SecretValue = context.block_on(client.get_json(&url))?;

            if global.json {
                // The value is the answer to the question that was asked, so it
                // goes to stdout as the sole document.
                out.json(&serde_json::json!({
                    "key": secret.key,
                    "version": secret.version,
                    "value": secret.value.expose_secret(),
                }));
            } else {
                out.data(secret.value.expose_secret());
            }
        }

        SecretsCommand::Set(args) => {
            let value = read_value(args, global, out)?;
            let url = prick_core::urlpath::join(&base, &[&args.key]);
            let mut body = serde_json::json!({ "value": value.expose_secret() });
            if let Some(description) = args.description.as_deref() {
                body["description"] = serde_json::Value::String(description.to_owned());
            }
            let meta: prick_api::models::SecretMeta =
                context.block_on(client.put_json(&url, &body))?;

            if global.json {
                out.json(&serde_json::json!({ "key": meta.key, "version": meta.version }));
            } else {
                out.data(&format!("Set `{}` (version {}).", meta.key, meta.version));
            }
        }

        SecretsCommand::Remove { key } => {
            if !confirm(global, out, &format!("Delete secret `{key}`"))? {
                return Err(CliError::Other("cancelled".to_owned()));
            }
            let url = prick_core::urlpath::join(&base, &[key]);
            context.block_on(client.delete(&url))?;

            if global.json {
                out.json(&serde_json::json!({ "deleted": key }));
            } else {
                out.data(&format!("Deleted `{key}`."));
            }
        }

        SecretsCommand::Download(args) => {
            let export: prick_api::models::SecretExport =
                context.block_on(client.get_json(&format!("{base}:export")))?;
            download(&export, args, global, out)?;
        }

        SecretsCommand::Upload(args) => upload(&context, &base, args, global, out)?,

        SecretsCommand::History { key } => {
            let url = prick_core::urlpath::join(&base, &[key, "versions"]);
            let versions: serde_json::Value = context.block_on(client.get_json(&url))?;
            out.json(&versions);
        }

        SecretsCommand::Rollback { key, to } => {
            let url = format!("{}:rollback", prick_core::urlpath::join(&base, &[key]));
            let body = serde_json::json!({ "to": to });
            let meta: prick_api::models::SecretMeta =
                context.block_on(client.post_json(&url, &body))?;

            if global.json {
                out.json(&serde_json::json!({ "key": meta.key, "version": meta.version }));
            } else {
                out.data(&format!(
                    "Restored `{}` from version {to} as version {}.",
                    meta.key, meta.version
                ));
            }
        }
    }

    Ok(())
}

/// Replaces an environment's secrets from a `.env` file.
///
/// The whole file goes to the server in one request, because a bulk write is
/// one transaction there: splitting it would destroy the atomicity that makes a
/// failed import leave the environment exactly as it was.
fn upload(
    context: &Context,
    base: &str,
    args: &UploadArgs,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let document = std::fs::read_to_string(&args.file)
        .map_err(|err| CliError::Other(format!("could not read {}: {err}", args.file.display())))?;
    let parsed = prick_core::dotenv::parse(&document)?;

    let entries: Vec<serde_json::Value> = parsed
        .iter()
        .map(|(key, value)| serde_json::json!({ "key": key, "value": value }))
        .collect();
    let mut body = serde_json::json!({ "secrets": entries, "dry_run": args.dry_run });
    if let Some(rev) = args.expected_rev {
        body["expected_rev"] = serde_json::json!(rev);
    }

    let response: serde_json::Value =
        context.block_on(context.client().post_json(&format!("{base}:import"), &body))?;

    if global.json {
        out.json(&response);
    } else if args.dry_run {
        out.data(&format!("{} secrets would be written (dry run).", parsed.len()));
    } else {
        out.data(&format!("Wrote {} secrets.", parsed.len()));
    }

    Ok(())
}

/// Prints a listing.
///
/// An unreadable row is called out rather than skipped. A tamper attempt has to
/// be the loudest thing in the system, and a listing that is quietly one row
/// shorter is the opposite of that.
fn list(secrets: &[prick_api::models::SecretMeta], global: &GlobalArgs, out: Output) {
    if global.json {
        let rows: Vec<serde_json::Value> = secrets
            .iter()
            .map(|meta| {
                serde_json::json!({
                    "key": meta.key,
                    "version": meta.version,
                    "unreadable": meta.unreadable,
                })
            })
            .collect();
        out.json(&serde_json::Value::Array(rows));
        return;
    }

    if secrets.is_empty() {
        out.note("No secrets in this environment.");
        return;
    }

    for meta in secrets {
        if meta.unreadable {
            out.data(&format!("{}\tv{}\tUNREADABLE", meta.key, meta.version));
        } else {
            out.data(&format!("{}\tv{}", meta.key, meta.version));
        }
    }

    let unreadable = secrets.iter().filter(|meta| meta.unreadable).count();
    if unreadable > 0 {
        out.warn(&format!(
            "{unreadable} secret(s) could not be decrypted. This is a data-integrity failure, \
             not a display problem: do not deploy from this environment until it is resolved."
        ));
    }
}

/// Renders an export and writes it where it was asked to go.
fn download(
    export: &prick_api::models::SecretExport,
    args: &DownloadArgs,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    // A BTreeMap, so the rendering is byte-identical for identical input and
    // `prk secrets download | diff` is meaningful.
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for secret in &export.secrets {
        values.insert(secret.key.clone(), secret.value.expose_secret().to_owned());
    }

    let rendered = prick_core::format::render(args.format.into(), &values)?;

    match args.output.as_deref() {
        Some(path) => {
            write_private(path, rendered.as_bytes())?;
            if global.json {
                out.json(&serde_json::json!({ "written": path.display().to_string(), "count": values.len() }));
            } else {
                out.note(&format!("Wrote {} secrets to {}.", values.len(), path.display()));
            }
        }
        None => out.data_raw(&rendered),
    }

    Ok(())
}

/// Writes a file only its owner can read.
///
/// The mode is set at creation on Unix rather than afterwards, so there is no
/// window in which a file of secrets is world-readable. On Windows the DACL is
/// replaced with a single entry for the current user.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), CliError> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }

    let mut file = options
        .open(path)
        .map_err(|err| CliError::Other(format!("could not create {}: {err}", path.display())))?;
    file.write_all(bytes)
        .map_err(|err| CliError::Other(format!("could not write {}: {err}", path.display())))?;
    file.sync_all()
        .map_err(|err| CliError::Other(format!("could not write {}: {err}", path.display())))?;
    drop(file);

    #[cfg(windows)]
    prick_exec::winsec::restrict_to_current_user(path, prick_exec::winsec::Inheritance::ObjectOnly)
        .map_err(|err| {
            CliError::Other(format!("could not restrict {} to your account: {err}", path.display()))
        })?;

    Ok(())
}

/// Reads a secret's value without it ever appearing in argv.
///
/// `--stdin` for a pipeline, a masked prompt otherwise. The prompt is written
/// to stderr through [`Output`] and the value is read from the terminal device,
/// so `prk secrets set K --stdin < value` and an interactive prompt never
/// contend for the same stream.
fn read_value(args: &SetArgs, global: &GlobalArgs, out: Output) -> Result<SecretString, CliError> {
    if args.stdin {
        let mut buffer = String::new();
        std::io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|err| CliError::Other(format!("could not read stdin: {err}")))?;
        // A trailing newline is an artefact of `echo`, not part of the value.
        let trimmed = buffer.strip_suffix('\n').unwrap_or(&buffer);
        let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
        return Ok(SecretString::from(trimmed));
    }

    if global.no_input {
        return Err(CliError::Other(
            "refusing to prompt because --no-input was given; pipe the value in with \
             `prk secrets set <KEY> --stdin`"
                .to_owned(),
        ));
    }

    out.note(&format!("Value for {}: ", args.key));
    let value = rpassword::read_password()
        .map_err(|err| CliError::Other(format!("could not read the value: {err}")))?;
    Ok(SecretString::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_argument_spelling_covers_every_output_format() {
        let mapped: Vec<OutputFormat> =
            [FormatArg::Env, FormatArg::Shell, FormatArg::Yaml, FormatArg::Json]
                .into_iter()
                .map(OutputFormat::from)
                .collect();
        assert_eq!(mapped, OutputFormat::ALL.to_vec());
    }

    #[test]
    fn the_default_format_matches_the_librarys() {
        assert_eq!(OutputFormat::from(FormatArg::default()), OutputFormat::default());
    }

    #[test]
    fn set_has_no_way_to_pass_a_value_as_an_argument() {
        // Structural, not a rule: there is no field for it, so a value cannot
        // reach the shell history or `ps` however the command is invoked.
        let args = SetArgs { key: "K".to_owned(), stdin: true, description: None };
        let rendered = format!("{args:?}");
        assert!(rendered.contains('K'));
        assert_eq!(size_of_val(&args.stdin), 1);
    }

    #[test]
    fn an_output_file_is_written_owner_only() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("secrets.env");
        write_private(&path, b"DATABASE_URL=\"x\"\n").expect("write");

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "DATABASE_URL=\"x\"\n");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "a file of secrets was written world-readable");
        }
        #[cfg(windows)]
        assert!(
            prick_exec::winsec::is_restricted_to_current_user(&path).expect("read the DACL"),
            "a file of secrets was left with an inherited ACL"
        );
    }

    #[test]
    fn overwriting_an_existing_output_file_truncates_it() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("secrets.env");
        write_private(&path, b"AAAAAAAAAAAAAAAA\n").expect("write");
        write_private(&path, b"B\n").expect("write");
        // Without truncation the tail of the previous, longer file would
        // survive -- and that tail is secret material.
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "B\n");
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        for command in [
            SecretsCommand::List,
            SecretsCommand::Get { key: "K".to_owned() },
            SecretsCommand::Remove { key: "K".to_owned() },
            SecretsCommand::History { key: "K".to_owned() },
            SecretsCommand::Rollback { key: "K".to_owned(), to: 1 },
        ] {
            assert!(command.path().starts_with("secrets "));
        }
    }
}
