//! Every route this client knows, as one typed function each.
//!
//! # Why these are here rather than in the commands
//!
//! A route is a fact about the server, not about the terminal. Keeping the
//! path, the method and the request body in `prick-api` means a wiremock test
//! can assert all three against the shapes in `docs/openapi.json` -- and a
//! command that formats a table cannot quietly disagree with a command that
//! writes a file about where `:batch` lives.
//!
//! # The shapes that are easy to guess wrong
//!
//! These are not stylistic choices; each one is a route that answers 422 or 404
//! to the obvious alternative.
//!
//! - **There is no `PUT`/`DELETE` on a single key.** One key is written through
//!   `POST …/secrets:batch` with a one-entry `set`, and deleted through the
//!   same route with a one-entry `delete`. The batch is one D1 transaction with
//!   its audit row inside it; a per-key route would be a second write path with
//!   no transaction around it.
//! - **A description travels with its value.** `descriptions` is a sibling of
//!   `set` on `:batch`, and every key in it must also be in `set`. There is no
//!   metadata-only update, and no separate route for one.
//! - **`:rollback` is collection-level**: `POST …/secrets:rollback` with
//!   `{key, to_version}`, not a suffix on the key's own path.
//! - **`:import` takes a blob**, not a parsed array: `{format, content, …}`.
//!   The server owns the parser, so the CLI cannot accept a file the server
//!   would reject, or vice versa.
//! - **`:export` answers with a flat `{KEY: value}` map.**
//! - **Reveal answers `{key, value}`** and carries no version.
//! - **Identities are at `/identities`**, not under `/access`. The one route
//!   that *is* under `/access` is `unknown-identities`.
//! - **Grants are created with a discriminated union on `scope_type`** and
//!   revoked by their own uuid -- never by subject and scope.
//!
//! # Request bodies are `snake_case`
//!
//! Every request schema in `@prick/shared` is `.strict()`, so `expectedRev`
//! instead of `expected_rev` is a 422 rather than a write with the concurrency
//! guard silently dropped. Response schemas are `camelCase`; see
//! [`crate::models`].

use std::fmt;

use secrecy::{ExposeSecret as _, SecretString};

use prick_core::classify::ErrorKind;
use prick_core::scope::{Scope, WILDCARD};

use crate::client::Client;
use crate::error::ApiError;
use crate::models::{
    Environment, Grant, Health, Identity, ImportResult, Project, RollbackResult, SecretExport,
    SecretMeta, SecretValue, SecretVersion, UnknownIdentity, Whoami, WriteResult,
};

/// What a bulk write does to keys it does not name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WriteMode {
    /// Leave them alone.
    #[default]
    Merge,
    /// Delete them. This is `prk secrets upload`, and it is why `expected_rev`
    /// exists.
    Replace,
}

impl WriteMode {
    /// The spelling the API accepts.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Replace => "replace",
        }
    }
}

/// How the server should parse an imported blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImportFormat {
    /// A `.env` document.
    #[default]
    Env,
    /// A flat JSON object of key to value.
    Json,
}

impl ImportFormat {
    /// The spelling the API accepts.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Json => "json",
        }
    }
}

/// Why a value was revealed, recorded verbatim in the audit row.
///
/// This is what makes the log answer "did anyone take this" rather than merely
/// "did anyone look at it".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RevealReason {
    /// Displayed and not retained -- the admin UI's eye toggle.
    #[default]
    Reveal,
    /// Taken. `prk secrets get` writes the plaintext to stdout, so the value
    /// has left the system whether or not a human read it.
    Copy,
    /// Part of a whole-environment export.
    Export,
    /// Injected into a child process by `prk run`.
    Run,
}

impl RevealReason {
    /// The spelling the API accepts.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reveal => "reveal",
            Self::Copy => "copy",
            Self::Export => "export",
            Self::Run => "run",
        }
    }
}

/// Where a grant applies.
///
/// A discriminated union rather than three optional fields, mirroring
/// `CreateGrantBody`: a flat object would accept
/// `{scope_type: "global", project: "prod"}` and have to decide at runtime what
/// that meant, which is the ambiguity that produces an over-broad grant nobody
/// notices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantScope<'a> {
    /// Everything, everywhere.
    Global,
    /// One project and every environment in it.
    Project {
        /// The project slug.
        project: &'a str,
    },
    /// One environment.
    Environment {
        /// The project slug.
        project: &'a str,
        /// The environment slug.
        environment: &'a str,
    },
}

impl<'a> GrantScope<'a> {
    /// Maps the CLI's `project:environment` spelling onto the API's union.
    ///
    /// # Errors
    ///
    /// [`ErrorKind::Validation`] for `*:something`. A grant on an environment
    /// whose project is a wildcard is not a scope the server has -- and
    /// silently widening it to global, or narrowing it to nothing, are both
    /// worse than refusing.
    pub fn from_scope(scope: &'a Scope) -> Result<Self, ApiError> {
        match (scope.is_project_wildcard(), scope.is_environment_wildcard()) {
            (true, true) => Ok(Self::Global),
            (false, true) => Ok(Self::Project { project: scope.project() }),
            (false, false) => {
                Ok(Self::Environment { project: scope.project(), environment: scope.environment() })
            }
            (true, false) => Err(ApiError::new(
                ErrorKind::Validation,
                format!(
                    "`{WILDCARD}:{}` is not a grantable scope: an environment can only be named \
                     inside a project",
                    scope.environment()
                ),
            )),
        }
    }

    /// The `scope_type` discriminator.
    fn scope_type(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project { .. } => "project",
            Self::Environment { .. } => "environment",
        }
    }
}

/// One atomic mutation of an environment's secrets.
///
/// `Debug` is written by hand: a derived one would print every value in `set`.
/// Keys are plaintext metadata and are shown; values are counted.
#[derive(Default)]
pub struct BatchRequest<'a> {
    /// What happens to keys named in neither `set` nor `delete`.
    pub mode: WriteMode,
    /// Keys to write. A key that appears here **and** in `delete` is a 422:
    /// one order stores the value and the other tombstones it, and the request
    /// does not say which was meant.
    pub set: Vec<(&'a str, &'a SecretString)>,
    /// Free-text descriptions, by key. **Every key here must also be in
    /// `set`** -- a description for a key this batch does not write is a 422,
    /// because a metadata-only update is not something this route performs.
    ///
    /// `None` is the CLEAR: it is sent as a JSON `null`, which overwrites the
    /// stored description. A key left out of this list keeps whatever
    /// description it already had.
    ///
    /// Not a `SecretString`: a description is written to be read in a listing,
    /// alongside the key name, and both are stored in plaintext.
    pub descriptions: Vec<(&'a str, Option<&'a str>)>,
    /// Keys to remove.
    pub delete: Vec<&'a str>,
    /// Optimistic guard. Omit to write unconditionally.
    pub expected_rev: Option<u64>,
    /// Recorded verbatim in the audit row. Never contains a secret value.
    pub reason: Option<&'a str>,
}

impl fmt::Debug for BatchRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BatchRequest")
            .field("mode", &self.mode)
            .field("set", &self.set.iter().map(|(key, _)| *key).collect::<Vec<_>>())
            // Shown in full. A description is plaintext metadata written to be
            // read in a listing; redacting it here would hide the one field in
            // this struct a `--verbose` reader might need to see.
            .field("descriptions", &self.descriptions)
            .field("delete", &self.delete)
            .field("expected_rev", &self.expected_rev)
            .field("reason", &self.reason)
            .finish()
    }
}

/// A `.env` or JSON blob to import.
///
/// `Debug` is written by hand for the same reason as [`BatchRequest`]: the blob
/// is a file full of plaintext values.
pub struct ImportRequest<'a> {
    /// How to parse `content`.
    pub format: ImportFormat,
    /// The raw file contents.
    pub content: &'a str,
    /// What happens to keys the blob does not name.
    pub mode: WriteMode,
    /// Parse, validate and diff without writing.
    pub dry_run: bool,
    /// Optimistic guard.
    pub expected_rev: Option<u64>,
    /// Recorded verbatim in the audit row.
    pub reason: Option<&'a str>,
}

impl fmt::Debug for ImportRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportRequest")
            .field("format", &self.format)
            .field("content", &format_args!("<{} bytes, redacted>", self.content.len()))
            .field("mode", &self.mode)
            .field("dry_run", &self.dry_run)
            .field("expected_rev", &self.expected_rev)
            .field("reason", &self.reason)
            .finish()
    }
}

/// What a patch does to an identity's nullable display name.
///
/// Three states rather than an `Option`, because the field is nullable and the
/// wire has three answers for it: absent, a string, and `null`. An
/// `Option<&str>` would have to pick two of the three, and whichever pair it
/// picked, the missing one would be spelled as one of the others -- which is
/// how a request meant to clear a label instead leaves it in place, or how a
/// request meant to leave it alone erases it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DisplayNameChange<'a> {
    /// Leave the stored name alone. **Omitted** from the body.
    #[default]
    Keep,
    /// Replace it.
    Set(
        /// The new label. The server caps it at 128 characters and refuses an
        /// empty one.
        &'a str,
    ),
    /// Remove it. Sent as a present JSON `null`, which is what the server reads
    /// as the clear; an absent key means "leave it alone" and `""` is a 422.
    Clear,
}

/// The fields `PATCH /identities/{id}` is being asked to change.
///
/// Every field is a "say nothing" by default, and that default is the point.
/// The body is built from exactly what was set, so a command that only renames
/// an identity sends no `disabled` at all -- rather than sending
/// `disabled: false` because a `bool` field defaulted, which would silently
/// re-enable an identity somebody had killed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IdentityUpdate<'a> {
    /// The label an access list is read by. See [`DisplayNameChange`].
    pub display_name: DisplayNameChange<'a>,
    /// The kill switch. `None` leaves it exactly as it is.
    pub disabled: Option<bool>,
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/// `GET /health`.
///
/// # Errors
///
/// See [`Client::health`].
pub async fn health(client: &Client) -> Result<Health, ApiError> {
    client.health().await
}

/// `GET /whoami`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn whoami(client: &Client) -> Result<Whoami, ApiError> {
    client.get_json(&client.url(&["whoami"])).await
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/// `GET /projects`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_projects(client: &Client) -> Result<Vec<Project>, ApiError> {
    client.get_json(&client.url(&["projects"])).await
}

/// `POST /projects`.
///
/// **`slug` is required.** It is how every other route addresses the project,
/// so the server will not invent one.
///
/// # Errors
///
/// Any transport or response failure, including `409` when the slug is taken.
pub async fn create_project(
    client: &Client,
    slug: &str,
    name: &str,
    description: Option<&str>,
) -> Result<Project, ApiError> {
    let mut body = serde_json::json!({ "slug": slug, "name": name });
    if let Some(description) = description {
        body["description"] = serde_json::Value::String(description.to_owned());
    }
    client.post_json(&client.url(&["projects"]), &body).await
}

/// `GET /projects/{project}`.
///
/// One project by slug, rather than [`list_projects`] filtered down to one. The
/// difference is visible to the caller: a project that does not exist and one
/// the caller has no grant for produce the identical `404`, down to the hint,
/// so a client cannot infer the existence of a project it may not see -- which
/// is precisely what "it was not in the list" would tell it.
///
/// # Errors
///
/// Any transport or response failure, including `404`.
pub async fn get_project(client: &Client, project: &str) -> Result<Project, ApiError> {
    client.get_json(&client.url(&["projects", project])).await
}

/// `PATCH /projects/{project}`.
///
/// The slug is deliberately not patchable: it is the identifier other people
/// have written down.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn update_project(
    client: &Client,
    project: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> Result<Project, ApiError> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".to_owned(), serde_json::Value::String(name.to_owned()));
    }
    if let Some(description) = description {
        body.insert("description".to_owned(), serde_json::Value::String(description.to_owned()));
    }
    client.patch_json(&client.url(&["projects", project]), &serde_json::Value::Object(body)).await
}

/// `DELETE /projects/{project}`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn delete_project(client: &Client, project: &str) -> Result<(), ApiError> {
    client.delete(&client.url(&["projects", project])).await
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/// `GET /projects/{project}/environments`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_environments(
    client: &Client,
    project: &str,
) -> Result<Vec<Environment>, ApiError> {
    client.get_json(&client.url(&["projects", project, "environments"])).await
}

/// `GET /projects/{project}/environments/{env}`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn get_environment(
    client: &Client,
    project: &str,
    environment: &str,
) -> Result<Environment, ApiError> {
    client.get_json(&client.url(&["projects", project, "environments", environment])).await
}

/// `POST /projects/{project}/environments`.
///
/// **Both `slug` and `name` are required.**
///
/// # Errors
///
/// Any transport or response failure, including `409` when the slug is taken
/// within the project.
pub async fn create_environment(
    client: &Client,
    project: &str,
    slug: &str,
    name: &str,
    description: Option<&str>,
) -> Result<Environment, ApiError> {
    let mut body = serde_json::json!({ "slug": slug, "name": name });
    if let Some(description) = description {
        body["description"] = serde_json::Value::String(description.to_owned());
    }
    client.post_json(&client.url(&["projects", project, "environments"]), &body).await
}

/// `DELETE /projects/{project}/environments/{env}`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn delete_environment(
    client: &Client,
    project: &str,
    environment: &str,
) -> Result<(), ApiError> {
    client.delete(&client.url(&["projects", project, "environments", environment])).await
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/// The URL of an environment's secret collection.
fn secrets_url(client: &Client, project: &str, environment: &str) -> String {
    client.url(&["projects", project, "environments", environment, "secrets"])
}

/// The collection URL, with a custom-method suffix such as `:batch` appended.
///
/// The suffix is a literal from this module and never user input, so appending
/// it after the encoder has run cannot smuggle a segment. A slug cannot contain
/// a colon, so `…/secrets:batch` has exactly one parse.
fn custom_method(client: &Client, project: &str, environment: &str, method: &str) -> String {
    let mut url = secrets_url(client, project, environment);
    url.push_str(method);
    url
}

/// `GET …/secrets`. Metadata only; no values, ever.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_secrets(
    client: &Client,
    project: &str,
    environment: &str,
) -> Result<Vec<SecretMeta>, ApiError> {
    client.get_json(&secrets_url(client, project, environment)).await
}

/// `GET …/secrets/{key}?reason=…`. One value.
///
/// # Errors
///
/// Any transport or response failure. A decrypt failure is a `500`, never an
/// omitted key or an empty string.
pub async fn reveal_secret(
    client: &Client,
    project: &str,
    environment: &str,
    key: &str,
    reason: RevealReason,
) -> Result<SecretValue, ApiError> {
    let url = client.config().url_with_query(
        &["projects", project, "environments", environment, "secrets", key],
        &[("reason", reason.as_str())],
    );
    client.get_json(&url).await
}

/// `GET …/secrets:export`. Every value, as a flat map.
///
/// # Errors
///
/// Any transport or response failure. A single unreadable row fails the whole
/// export rather than producing a file that is silently one variable short.
pub async fn export_secrets(
    client: &Client,
    project: &str,
    environment: &str,
) -> Result<SecretExport, ApiError> {
    client.get_json(&custom_method(client, project, environment, ":export")).await
}

/// `GET …/secrets/{key}/versions`. Newest first, tombstones included.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn secret_versions(
    client: &Client,
    project: &str,
    environment: &str,
    key: &str,
) -> Result<Vec<SecretVersion>, ApiError> {
    let url =
        client.url(&["projects", project, "environments", environment, "secrets", key, "versions"]);
    client.get_json(&url).await
}

/// `POST …/secrets:batch`. The only write path for a secret's value.
///
/// # Errors
///
/// Any transport or response failure -- notably `409` when another writer took
/// the same version twice, `412` when `expected_rev` did not match, and `413`
/// when the write would exceed the per-environment cap.
pub async fn write_secrets(
    client: &Client,
    project: &str,
    environment: &str,
    request: &BatchRequest<'_>,
) -> Result<WriteResult, ApiError> {
    let url = custom_method(client, project, environment, ":batch");
    client.post_json(&url, &batch_body(request)).await
}

/// Builds the `:batch` body.
///
/// Split out so its shape is asserted by a unit test rather than only by a
/// mocked round trip. This is the one place in the client where a plaintext
/// value is exposed, and it is exposed directly into the request body.
fn batch_body(request: &BatchRequest<'_>) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert("mode".to_owned(), serde_json::Value::String(request.mode.as_str().to_owned()));

    if !request.set.is_empty() {
        let mut set = serde_json::Map::with_capacity(request.set.len());
        for (key, value) in &request.set {
            set.insert(
                (*key).to_owned(),
                serde_json::Value::String(value.expose_secret().to_owned()),
            );
        }
        body.insert("set".to_owned(), serde_json::Value::Object(set));
    }

    if !request.descriptions.is_empty() {
        let mut descriptions = serde_json::Map::with_capacity(request.descriptions.len());
        for (key, description) in &request.descriptions {
            // `null` rather than an omitted entry, and rather than `""`. The
            // server reads a present `null` as "clear this description"; an
            // absent key means "leave it alone", and an empty string would be a
            // description that renders as a blank line in a listing.
            descriptions.insert(
                (*key).to_owned(),
                description.map_or(serde_json::Value::Null, |text| {
                    serde_json::Value::String(text.to_owned())
                }),
            );
        }
        body.insert("descriptions".to_owned(), serde_json::Value::Object(descriptions));
    }

    if !request.delete.is_empty() {
        body.insert(
            "delete".to_owned(),
            serde_json::Value::Array(
                request
                    .delete
                    .iter()
                    .map(|key| serde_json::Value::String((*key).to_owned()))
                    .collect(),
            ),
        );
    }

    if let Some(rev) = request.expected_rev {
        body.insert("expected_rev".to_owned(), serde_json::Value::from(rev));
    }
    if let Some(reason) = request.reason {
        body.insert("reason".to_owned(), serde_json::Value::String(reason.to_owned()));
    }

    serde_json::Value::Object(body)
}

/// `POST …/secrets:import`. A blob, parsed by the server.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn import_secrets(
    client: &Client,
    project: &str,
    environment: &str,
    request: &ImportRequest<'_>,
) -> Result<ImportResult, ApiError> {
    let url = custom_method(client, project, environment, ":import");
    client.post_json(&url, &import_body(request)).await
}

/// Builds the `:import` body.
fn import_body(request: &ImportRequest<'_>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "format": request.format.as_str(),
        "content": request.content,
        "mode": request.mode.as_str(),
        "dry_run": request.dry_run,
    });
    if let Some(rev) = request.expected_rev {
        body["expected_rev"] = serde_json::Value::from(rev);
    }
    if let Some(reason) = request.reason {
        body["reason"] = serde_json::Value::String(reason.to_owned());
    }
    body
}

/// `POST …/secrets:rollback`. Collection-level, with the key in the body.
///
/// # Errors
///
/// Any transport or response failure. Rolling back to a tombstone is a `422`:
/// that version recorded a deletion and carries no value.
pub async fn rollback_secret(
    client: &Client,
    project: &str,
    environment: &str,
    key: &str,
    to_version: u32,
    reason: Option<&str>,
) -> Result<RollbackResult, ApiError> {
    let url = custom_method(client, project, environment, ":rollback");
    let mut body = serde_json::json!({ "key": key, "to_version": to_version });
    if let Some(reason) = reason {
        body["reason"] = serde_json::Value::String(reason.to_owned());
    }
    client.post_json(&url, &body).await
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/// `GET /identities`.
///
/// Not `/access/identities`: the only route under `/access` is
/// `unknown-identities`.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_identities(client: &Client) -> Result<Vec<Identity>, ApiError> {
    client.get_json(&client.url(&["identities"])).await
}

/// `PATCH /identities/{id}`. Rename an identity, or throw the kill switch.
///
/// Takes an **identity id**, not a subject, the same as [`create_grant`], and
/// resolvable the same way through [`list_identities`].
///
/// Requires **global** admin, which is stricter than every other access route
/// here: `disabled` outranks every grant at every scope, `BOOTSTRAP_ADMINS`
/// included, so a project administrator flipping it would be revoking access to
/// projects they have nothing to do with.
///
/// The body carries only the fields [`IdentityUpdate`] names. That is a
/// property worth stating rather than assuming: this is a `PATCH`, so a field
/// the body does not carry keeps its stored value, and a `disabled: false` sent
/// because a flag defaulted would re-enable an identity that was killed on
/// purpose.
///
/// # Errors
///
/// Any transport or response failure, including `403` when the caller is an
/// administrator of something narrower than everything, and `404` when no
/// identity has that id.
pub async fn update_identity(
    client: &Client,
    identity_id: &str,
    update: &IdentityUpdate<'_>,
) -> Result<Identity, ApiError> {
    let url = client.url(&["identities", identity_id]);
    client.patch_json(&url, &identity_body(update)).await
}

/// Builds the `PATCH /identities/{id}` body.
///
/// Split out so its shape is asserted by a unit test rather than only by a
/// mocked round trip: the difference between an absent `display_name` and a
/// present `null` one is invisible in a passing request and decides whether a
/// label survives.
fn identity_body(update: &IdentityUpdate<'_>) -> serde_json::Value {
    let mut body = serde_json::Map::new();

    match update.display_name {
        // Not `Value::Null`, and not an empty string: an absent key is the only
        // spelling the server reads as "leave the stored name alone".
        DisplayNameChange::Keep => {}
        DisplayNameChange::Set(name) => {
            body.insert("display_name".to_owned(), serde_json::Value::String(name.to_owned()));
        }
        DisplayNameChange::Clear => {
            body.insert("display_name".to_owned(), serde_json::Value::Null);
        }
    }

    if let Some(disabled) = update.disabled {
        body.insert("disabled".to_owned(), serde_json::Value::Bool(disabled));
    }

    serde_json::Value::Object(body)
}

/// The URL of one identity's effective permissions.
fn effective_permissions_url(client: &Client, identity_id: &str) -> String {
    client.url(&["identities", identity_id, "effective-permissions"])
}

/// `GET /identities/{id}/effective-permissions`. Every role an identity holds,
/// and for each one the rows that confer it.
///
/// Takes an **identity id**, not a subject, the same as [`create_grant`], and
/// resolvable the same way through [`list_identities`].
///
/// The one op here that answers a [`serde_json::Value`] rather than a model,
/// which is a decision about where a malformed answer is refused rather than a
/// gap. The document is a provenance graph -- scopes carrying sources carrying
/// groups, with exactly one source flagged `decisive` -- and its only reader
/// refuses an absent `scopes` with a sentence saying that an absent `scopes`
/// renders as "no access anywhere", which is the one wrong answer this route
/// must never produce. A `Deserialize` mirror here would replace that with
/// "the server returned JSON that does not match what this client expects",
/// followed by a line and a column -- trading the name of the missing field,
/// and the reason its absence is dangerous, for an offset into a body this
/// crate deliberately never prints. The route is the fact this module exists
/// to hold; reading the document is the caller's.
///
/// # Errors
///
/// Any transport or response failure, including `404` when no identity has
/// that id.
pub async fn explain_identity_permissions(
    client: &Client,
    identity_id: &str,
) -> Result<serde_json::Value, ApiError> {
    client.get_json(&effective_permissions_url(client, identity_id)).await
}

/// `GET /access/unknown-identities`. Subjects seen, denied, and never granted.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_unknown_identities(client: &Client) -> Result<Vec<UnknownIdentity>, ApiError> {
    client.get_json(&client.url(&["access", "unknown-identities"])).await
}

/// `GET /grants`. Live grants only -- an expired grant is not a grant.
///
/// # Errors
///
/// Any transport or response failure.
pub async fn list_grants(client: &Client) -> Result<Vec<Grant>, ApiError> {
    client.get_json(&client.url(&["grants"])).await
}

/// `POST /grants`.
///
/// Takes an **identity id**, not a subject. Resolve one with
/// [`list_identities`]; the "seen but not granted" list exists precisely so a
/// denied service token can be turned into a grant without copying opaque
/// identifiers between two consoles.
///
/// # Errors
///
/// Any transport or response failure, including `409` when that identity
/// already holds a grant at this scope -- a duplicate is a conflict rather than
/// an upsert, because silently upgrading a reader to an admin is the change
/// nobody would notice.
pub async fn create_grant(
    client: &Client,
    identity_id: &str,
    role: &str,
    scope: GrantScope<'_>,
    expires_at: Option<i64>,
) -> Result<Grant, ApiError> {
    let body = grant_body(identity_id, role, scope, expires_at);
    client.post_json(&client.url(&["grants"]), &body).await
}

/// Builds the `POST /grants` body.
fn grant_body(
    identity_id: &str,
    role: &str,
    scope: GrantScope<'_>,
    expires_at: Option<i64>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "scope_type": scope.scope_type(),
        "identity_id": identity_id,
        "role": role,
    });

    match scope {
        GrantScope::Global => {}
        GrantScope::Project { project } => {
            body["project"] = serde_json::Value::String(project.to_owned());
        }
        GrantScope::Environment { project, environment } => {
            body["project"] = serde_json::Value::String(project.to_owned());
            body["environment"] = serde_json::Value::String(environment.to_owned());
        }
    }

    if let Some(expires_at) = expires_at {
        body["expires_at"] = serde_json::Value::from(expires_at);
    }

    body
}

/// `DELETE /grants/{id}`. By the grant's own uuid, never by subject and scope.
///
/// # Errors
///
/// Any transport or response failure, including `409` when this is the last
/// usable global administrator and `BOOTSTRAP_ADMINS` is empty.
pub async fn revoke_grant(client: &Client, grant_id: &str) -> Result<(), ApiError> {
    client.delete(&client.url(&["grants", grant_id])).await
}

// In `ops/tests.rs`, not in a block here. `lint:loc` caps a source file at 1000
// lines, and every `pub async fn` has to stay in *this* file because
// `tests/contract.rs` discovers routes by reading it with `include_str!`. So
// the declarations stay and the tests move; see that file's own header.
#[cfg(test)]
mod tests;
