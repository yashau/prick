/**
 * Presentation helpers.
 *
 * All timestamps in this system are epoch milliseconds -- never ISO strings --
 * so every screen has to render them, and doing it in one place is what stops
 * the audit table and the secrets table disagreeing about what "2 hours ago"
 * means.
 */

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const ABSOLUTE = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3_600_000],
  ["month", 30 * 24 * 3_600_000],
  ["week", 7 * 24 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/** "3 days ago" / "in 21 days". Falls back to "just now" under a second. */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const delta = epochMs - now;
  const magnitude = Math.abs(delta);

  if (magnitude < 1000) return "just now";

  for (const [unit, ms] of UNITS) {
    if (magnitude >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }

  return "just now";
}

/**
 * The unambiguous form, always UTC.
 *
 * Shown in tooltips and in the audit table's title attribute. UTC rather than
 * local because an audit log read by two people in different offices has to
 * mean the same thing to both of them, and because every timestamp the server
 * writes is UTC to begin with.
 */
export function absoluteTime(epochMs: number): string {
  return ABSOLUTE.format(new Date(epochMs));
}

/** `2026-08-15` in UTC, for date inputs and range pickers. */
export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** "21 days" / "expired". Used on grant expiry. */
export function expiryLabel(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "Never expires";
  if (expiresAt <= now) return "Expired";
  return `Expires ${relativeTime(expiresAt, now)}`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The fixed-width mask shown in place of a value.
 *
 * Deliberately constant-length: a mask whose width tracked the real value
 * would leak the value's length across every row on the screen, which for a
 * table of API keys is enough to tell one vendor's token format from another's.
 */
export const MASK = "••••••••••••••••";

/**
 * The one or two letters drawn in the avatar.
 *
 * A NAME IS SPLIT ON WORDS; AN ADDRESS IS SPLIT ON ITS LOCAL PART ONLY.
 *
 * That second half is the part worth stating, because the obvious
 * implementation gets it wrong in a way nobody notices until they see their own
 * avatar. Splitting `jdoe@corp.example.com` on every separator and taking the
 * first two pieces yields `jdoe` and `corp` -- "JC" -- half of which is the
 * DOMAIN. Everyone at one organisation then shares a second initial that stands
 * for their employer, so `jdoe@` and `jsmith@` both render "JC" in the one
 * place an avatar exists to tell them apart.
 *
 * So the domain is discarded before anything is counted. `jdoe` alone gives
 * "JD", the first two letters of the only word there is -- a weaker answer than
 * a real name, and honestly weaker rather than confidently wrong.
 *
 * `displayName` wins whenever there is one: `John Doe` gives "JD", first and
 * last rather than first two, so a middle name does not displace a surname.
 *
 * Code points, not UTF-16 units, so a name outside the BMP contributes one
 * whole character instead of half a surrogate pair.
 */
export function initialsFor(input: { displayName?: string | null; subject: string }): string {
  const name = (input.displayName ?? "").trim();
  if (name !== "") return pick(name.split(/\s+/));

  // The local part, and never the domain. A subject with no `@` -- a service
  // token's `common_name` -- is left whole.
  const local = input.subject.split("@")[0] ?? "";

  return pick(local.split(/[._\-+]+/));
}

/**
 * First letter of the first and last word, or the first two letters when there
 * is only one word. `?` rather than an empty badge when there is nothing.
 */
function pick(words: string[]): string {
  const parts = words.filter((word) => word !== "");

  if (parts.length === 0) return "?";

  if (parts.length === 1) {
    return Array.from(parts[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }

  const first = Array.from(parts[0] ?? "")[0] ?? "";
  const last = Array.from(parts[parts.length - 1] ?? "")[0] ?? "";

  return `${first}${last}`.toUpperCase();
}
