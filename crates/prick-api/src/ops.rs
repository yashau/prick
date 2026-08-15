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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::credential::Credential;

    fn client() -> Client {
        Client::new(Config::new("https://prick.example.com"), Credential::Anonymous)
            .expect("building a client must succeed")
    }

    #[test]
    fn a_custom_method_hangs_off_the_collection_not_off_a_key() {
        let client = client();
        assert_eq!(
            custom_method(&client, "billing", "eu-west", ":rollback"),
            "https://prick.example.com/api/v1/projects/billing/environments/eu-west/secrets:rollback"
        );
        assert_eq!(
            custom_method(&client, "billing", "eu-west", ":export"),
            "https://prick.example.com/api/v1/projects/billing/environments/eu-west/secrets:export"
        );
    }

    #[test]
    fn a_uuid_is_the_only_thing_between_identities_and_effective_permissions() {
        // Not `/access/identities/...`, and not a query parameter: the id is a
        // path segment, and the route hangs off `/identities`.
        // `crates/prick-api/tests/contract.rs` checks this shape against
        // `docs/openapi.json`; this pins the spelling the code emits, so a
        // failure says which of the two moved.
        assert_eq!(
            effective_permissions_url(&client(), "abc"),
            "https://prick.example.com/api/v1/identities/abc/effective-permissions"
        );
    }

    #[test]
    fn a_batch_body_carries_a_map_of_set_keys_and_an_array_of_deletes() {
        let value = SecretString::from("postgres://u:p@h/db");
        let body = batch_body(&BatchRequest {
            mode: WriteMode::Merge,
            set: vec![("DATABASE_URL", &value)],
            descriptions: vec![("DATABASE_URL", Some("Primary, rotates quarterly"))],
            delete: vec!["OLD_KEY"],
            expected_rev: Some(4),
            reason: Some("rotation"),
        });

        assert_eq!(body["mode"], "merge");
        assert_eq!(body["set"]["DATABASE_URL"], "postgres://u:p@h/db");
        assert_eq!(body["descriptions"]["DATABASE_URL"], "Primary, rotates quarterly");
        assert_eq!(body["delete"], serde_json::json!(["OLD_KEY"]));
        // `expectedRev` would be accepted by no schema in this API and would
        // leave the write with no concurrency guard at all.
        assert_eq!(body["expected_rev"], 4);
        assert_eq!(body["reason"], "rotation");
    }

    #[test]
    fn a_description_is_omitted_when_unset_and_null_when_cleared() {
        let value = SecretString::from("x");

        // Omitted. The server coalesces, so the stored description survives a
        // write that says nothing about it -- which is what every `prk secrets
        // set` without `--description` must do.
        let silent =
            batch_body(&BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() });
        assert!(silent.get("descriptions").is_none(), "an empty list is not an empty object");

        // Present and `null`. The server overwrites, so this clears it.
        let cleared = batch_body(&BatchRequest {
            set: vec![("K", &value)],
            descriptions: vec![("K", None)],
            ..BatchRequest::default()
        });
        assert_eq!(cleared["descriptions"]["K"], serde_json::Value::Null);
        assert!(
            cleared["descriptions"].as_object().is_some_and(|map| map.contains_key("K")),
            "a cleared description is a present null, not an absent key"
        );
    }

    #[test]
    fn an_absent_guard_or_reason_is_omitted_rather_than_sent_as_null() {
        let value = SecretString::from("x");
        let body =
            batch_body(&BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() });

        assert!(body.get("expected_rev").is_none());
        assert!(body.get("reason").is_none());
        assert!(body.get("delete").is_none(), "an empty delete list is not the same as none");
        assert_eq!(body["mode"], "merge", "the default mode is the non-destructive one");
    }

    #[test]
    fn a_batch_request_never_prints_a_value_through_debug() {
        let value = SecretString::from("hunter2");
        let request = BatchRequest { set: vec![("K", &value)], ..BatchRequest::default() };

        let rendered = format!("{request:?}");
        assert!(!rendered.contains("hunter2"), "a value leaked through Debug: {rendered}");
        assert!(rendered.contains('K'), "the key is plaintext and should still be visible");
    }

    #[test]
    fn an_import_body_is_a_blob_rather_than_a_parsed_array() {
        let body = import_body(&ImportRequest {
            format: ImportFormat::Env,
            content: "A=1\nB=2\n",
            mode: WriteMode::Replace,
            dry_run: true,
            expected_rev: Some(7),
            reason: None,
        });

        assert_eq!(body["format"], "env");
        assert_eq!(body["content"], "A=1\nB=2\n");
        assert_eq!(body["mode"], "replace");
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["expected_rev"], 7);
        assert!(body.get("secrets").is_none(), "the server owns the parser");
    }

    #[test]
    fn an_import_request_never_prints_the_blob_through_debug() {
        let request = ImportRequest {
            format: ImportFormat::Env,
            content: "DATABASE_URL=hunter2\n",
            mode: WriteMode::Replace,
            dry_run: false,
            expected_rev: None,
            reason: None,
        };

        let rendered = format!("{request:?}");
        assert!(!rendered.contains("hunter2"), "a blob leaked through Debug: {rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn a_grant_body_is_discriminated_on_scope_type() {
        let global = grant_body("id-1", "admin", GrantScope::Global, None);
        assert_eq!(global["scope_type"], "global");
        assert!(global.get("project").is_none(), "a global grant names no project");
        assert!(global.get("expires_at").is_none());

        let project =
            grant_body("id-1", "writer", GrantScope::Project { project: "billing" }, None);
        assert_eq!(project["scope_type"], "project");
        assert_eq!(project["project"], "billing");
        assert!(project.get("environment").is_none());

        let environment = grant_body(
            "id-1",
            "reader",
            GrantScope::Environment { project: "billing", environment: "eu-west" },
            Some(1_760_000_000_000),
        );
        assert_eq!(environment["scope_type"], "environment");
        assert_eq!(environment["environment"], "eu-west");
        assert_eq!(environment["expires_at"], 1_760_000_000_000_i64);
        // Never `subject`, and never a `scope` string: neither exists.
        assert!(environment.get("subject").is_none());
        assert!(environment.get("scope").is_none());
        assert_eq!(environment["identity_id"], "id-1");
    }

    #[test]
    fn the_cli_scope_spelling_maps_onto_the_unions_three_arms() {
        let global: Scope = "*:*".parse().expect("a global scope");
        assert_eq!(GrantScope::from_scope(&global).expect("global"), GrantScope::Global);

        let project: Scope = "billing:*".parse().expect("a project scope");
        assert_eq!(
            GrantScope::from_scope(&project).expect("project"),
            GrantScope::Project { project: "billing" }
        );

        let environment: Scope = "billing:eu-west".parse().expect("an environment scope");
        assert_eq!(
            GrantScope::from_scope(&environment).expect("environment"),
            GrantScope::Environment { project: "billing", environment: "eu-west" }
        );
    }

    #[test]
    fn an_environment_without_a_project_is_refused_rather_than_widened() {
        let scope: Scope = "*:production".parse().expect("parses as a scope");
        let err = GrantScope::from_scope(&scope).expect_err("there is no such grant scope");
        assert_eq!(err.kind(), ErrorKind::Validation);
        assert!(err.to_string().contains("production"), "{err}");
    }

    #[test]
    fn the_wire_spellings_are_the_ones_the_schemas_accept() {
        assert_eq!(WriteMode::default().as_str(), "merge");
        assert_eq!(WriteMode::Replace.as_str(), "replace");
        assert_eq!(ImportFormat::default().as_str(), "env");
        assert_eq!(ImportFormat::Json.as_str(), "json");
        for reason in
            [RevealReason::Reveal, RevealReason::Copy, RevealReason::Export, RevealReason::Run]
        {
            assert!(reason.as_str().chars().all(|c| c.is_ascii_lowercase()));
        }
    }
}
