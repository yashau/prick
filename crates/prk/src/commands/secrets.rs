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
//!
//! # Every write goes through one route
//!
//! `POST …/secrets:batch`. There is no per-key `PUT` or `DELETE`, and that is
//! not an omission: a batch is one D1 transaction with its audit row as the
//! last statement inside it, so an un-audited or half-applied write is not
//! expressible. `set` and `rm` each send a one-entry batch.
//!
//! # Descriptions travel with values
//!
//! `set --description` sends `descriptions` alongside `set` in the same batch,
//! which is the only shape the server accepts: every key in `descriptions` must
//! also be in `set`. So there is no way to edit a description without writing
//! the value, and that is the server's rule rather than this command's --
//! a metadata-only update would raise "does it bump a version", and the answer
//! has to be no, because a description is not ciphertext and the AAD does not
//! bind it.
//!
//! Omitting the flag leaves any stored description ALONE. It is not a clear.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use secrecy::{ExposeSecret as _, SecretString};

use prick_api::models::SecretExport;
use prick_api::ops;
use prick_api::{BatchRequest, ImportFormat, ImportRequest, RevealReason, WriteMode};
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

        /// Recorded verbatim in the audit row. Never contains a value.
        ///
        /// The most destructive thing that can be done to one secret is the
        /// one an operator most often has to explain afterwards, and the
        /// tombstone is the only row left to explain it on.
        #[arg(long, value_name = "TEXT")]
        reason: Option<String>,
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
    /// Re-encrypts the old plaintext as a **new** version. The old ciphertext is
    /// never resurrected: its AAD binds it to the version it was sealed at, so
    /// writing those bytes back as current would fail the next read's tag check.
    Rollback {
        /// The secret's key.
        #[arg(value_name = "KEY")]
        key: String,

        /// The version to restore.
        #[arg(long, value_name = "N")]
        to: u32,

        /// Recorded verbatim in the audit row.
        #[arg(long, value_name = "TEXT")]
        reason: Option<String>,
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

    /// Human-readable note stored with the secret, shown in a listing.
    ///
    /// Omitting it leaves any existing description alone -- it is not a clear.
    /// Stored in plaintext beside the key name; never put a value in it.
    #[arg(long, value_name = "TEXT")]
    pub description: Option<String>,

    /// Recorded verbatim in the audit row. Never contains a value.
    #[arg(long, value_name = "TEXT")]
    pub reason: Option<String>,
}

/// Arguments to `prk secrets upload`.
#[derive(Debug, Clone, Args)]
pub struct UploadArgs {
    /// The file to upload. A `.json` extension is sent as JSON; anything else
    /// is sent as a `.env` document.
    ///
    /// The file is sent as a blob and parsed **by the server**, so what the
    /// server accepts is exactly what this command accepts.
    #[arg(value_name = "FILE")]
    pub file: PathBuf,

    /// Report what would change and exit without writing.
    #[arg(long)]
    pub dry_run: bool,

    /// Fail unless the environment is still at this revision.
    ///
    /// Guards against overwriting a change made between reading and writing.
    /// `prk env list` reports the current revision.
    #[arg(long, value_name = "REV")]
    pub expected_rev: Option<u64>,

    /// Merge into the environment instead of replacing it.
    ///
    /// Without this, keys the file does not name are deleted -- which is what
    /// "upload this environment" means, and why `--expected-rev` exists.
    #[arg(long)]
    pub merge: bool,

    /// Recorded verbatim in the audit row.
    #[arg(long, value_name = "TEXT")]
    pub reason: Option<String>,
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
/// anything the server reported -- which includes an unparsable upload, since
/// the document is parsed there -- and [`CliError::Format`] for a value that
/// cannot be represented in the requested format.
pub fn run(command: &SecretsCommand, global: &GlobalArgs, out: Output) -> Result<(), CliError> {
    let (project, environment) = require_scope(global)?;

    let mut context = Context::new(global)?;
    context.authenticate(out)?;
    let client = context.client();

    match command {
        SecretsCommand::List => {
            let secrets = context.block_on(ops::list_secrets(client, project, environment))?;
            list(&secrets, global, out);
        }

        SecretsCommand::Get { key } => {
            // One secret, not the whole environment filtered down to one. The
            // reason is recorded in the audit row: this value is written to
            // stdout, so it has left the system whether or not anyone read it.
            let secret = context.block_on(ops::reveal_secret(
                client,
                project,
                environment,
                key,
                RevealReason::Copy,
            ))?;

            if global.json {
                // The value is the answer to the question that was asked, so it
                // goes to stdout as the sole document. There is no version:
                // the reveal route returns the key and the plaintext.
                out.secret_json(&serde_json::json!({
                    "key": secret.key,
                    "value": secret.value.expose_secret(),
                }));
            } else {
                out.secret_data(secret.value.expose_secret());
            }
        }

        SecretsCommand::Set(args) => set(&context, project, environment, args, global, out)?,

        SecretsCommand::Remove { key, reason } => {
            remove(&context, project, environment, key, reason.as_deref(), global, out)?;
        }

        SecretsCommand::Download(args) => {
            let export = context.block_on(ops::export_secrets(client, project, environment))?;
            download(&export, args, global, out)?;
        }

        SecretsCommand::Upload(args) => {
            upload(&context, project, environment, args, global, out)?;
        }

        SecretsCommand::History { key } => {
            let versions =
                context.block_on(ops::secret_versions(client, project, environment, key))?;
            history(key, &versions, global, out);
        }

        SecretsCommand::Rollback { key, to, reason } => {
            // Collection-level, with the key in the body: there is no
            // `…/secrets/{key}:rollback`.
            let result = context.block_on(ops::rollback_secret(
                client,
                project,
                environment,
                key,
                *to,
                reason.as_deref(),
            ))?;

            if global.json {
                out.json(&serde_json::json!({
                    "key": key,
                    "restored_from": to,
                    "version": result.version,
                    "rev": result.rev,
                }));
            } else {
                out.data(&format!(
                    "Restored `{key}` from version {to} as version {} (rev {}).",
                    result.version, result.rev
                ));
            }
        }
    }

    Ok(())
}

/// Writes one secret.
///
/// A one-entry `:batch`, because that is the only write path there is: the
/// batch is one transaction with its audit row inside it, and a per-key route
/// would be a second write path without one.
fn set(
    context: &Context,
    project: &str,
    environment: &str,
    args: &SetArgs,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    let value = read_value(args, global, out)?;

    let result = context.block_on(ops::write_secrets(
        context.client(),
        project,
        environment,
        &BatchRequest {
            mode: WriteMode::Merge,
            set: vec![(args.key.as_str(), &value)],
            descriptions: descriptions_for(args.key.as_str(), args.description.as_deref()),
            reason: args.reason.as_deref(),
            ..BatchRequest::default()
        },
    ))?;

    // The diff says which it was, so the CLI does not have to guess or ask.
    let created = result.added.iter().any(|key| key == &args.key);

    if global.json {
        out.json(&serde_json::json!({
            "key": args.key,
            "rev": result.rev,
            "created": created,
        }));
    } else {
        let verb = if created { "Added" } else { "Updated" };
        out.data(&format!("{verb} `{}` (rev {}).", args.key, result.rev));
    }

    Ok(())
}

/// The `descriptions` entry a `set` should carry, if any.
///
/// An ABSENT key is what "leave the stored description alone" is spelled as; a
/// present one is an overwrite, and a present `null` is the clear. So a write
/// without `--description` must send no entry at all -- mapping the missing
/// flag onto `Some(key, None)` would wipe the description of every secret ever
/// set without it, silently, on the next ordinary rotation.
fn descriptions_for<'a>(
    key: &'a str,
    description: Option<&'a str>,
) -> Vec<(&'a str, Option<&'a str>)> {
    match description {
        Some(text) => vec![(key, Some(text))],
        None => Vec::new(),
    }
}

/// Deletes one secret.
///
/// A one-entry `delete` in a batch. The old versions stay in history as
/// tombstones, which is what makes delete-then-recreate continue the sequence.
///
/// The reason rides in the same batch `set` and `upload` put theirs in, and
/// lands on the same audit row the tombstone does. There is nothing special
/// about it here; it is only that this is the write that most needs one.
fn remove(
    context: &Context,
    project: &str,
    environment: &str,
    key: &str,
    reason: Option<&str>,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    if !confirm(global, out, &format!("Delete secret `{key}`"))? {
        return Err(CliError::Other("cancelled".to_owned()));
    }

    let result = context.block_on(ops::write_secrets(
        context.client(),
        project,
        environment,
        &BatchRequest { delete: vec![key], reason, ..BatchRequest::default() },
    ))?;

    if global.json {
        out.json(&serde_json::json!({ "deleted": key, "rev": result.rev }));
    } else {
        out.data(&format!("Deleted `{key}` (rev {}).", result.rev));
    }

    Ok(())
}

/// Replaces an environment's secrets from a file.
///
/// The file goes to the server **as a blob**, and the server parses it. That is
/// the shape `:import` takes, and it is the right one: one parser means this
/// command cannot reject a file the server would accept, or accept one it would
/// reject.
///
/// The whole document goes in one request, because a bulk write is one
/// transaction there: splitting it would destroy the atomicity that makes a
/// failed import leave the environment exactly as it was.
fn upload(
    context: &Context,
    project: &str,
    environment: &str,
    args: &UploadArgs,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    // Names the path and never the contents: this file is full of values.
    let document = std::fs::read_to_string(&args.file)
        .map_err(|err| CliError::Other(format!("could not read {}: {err}", args.file.display())))?;

    let result = context.block_on(ops::import_secrets(
        context.client(),
        project,
        environment,
        &ImportRequest {
            format: import_format(&args.file),
            content: &document,
            mode: if args.merge { WriteMode::Merge } else { WriteMode::Replace },
            dry_run: args.dry_run,
            expected_rev: args.expected_rev,
            reason: args.reason.as_deref(),
        },
    ))?;

    if global.json {
        out.json(&serde_json::json!({
            "applied": result.applied,
            "added": result.added,
            "changed": result.changed,
            "removed": result.removed,
            "warnings": result.warnings.iter().map(|warning| serde_json::json!({
                "line": warning.line,
                "key": warning.key,
                "message": warning.message,
            })).collect::<Vec<_>>(),
        }));
        return Ok(());
    }

    for warning in &result.warnings {
        out.warn(&format!("line {}: {} ({})", warning.line, warning.message, warning.key));
    }

    let summary = format!(
        "{} added, {} changed, {} removed",
        result.added.len(),
        result.changed.len(),
        result.removed.len()
    );
    if result.applied {
        out.data(&format!("{summary}."));
    } else {
        out.data(&format!("{summary} (dry run; nothing was written)."));
    }

    Ok(())
}

/// Which parser the server should use for an uploaded file.
///
/// By extension, because the alternative is sniffing the contents of a file of
/// secrets. `.json` is JSON; everything else is a `.env` document, which is
/// what an extensionless `.env` or a `production.env` is.
fn import_format(path: &Path) -> ImportFormat {
    let json = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));

    if json { ImportFormat::Json } else { ImportFormat::Env }
}

/// Prints a key's version history.
///
/// A tombstone is shown rather than skipped: "this key was deleted at version
/// 4" is the answer to half the questions this command is asked.
fn history(
    key: &str,
    versions: &[prick_api::models::SecretVersion],
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let rows: Vec<serde_json::Value> = versions
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "version": entry.version,
                    "op": entry.op,
                    "created_at": entry.created_at,
                    "created_by": entry.created_by,
                    "kid": entry.kid,
                    "deleted": entry.deleted,
                })
            })
            .collect();
        out.json(&serde_json::Value::Array(rows));
        return;
    }

    if versions.is_empty() {
        out.note(&format!("No history for `{key}`."));
        return;
    }

    for entry in versions {
        let marker = if entry.deleted { "\tDELETED" } else { "" };
        out.data(&format!("v{}\t{}\t{}{marker}", entry.version, entry.op, entry.created_by));
    }
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
                    "description": meta.description,
                    "version": meta.version,
                    "updated_at": meta.updated_at,
                    "updated_by": meta.updated_by,
                    "kid": meta.kid,
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
        out.data(&describe_secret(meta));
    }

    let unreadable = secrets.iter().filter(|meta| meta.unreadable).count();
    if unreadable > 0 {
        out.warn(&format!(
            "{unreadable} secret(s) could not be decrypted. This is a data-integrity failure, \
             not a display problem: do not deploy from this environment until it is resolved."
        ));
    }
}

/// One listing row.
///
/// Four tab-separated columns: key, current version, who wrote it last, and the
/// description. The fourth is here because `--description` describes itself as
/// "shown in a listing" -- before it, the flag stored a note that only `--json`
/// would ever show, which is a promise the help text was making and the output
/// was not keeping.
///
/// "none" rather than an empty column, for the same reason
/// [`crate::commands::projects`] prints it: a blank after a tab reads as a
/// rendering fault rather than as an absent description.
///
/// An unreadable row gets one too. A description is plaintext metadata stored
/// beside the key name -- what failed to decrypt is the value, and the note is
/// often the only thing left saying what the row was for.
///
/// A value rather than an `out.data` call, so a test can assert the shape of a
/// row without capturing a stream.
fn describe_secret(meta: &prick_api::models::SecretMeta) -> String {
    let author = if meta.unreadable { "UNREADABLE" } else { meta.updated_by.as_str() };
    format!(
        "{}\tv{}\t{author}\t{}",
        meta.key,
        meta.version,
        meta.description.as_deref().unwrap_or("none")
    )
}

/// Renders an export and writes it where it was asked to go.
fn download(
    export: &SecretExport,
    args: &DownloadArgs,
    global: &GlobalArgs,
    out: Output,
) -> Result<(), CliError> {
    // A BTreeMap, so the rendering is byte-identical for identical input and
    // `prk secrets download | diff` is meaningful.
    let values: BTreeMap<String, String> = export
        .entries()
        .map(|(key, value)| (key.to_owned(), value.expose_secret().to_owned()))
        .collect();

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
        // Secret-bearing, so a reader that hangs up part way through ends the
        // run loudly. A `.env` cut in half is the one export nobody can tell
        // from a whole one.
        None => out.secret_data_raw(&rendered),
    }

    Ok(())
}

/// Writes a file only its owner can read.
///
/// The mode is set at creation on Unix rather than afterwards, so there is no
/// window in which a file of secrets is world-readable. On Windows the DACL is
/// replaced with a single entry for the current user.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
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
    use clap::Parser as _;

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
        let args = SetArgs { key: "K".to_owned(), stdin: true, description: None, reason: None };
        let rendered = format!("{args:?}");
        assert!(rendered.contains('K'));
        assert_eq!(size_of_val(&args.stdin), 1);
    }

    #[test]
    fn a_set_without_the_flag_sends_no_description_entry_at_all() {
        // Not `[(K, None)]`. That is the CLEAR, and sending it for every write
        // would erase the description of every secret rotated without the flag.
        assert!(descriptions_for("K", None).is_empty());
        assert_eq!(descriptions_for("K", Some("live mode")), vec![("K", Some("live mode"))]);
    }

    #[test]
    fn a_listing_row_shows_the_description_the_set_flag_promised() {
        // `--description` says "shown in a listing". This is the listing.
        let row = describe_secret(&meta("DATABASE_URL", Some("Primary Postgres, read-write")));
        assert_eq!(row, "DATABASE_URL\tv4\tyou@example.com\tPrimary Postgres, read-write");
    }

    #[test]
    fn a_secret_without_a_description_says_none_rather_than_nothing() {
        // A blank fourth column reads as a rendering fault; `prk projects get`
        // prints "none" for the same reason.
        let row = describe_secret(&meta("API_KEY", None));
        assert_eq!(row, "API_KEY\tv4\tyou@example.com\tnone");
    }

    #[test]
    fn an_unreadable_row_keeps_its_description() {
        // The ciphertext is what failed. The description is plaintext metadata
        // stored beside the key, and it is often the only thing left that says
        // what the row was for.
        let mut broken = meta("STRIPE_SECRET_KEY", Some("Live mode, rotates quarterly"));
        broken.unreadable = true;
        let row = describe_secret(&broken);
        assert_eq!(row, "STRIPE_SECRET_KEY\tv4\tUNREADABLE\tLive mode, rotates quarterly");
    }

    /// A listing row as the server sends one.
    ///
    /// Built by deserialising the wire shape rather than by a struct literal,
    /// which `#[non_exhaustive]` rules out from here anyway -- and which means
    /// these tests also fail if the field a description arrives in is renamed.
    fn meta(key: &str, description: Option<&str>) -> prick_api::models::SecretMeta {
        serde_json::from_value(serde_json::json!({
            "key": key,
            "description": description,
            "version": 4,
            "updatedAt": 1_760_000_000_000_i64,
            "updatedBy": "you@example.com",
            "kid": "k1",
            "unreadable": false,
        }))
        .expect("a listing row as the server sends one")
    }

    #[test]
    fn an_upload_names_the_parser_by_extension() {
        assert_eq!(import_format(Path::new(".env")), ImportFormat::Env);
        assert_eq!(import_format(Path::new("production.env")), ImportFormat::Env);
        assert_eq!(import_format(Path::new("secrets")), ImportFormat::Env);
        assert_eq!(import_format(Path::new("secrets.json")), ImportFormat::Json);
        assert_eq!(import_format(Path::new("SECRETS.JSON")), ImportFormat::Json);
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
    fn a_delete_can_say_why() {
        // The one per-secret write that cannot be undone was also the one that
        // could not be annotated. `set` and `rollback` have taken --reason
        // since they existed; parsing the published argv is what proves this
        // one does too.
        let cli = crate::cli::Cli::try_parse_from([
            "prk",
            "secrets",
            "rm",
            "OLD_TOKEN",
            "--reason",
            "rotated out after the 2026-08-14 incident",
            "--project",
            "api",
            "--env",
            "production",
        ])
        .expect("the invocation printed in docs/reference/cli/secrets.md must parse");

        let crate::cli::Command::Secrets(SecretsCommand::Remove { key, reason }) = cli.command
        else {
            panic!("`secrets rm` did not parse as itself");
        };

        assert_eq!(key, "OLD_TOKEN");
        assert_eq!(reason.as_deref(), Some("rotated out after the 2026-08-14 incident"));
    }

    #[test]
    fn every_subcommand_reports_a_path() {
        for command in [
            SecretsCommand::List,
            SecretsCommand::Get { key: "K".to_owned() },
            SecretsCommand::Remove { key: "K".to_owned(), reason: None },
            SecretsCommand::History { key: "K".to_owned() },
            SecretsCommand::Rollback { key: "K".to_owned(), to: 1, reason: None },
        ] {
            assert!(command.path().starts_with("secrets "));
        }
    }
}
