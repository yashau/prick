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
