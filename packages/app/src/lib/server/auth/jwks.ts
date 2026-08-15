import { PrickError } from "../core/errors.js";

/**
 * JWKS fetching and caching for Cloudflare Access.
 *
 * Two independent staleness controls, and both are necessary:
 *
 *   TTL (1 hour)          bounds how long a key we have stopped trusting can
 *                         keep being trusted.
 *   unknown-`kid` refetch  bounds how long a key we have never seen stays
 *                         unknown. Access rotates signing keys roughly every 6
 *                         weeks with a 7-day overlap, so a pure-TTL cache is
 *                         correct but takes up to an hour to notice a rotation
 *                         -- during which every token signed by the new key is
 *                         rejected, intermittently, for no visible reason.
 *
 * The refetch is RATE-LIMITED to at most once per 60 s per URL. Without that
 * limit anyone who can send this Worker a token bearing a random `kid` has a
 * free outbound-request amplifier pointed at the Access origin.
 *
 * The certs URL is CONFIGURATION (`ACCESS_CERTS_URL`, defaulting to
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) rather than a
 * constant, because that is what lets the integration tests generate a real
 * RS256 keypair, serve it as JWKS, and exercise the REAL verifier end to end.
 * Injecting a fake verifier instead would leave the one piece of code where a
 * security bug would actually live completely untested.
 */

export interface JwksKey {
  kid: string;
  kty: string;
  /**
   * The algorithm to verify with is taken FROM HERE -- from the JWKS entry
   * matched by `kid` -- and never from the token header. Trusting the header's
   * `alg` is what makes `alg: none` and RS256->HS256 confusion possible.
   */
  alg: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface JwksCacheEntry {
  keys: JwksKey[];
  /** When the `keys` above were actually retrieved. Drives the TTL. */
  fetchedAt: number;
  /**
   * When an outbound fetch was last ATTEMPTED, successful or not. Drives the
   * rate limit. Kept separate from `fetchedAt` so a failing origin cannot both
   * be hammered (one timestamp bumped only on success) and silently reset the
   * TTL (one timestamp bumped on every attempt).
   */
  attemptedAt: number;
}

/** How long a successfully fetched key set is served without re-checking. */
export const JWKS_TTL_MS = 60 * 60 * 1000;

/** Floor on the interval between outbound fetches for one URL. */
export const JWKS_MIN_REFETCH_INTERVAL_MS = 60 * 1000;

/**
 * MODULE SCOPE, keyed by URL.
 *
 * Keyed rather than a single slot because a Worker isolate can serve more than
 * one `env`, and one team's signing keys must never be served for another's.
 * In production this map holds exactly one entry.
 */
const cache = new Map<string, JwksCacheEntry>();

/** Algorithms that may appear on a JWKS entry. Asymmetric only, by design. */
const ALLOWED_JWKS_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

/** The team-derived default. `<team>` is not escaped -- it is validated first. */
export function accessCertsUrl(team: string): string {
  const trimmed = team.trim();

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(trimmed)) {
    throw new PrickError("SERVER_MISCONFIGURED", "ACCESS_TEAM is not a valid Access team name.", {
      hint: 'Set ACCESS_TEAM in wrangler.jsonc to the <team> in "https://<team>.cloudflareaccess.com" and redeploy.',
    });
  }

  return `https://${trimmed}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

/**
 * Resolve the effective certs URL.
 *
 * An override is accepted because that is the test seam, but it is validated
 * exactly as strictly as anything else: HTTPS only, no credentials, no
 * fragment. A plaintext JWKS endpoint would make key substitution a
 * network-level attack rather than a cryptographic one.
 */
export function resolveCertsUrl(team: string, override?: string | null | undefined): string {
  if (override === undefined || override === null || override.trim() === "") {
    return accessCertsUrl(team);
  }

  let parsed: URL;
  try {
    parsed = new URL(override.trim());
  } catch {
    throw new PrickError("SERVER_MISCONFIGURED", "ACCESS_CERTS_URL is not a valid URL.", {
      hint: "Remove ACCESS_CERTS_URL to use the team default, or set it to an absolute https:// URL.",
    });
  }

  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new PrickError(
      "SERVER_MISCONFIGURED",
      "ACCESS_CERTS_URL must be an https:// URL without embedded credentials.",
      { hint: "Signing keys fetched over plaintext can be substituted in transit." },
    );
  }

  parsed.hash = "";
  return parsed.toString();
}

/**
 * Parse a JWKS document, keeping only entries this verifier could ever use.
 *
 * Entries missing `kid` or `alg`, or declaring a symmetric or unknown `alg`,
 * are DROPPED rather than tolerated: an entry with no `alg` would let the token
 * header choose the algorithm, which is the whole vulnerability this module
 * exists to close.
 */
interface RawJwksDocument {
  keys?: unknown;
}

interface RawJwksKey {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
}

function parseJwks(body: unknown, url: string): JwksKey[] {
  const document = typeof body === "object" && body !== null ? (body as RawJwksDocument) : null;

  if (document === null || !Array.isArray(document.keys)) {
    throw new PrickError(
      "SERVER_MISCONFIGURED",
      "The Access certs endpoint returned a malformed JWKS.",
      {
        hint: `Expected a JSON document with a "keys" array from ${url}.`,
      },
    );
  }

  const keys: JwksKey[] = [];

  for (const raw of document.keys as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;

    const { kid, kty, alg, use, n, e } = raw as RawJwksKey;

    if (typeof kid !== "string" || kid === "") continue;
    if (typeof kty !== "string" || kty === "") continue;
    if (typeof alg !== "string" || !ALLOWED_JWKS_ALGORITHMS.has(alg)) continue;
    // `use` is optional, but when present it must say this key signs.
    if (use !== undefined && use !== "sig") continue;

    const key: JwksKey = { kid, kty, alg };
    if (typeof use === "string") key.use = use;
    if (typeof n === "string") key.n = n;
    if (typeof e === "string") key.e = e;

    keys.push(key);
  }

  return keys;
}

async function fetchJwks(url: string): Promise<JwksKey[]> {
  let response: Response;

  try {
    response = await fetch(url, {
      // Backs the module-scope cache with Cloudflare's own cache, so a COLD
      // isolate -- which has no module state at all -- hits the edge rather
      // than the Access origin. Ignored by miniflare locally, which is fine:
      // it is an optimisation, never a correctness property.
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (cause) {
    // Transient, not misconfigured. The URL was validated before we got here, so
    // a failed connection means Access is unreachable right now -- which is
    // exactly the thing a client SHOULD retry.
    throw new PrickError(
      "IDENTITY_PROVIDER_UNAVAILABLE",
      "Could not reach the Access certs endpoint.",
      { hint: `Fetching ${url} failed.`, cause },
    );
  }

  if (!response.ok) {
    // 5xx is Access having a bad day: retryable. 4xx means we are pointed at
    // something that is not our certs endpoint -- a wrong team name or a stale
    // ACCESS_CERTS_URL -- and no amount of retrying will fix that.
    const transient = response.status >= 500;
    throw new PrickError(
      transient ? "IDENTITY_PROVIDER_UNAVAILABLE" : "SERVER_MISCONFIGURED",
      "The Access certs endpoint returned an error.",
      {
        hint: transient
          ? `${url} responded with HTTP ${String(response.status)}. Access may be degraded.`
          : `${url} responded with HTTP ${String(response.status)}. Check ACCESS_TEAM and ACCESS_CERTS_URL.`,
      },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PrickError(
      "SERVER_MISCONFIGURED",
      "The Access certs endpoint returned invalid JSON.",
      {
        hint: `Expected a JWKS document from ${url}.`,
        cause,
      },
    );
  }

  return parseJwks(body, url);
}

/**
 * The cached key set, refetched when the TTL has elapsed.
 *
 * `now` is injected rather than read from the clock so expiry is testable
 * without sleeping.
 */
export async function getJwks(url: string, now: number): Promise<JwksKey[]> {
  const entry = cache.get(url);

  if (entry !== undefined && now - entry.fetchedAt < JWKS_TTL_MS) {
    return entry.keys;
  }

  try {
    const keys = await fetchJwks(url);
    cache.set(url, { keys, fetchedAt: now, attemptedAt: now });
    return keys;
  } catch (error) {
    if (entry !== undefined) {
      // A transient failure must not throw away a key set that still verifies
      // real traffic. Record the attempt so the origin is not hammered, and
      // keep serving what we have; `fetchedAt` is deliberately NOT bumped, so
      // the entry stays expired and the next request tries again.
      cache.set(url, { ...entry, attemptedAt: now });
      return entry.keys;
    }
    throw error;
  }
}

/**
 * Rate-limited refetch, for the unknown-`kid` path ONLY.
 *
 * Returns the cached keys unchanged when the limit says no. That is not a
 * silent failure: the caller treats "still no matching kid" as a rejection
 * either way, so suppressing the fetch costs a rejected request, never an
 * accepted one.
 */
export async function refreshJwks(url: string, now: number): Promise<JwksKey[]> {
  const entry = cache.get(url);

  if (entry !== undefined && now - entry.attemptedAt < JWKS_MIN_REFETCH_INTERVAL_MS) {
    return entry.keys;
  }

  try {
    const keys = await fetchJwks(url);
    cache.set(url, { keys, fetchedAt: now, attemptedAt: now });
    return keys;
  } catch (error) {
    if (entry !== undefined) {
      cache.set(url, { ...entry, attemptedAt: now });
      return entry.keys;
    }
    throw error;
  }
}

/**
 * The signing key for one `kid`, or a rejection.
 *
 * This is the only function `access.ts` calls. It encapsulates the
 * cache-then-rate-limited-refetch sequence so there is exactly one place where
 * "I have never seen this key" is turned into either a key or a 401.
 */
export async function findJwksKey(url: string, kid: string, now: number): Promise<JwksKey> {
  const cached = await getJwks(url, now);
  const hit = cached.find((key) => key.kid === kid);
  if (hit !== undefined) return hit;

  const refreshed = await refreshJwks(url, now);
  const afterRefresh = refreshed.find((key) => key.kid === kid);
  if (afterRefresh !== undefined) return afterRefresh;

  // Deliberately does not name the kid to the caller. The operator-facing
  // detail belongs in the audit row, not in a response body handed to whoever
  // presented the token.
  throw new PrickError("UNAUTHENTICATED", "The access token was signed by an unknown key.", {
    hint: "Sign in again to obtain a token signed by a current Access key.",
  });
}
