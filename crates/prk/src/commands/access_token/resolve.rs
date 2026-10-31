//! Turning what an operator typed into a token, a grace period or a lifetime.

use prick_api::models::ServiceToken;

use super::GRACE_MAX_SECONDS;
use crate::error::CliError;

/// The longest lifetime the server accepts, in hours: ten years.
const DURATION_MAX_HOURS: u32 = 87_600;

/// Finds the one token an operator meant, by prick id, client id or name.
///
/// Tried in that order, and the first kind of identifier that matches anything
/// decides: a name that happens to equal another token's id cannot shadow it.
/// A client id may be given with or without its `.access` suffix. Within a
/// kind, a token still in service is preferred over a revoked one with the
/// same name, because revoking and recreating under one name is the normal
/// life of a CI credential.
///
/// # Errors
///
/// [`CliError::Other`] when nothing matches, or when more than one token does
/// -- listing each, so the operator can pick by client id.
pub(crate) fn resolve<'a>(
    tokens: &'a [ServiceToken],
    wanted: &str,
) -> Result<&'a ServiceToken, CliError> {
    let with_suffix = format!("{wanted}.access");
    let stages: [&dyn Fn(&ServiceToken) -> bool; 3] = [
        &|token| token.id == wanted,
        &|token| token.client_id == wanted || token.client_id == with_suffix,
        &|token| token.name.as_deref() == Some(wanted) || token.label() == wanted,
    ];

    for matches in stages {
        let found: Vec<&ServiceToken> = tokens.iter().filter(|token| matches(token)).collect();
        if found.is_empty() {
            continue;
        }
        let live: Vec<&ServiceToken> =
            found.iter().copied().filter(|token| !token.is_revoked()).collect();
        let candidates = if live.is_empty() { found } else { live };
        if let [only] = candidates.as_slice() {
            return Ok(only);
        }
        let listed: Vec<String> = candidates
            .iter()
            .map(|token| format!("  {}  {}  ({})", token.label(), token.client_id, token.status))
            .collect();
        return Err(CliError::Other(format!(
            "`{wanted}` matches {} service tokens; name one by its client id:\n{}",
            candidates.len(),
            listed.join("\n")
        )));
    }

    Err(CliError::Other(format!(
        "no service token has the id, client id or name `{wanted}`; `prk access token list \
         --all` shows every one"
    )))
}

/// Parses `--grace`: a whole number followed by `s`, `m`, `h` or `d`.
///
/// A unit is required. A bare `30` reads as seconds to one person and minutes
/// to the next, and the difference here is how long a leaked secret keeps
/// working.
///
/// # Errors
///
/// A message for clap to print, naming the accepted forms and the ceiling.
pub(crate) fn parse_grace(raw: &str) -> Result<u32, String> {
    let raw = raw.trim();
    let invalid = || format!("`{raw}` is not a duration; write it as 30m, 24h or 7d");

    let unit_at = raw.len().checked_sub(1).ok_or_else(invalid)?;
    let (number, unit) = (raw.get(..unit_at).ok_or_else(invalid)?, raw.get(unit_at..));
    let scale: u64 = match unit {
        Some("s") => 1,
        Some("m") => 60,
        Some("h") => 60 * 60,
        Some("d") => 24 * 60 * 60,
        _ => return Err(invalid()),
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let seconds = number
        .parse::<u64>()
        .ok()
        .and_then(|count| count.checked_mul(scale))
        .filter(|seconds| *seconds <= u64::from(GRACE_MAX_SECONDS))
        .ok_or_else(|| format!("`{raw}` is longer than the 30-day maximum grace"))?;
    u32::try_from(seconds).map_err(|_| invalid())
}

/// Parses `--duration`: whole hours such as `8760h`, or `forever`.
///
/// The same grammar the server validates, checked here so a typo fails before
/// the capabilities check rather than as a 422 after it.
///
/// # Errors
///
/// A message for clap to print.
pub(crate) fn parse_duration(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw == "forever" {
        return Ok(raw.to_owned());
    }
    let hours = raw
        .strip_suffix('h')
        .filter(|digits| {
            (1..=6).contains(&digits.len())
                && !digits.starts_with('0')
                && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
        .and_then(|digits| digits.parse::<u32>().ok())
        .ok_or_else(|| {
            format!("`{raw}` is not a token lifetime; write whole hours such as 8760h, or forever")
        })?;
    if hours > DURATION_MAX_HOURS {
        return Err(format!(
            "`{raw}` is longer than {DURATION_MAX_HOURS}h (ten years); use forever"
        ));
    }
    Ok(raw.to_owned())
}
