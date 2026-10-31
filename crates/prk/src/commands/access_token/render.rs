//! What `prk access token` prints.
//!
//! stdout carries the answer: the client id and secret, a listing, a result.
//! Everything about it -- which deployment, what the grant is, that a secret is
//! shown once -- is a note on stderr, so `CLIENT_ID=$(prk access token create
//! ci --secret-file ci.secret)` captures the client id and nothing else.
//!
//! Every `--json` document is an object naming `server` and `instance`, because
//! a token is valid for one deployment only.

use secrecy::ExposeSecret as _;

use prick_api::models::{
    IssuedServiceToken, ReconcileEntry, ReconcileResult, RotatedServiceToken, ServiceToken,
    ServiceTokenList,
};

use super::{Deployment, PreparedGrant, SecretSink};
use crate::cli::GlobalArgs;
use crate::commands::access::grant_json;
use crate::output::Output;

/// Milliseconds in a day.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// How close an expiry is before a listing flags it.
pub(crate) const EXPIRY_WARNING_DAYS: i64 = 30;

/// Reports a newly created token. The secret has already gone to a file or to
/// stdout unless the sink is [`SecretSink::Show`], in which case it is printed
/// here.
pub(super) fn created(
    issued: &IssuedServiceToken,
    grant: Option<&PreparedGrant>,
    deployment: &Deployment,
    sink: &SecretSink,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let mut document = base(deployment);
        document["token"] = token_json(&issued.token, super::now_ms());
        document["client_id"] = issued.client_id.clone().into();
        document["grant"] = issued.grant.as_ref().map_or(serde_json::Value::Null, grant_json);
        emit_with_secret(document, &issued.client_secret, sink, out);
        return;
    }

    out.note(&format!(
        "Created service token `{}` on {}. It authenticates to this deployment only.",
        issued.token.label(),
        deployment.label()
    ));
    match grant {
        Some(grant) => {
            let expiry = grant
                .expires_at
                .map(|at| format!(", expiring {}", timestamp(at)))
                .unwrap_or_default();
            out.note(&format!("Granted {} on `{}`{expiry}.", grant.role.as_str(), grant.scope));
        }
        None => out.note(&format!(
            "It holds no grant. Give it one with `prk access grant {} --role <ROLE> --scope \
             <PROJECT>:<ENVIRONMENT>`.",
            issued.client_id
        )),
    }
    show_secret(&issued.client_id, &issued.client_secret, sink, out);
}

/// Reports a rotation.
pub(super) fn rotated(
    rotated: &RotatedServiceToken,
    deployment: &Deployment,
    sink: &SecretSink,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let mut document = base(deployment);
        document["token"] = token_json(&rotated.token, super::now_ms());
        document["client_id"] = rotated.client_id.clone().into();
        document["previous_secret_expires_at"] = rotated.previous_secret_expires_at.into();
        emit_with_secret(document, &rotated.client_secret, sink, out);
        return;
    }

    out.note(&format!(
        "Rotated the secret of `{}` on {}.",
        rotated.token.label(),
        deployment.label()
    ));
    out.note(&match rotated.previous_secret_expires_at {
        Some(at) => format!("The previous secret keeps working until {}.", timestamp(at)),
        None => "The previous secret has stopped working.".to_owned(),
    });
    show_secret(&rotated.client_id, &rotated.client_secret, sink, out);
}

/// The object every `--json` document starts from.
fn base(deployment: &Deployment) -> serde_json::Value {
    serde_json::json!({ "server": deployment.host, "instance": deployment.instance })
}

/// Emits a create or rotate document, with the secret in it unless it went to
/// a file.
fn emit_with_secret(
    mut document: serde_json::Value,
    secret: &secrecy::SecretString,
    sink: &SecretSink,
    out: Output,
) {
    match sink {
        SecretSink::File(path) => {
            document["secret_file"] = path.display().to_string().into();
            out.json(&document);
        }
        // `SecretSink::Stdout` is refused under `--json` before anything is
        // sent, so this arm is the terminal one in practice.
        SecretSink::Show | SecretSink::Stdout => {
            document["client_secret"] = secret.expose_secret().into();
            out.secret_json(&document);
        }
    }
}

/// Prints the human-mode client id and, when it belongs here, the secret.
fn show_secret(client_id: &str, secret: &secrecy::SecretString, sink: &SecretSink, out: Output) {
    match sink {
        SecretSink::Show => {
            out.data(&format!("Client ID:     {client_id}"));
            out.data_raw("Client secret: ");
            out.secret_data(secret.expose_secret());
            out.note("This is the only time the client secret is shown; the server keeps no copy.");
        }
        SecretSink::File(path) => {
            out.data(client_id);
            out.note(&format!(
                "Wrote the client secret to {}, readable by its owner only.",
                path.display()
            ));
        }
        // The secret is already on stdout, alone. The client id goes to
        // stderr, where it cannot end up inside the value being piped.
        SecretSink::Stdout => out.note(&format!("Client ID: {client_id}")),
    }
}

/// Prints a listing.
pub(super) fn list(
    list: &ServiceTokenList,
    all: bool,
    now: i64,
    deployment: &Deployment,
    global: &GlobalArgs,
    out: Output,
) {
    let shown: Vec<&ServiceToken> =
        list.tokens.iter().filter(|token| all || !token.is_revoked()).collect();

    if global.json {
        let mut document = base(deployment);
        document["cloudflare"] = list.cloudflare.clone().into();
        document["tokens"] = shown.iter().map(|token| token_json(token, now)).collect();
        out.json(&document);
        return;
    }

    out.note(&format!("Service tokens on {}:", deployment.label()));
    if list.cloudflare == "unavailable" {
        out.warn("Cloudflare could not be reached, so expiry and last use are unknown.");
    }
    if shown.is_empty() {
        let hidden = list.tokens.len();
        out.note(&if hidden > 0 {
            format!("No active service tokens. `--all` includes the {hidden} revoked one(s).")
        } else {
            "No service tokens.".to_owned()
        });
        return;
    }
    for token in shown {
        out.data(&row(token, now));
    }
}

/// Reports one token after a refresh or an adoption.
pub(super) fn one(
    token: &ServiceToken,
    verb: &str,
    now: i64,
    deployment: &Deployment,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let mut document = base(deployment);
        document["token"] = token_json(token, now);
        out.json(&document);
        return;
    }
    out.note(&format!("{verb} `{}` on {}.", token.label(), deployment.label()));
    out.data(&row(token, now));
}

/// Reports a revocation.
pub(super) fn revoked(
    token: &ServiceToken,
    deployment: &Deployment,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let mut document = base(deployment);
        document["revoked"] = token.client_id.clone().into();
        document["token_id"] = token.id.clone().into();
        out.json(&document);
    } else {
        out.data(&format!(
            "Revoked `{}` ({}) on {}.",
            token.label(),
            token.client_id,
            deployment.label()
        ));
    }
}

/// Shows what an `--apply` is about to repair, ahead of the confirmation.
pub(super) fn reconcile_preview(result: &ReconcileResult, out: Output) {
    for entry in &result.entries {
        out.note(&format!("  {}", reconcile_row(entry)));
    }
}

/// Reports a reconciliation, dry run or applied.
pub(super) fn reconciled(
    result: &ReconcileResult,
    deployment: &Deployment,
    global: &GlobalArgs,
    out: Output,
) {
    if global.json {
        let mut document = base(deployment);
        document["applied"] = result.applied.into();
        document["entries"] = result
            .entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "kind": entry.kind,
                    "cloudflare_id": entry.cloudflare_id,
                    "client_id": entry.client_id,
                    "name": entry.name,
                    "applied": entry.applied,
                    "error": entry.error,
                })
            })
            .collect();
        out.json(&document);
        return;
    }

    if result.entries.is_empty() {
        out.note(&format!("prick's records and Cloudflare's agree on {}.", deployment.label()));
        return;
    }
    for entry in &result.entries {
        out.data(&reconcile_row(entry));
    }
    if !result.applied {
        out.note("Run again with `--apply` to repair these. `foreign` entries are left alone.");
    }
}

/// One reconciliation entry, as a line.
fn reconcile_row(entry: &ReconcileEntry) -> String {
    let outcome = match (&entry.error, entry.applied) {
        (Some(error), _) => format!("FAILED: {error}"),
        (None, true) => "repaired".to_owned(),
        (None, false) => reconcile_meaning(&entry.kind).to_owned(),
    };
    format!(
        "{}\t{}\t{}\t{outcome}",
        entry.kind,
        entry.client_id,
        entry.name.as_deref().unwrap_or("-")
    )
}

/// What a reconciliation kind means, and what `--apply` does about it.
fn reconcile_meaning(kind: &str) -> &'static str {
    match kind {
        "orphan" => "in Cloudflare under this deployment, with no prick record; apply deletes it",
        "missing" => "recorded as active, absent from Cloudflare; apply marks it revoked",
        "revoke_incomplete" => "revoked here, still in Cloudflare; apply deletes it there",
        "foreign" => "belongs to another deployment on this account; left alone",
        _ => "reported by the server",
    }
}

/// One token, as a listing line.
pub(crate) fn row(token: &ServiceToken, now: i64) -> String {
    let (expires, seen) = match &token.cloudflare {
        Some(cloudflare) => (
            cloudflare.expires_at.map_or_else(|| "never".to_owned(), date),
            cloudflare.last_seen_at.map_or_else(|| "never".to_owned(), date),
        ),
        None => ("unknown".to_owned(), "unknown".to_owned()),
    };
    let mut line = format!(
        "{}\t{}\t{}\texpires {expires}\tlast seen {seen}",
        token.label(),
        token.client_id,
        token.status
    );
    for flag in flags(token, now) {
        line.push('\t');
        line.push_str(flag);
    }
    line
}

/// What a listing calls out about a token.
pub(crate) fn flags(token: &ServiceToken, now: i64) -> Vec<&'static str> {
    let mut flags = Vec::new();
    if token.disabled && !token.is_revoked() {
        flags.push("DISABLED");
    }
    if let Some(cloudflare) = &token.cloudflare {
        match cloudflare.expires_at {
            Some(at) if at <= now => flags.push("EXPIRED"),
            Some(at) if at - now <= EXPIRY_WARNING_DAYS * DAY_MS => flags.push("EXPIRES SOON"),
            _ => {}
        }
        if cloudflare.leak_reported_at.is_some() {
            flags.push("LEAK REPORTED");
        }
    }
    flags
}

/// One token, as a JSON document.
pub(crate) fn token_json(token: &ServiceToken, now: i64) -> serde_json::Value {
    let flags = flags(token, now);
    serde_json::json!({
        "id": token.id,
        "identity_id": token.identity_id,
        "client_id": token.client_id,
        "name": token.name,
        "cloudflare_id": token.cloudflare_id,
        "cloudflare_name": token.cloudflare_name,
        "adopted": token.adopted,
        "disabled": token.disabled,
        "status": token.status,
        "created_at": token.created_at,
        "created_by": token.created_by,
        "rotated_at": token.rotated_at,
        "revoked_at": token.revoked_at,
        "revoked_by": token.revoked_by,
        "cloudflare": token.cloudflare.as_ref().map(|cloudflare| serde_json::json!({
            "expires_at": cloudflare.expires_at,
            "last_seen_at": cloudflare.last_seen_at,
            "enabled": cloudflare.enabled,
            "duration": cloudflare.duration,
            "leak_reported_at": cloudflare.leak_reported_at,
        })),
        "expires_soon": flags.contains(&"EXPIRES SOON") || flags.contains(&"EXPIRED"),
        "leak_reported": flags.contains(&"LEAK REPORTED"),
    })
}

/// A grace period, in the largest unit that divides it: `7d`, `24h`, `90m`.
pub(crate) fn seconds(total: u32) -> String {
    match total {
        0 => "0s".to_owned(),
        t if t % 86_400 == 0 => format!("{}d", t / 86_400),
        t if t % 3_600 == 0 => format!("{}h", t / 3_600),
        t if t % 60 == 0 => format!("{}m", t / 60),
        t => format!("{t}s"),
    }
}

/// An epoch-millisecond instant as a UTC date, `2027-10-31`.
pub(crate) fn date(ms: i64) -> String {
    let (year, month, day) = civil(ms.div_euclid(DAY_MS));
    format!("{year:04}-{month:02}-{day:02}")
}

/// An epoch-millisecond instant as a UTC minute, `2027-10-31 14:05 UTC`.
pub(crate) fn timestamp(ms: i64) -> String {
    let minutes = ms.rem_euclid(DAY_MS) / 60_000;
    format!("{} {:02}:{:02} UTC", date(ms), minutes / 60, minutes % 60)
}

/// Days since 1970-01-01 as a proleptic Gregorian `(year, month, day)`.
///
/// Howard Hinnant's `civil_from_days`, which is exact over the whole `i64`
/// range a timestamp in this API can take.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
