import { verifyWithJwks } from "hono/jwt";

import type { Actor, RuntimeConfig } from "../core/context.js";
import { PrickError } from "../core/errors.js";
import type { AccessClaims } from "./claims.js";
import { classifyClaims } from "./claims.js";
import { findJwksKey, resolveCertsUrl } from "./jwks.js";

/**
 * Cloudflare Access JWT verification.
 *
 * Built on `verifyWithJwks` from `hono/jwt` -- no `jose` dependency, because a
 * second JOSE implementation is a second thing to keep patched. Every claim
 * assertion below sits ON TOP of it, because the generic helper does not model
 * Access exactly, and each one is load-bearing:
 *
 *   alg   taken from the JWKS entry matched by `kid`, NEVER from the token
 *         header. `verifyWithJwks` cross-checks the header against the JWKS
 *         entry's `alg` only WHEN THE ENTRY DECLARES ONE -- a JWKS entry with
 *         no `alg` lets the header pick the algorithm. So the entry's `alg` is
 *         resolved here first and pinned as the sole allowed algorithm, which
 *         is what rejects `alg: none` and RS256->HS256 confusion.
 *   iss   exact string equality with `https://<team>.cloudflareaccess.com`.
 *   aud   an ARRAY -- assert `.includes(ACCESS_AUD)`, not `===`.
 *   exp   required, always checked, no skew allowance. Expired is expired.
 *   nbf   checked ONLY IF PRESENT. Service tokens have no `nbf`, and a verifier
 *         that requires one rejects every machine client.
 *   iat   checked only if present, with a small skew allowance.
 *
 * Every rejection is a `PrickError('UNAUTHENTICATED')` and NONE of them echo
 * the token, a claim value, or the `kid` back to the caller.
 */

/** The header Access sets. Primary, because the cookie is not guaranteed. */
export const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

/** The cookie Access sets on browser navigations. Fallback only. */
export const ACCESS_ASSERTION_COOKIE = "CF_Authorization";

/**
 * Upper bound on an accepted assertion, in characters.
 *
 * An Access JWT is ~1 KB. The bound exists so a multi-megabyte "token" is
 * rejected by a string comparison rather than by a base64 decode and a JSON
 * parse.
 */
const MAX_ASSERTION_LENGTH = 8192;

/** Tolerance for forward-dated `nbf`/`iat`, in seconds. Never applied to `exp`. */
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

export interface AccessVerifyOptions {
  /** The `<team>` in `https://<team>.cloudflareaccess.com`. */
  team: string;
  /** The Access application's AUD tag. Matched against the `aud` ARRAY. */
  aud: string;
  /** Overrides the team-derived certs URL. Configuration, not a code path. */
  certsUrl?: string | null | undefined;
  /** Injected epoch MILLISECONDS, so expiry is testable without sleeping. */
  now?: number;
  clockSkewSeconds?: number;
}

/**
 * Build verification options from the parsed runtime config.
 *
 * Reads `RuntimeConfig` rather than raw `vars`. This used to take a structural
 * `AccessEnvLike` and pull `ACCESS_TEAM` / `ACCESS_AUD` / `ACCESS_CERTS_URL`
 * straight off `env`, which made it the one place outside `loadRuntimeConfig`
 * that parsed a `var` -- two readers of the same three strings, free to disagree
 * about trimming and about what an empty string means.
 *
 * Fails closed on an unset `ACCESS_AUD`: an empty AUD tag would make the `aud`
 * assertion vacuous, and a verifier that accepts tokens minted for a DIFFERENT
 * Access application in the same account is not a verifier. This check lives
 * here rather than in `loadRuntimeConfig` on purpose -- `/health` is
 * unauthenticated by design and must not start failing because Access is
 * misconfigured for the routes that are.
 */
export function accessOptionsFromConfig(config: RuntimeConfig, now?: number): AccessVerifyOptions {
  const team = config.accessTeam.trim();
  const aud = config.accessAud.trim();

  if (team === "") {
    throw new PrickError("SERVER_MISCONFIGURED", "ACCESS_TEAM is not set.", {
      hint: "Set ACCESS_TEAM in wrangler.jsonc to your Cloudflare Access team name and redeploy.",
    });
  }

  if (aud === "") {
    throw new PrickError("SERVER_MISCONFIGURED", "ACCESS_AUD is not set.", {
      hint: "Copy the Application Audience (AUD) tag from Zero Trust > Access > Applications > Overview into ACCESS_AUD and redeploy.",
    });
  }

  const options: AccessVerifyOptions = { team, aud };
  if (config.accessCertsUrl !== undefined) options.certsUrl = config.accessCertsUrl;
  if (now !== undefined) options.now = now;
  return options;
}

/**
 * Extract the assertion from a request. Header first, cookie as fallback.
 *
 * The header is primary because Cloudflare documents the `CF_Authorization`
 * cookie as not guaranteed to be passed in every context -- notably the one
 * that matters here, a server-side call made on behalf of a browser request.
 *
 * Returns `null` rather than throwing, so a caller can distinguish "no
 * credential offered" from "credential offered and rejected". Everything on a
 * request path should call `requireAssertion` instead.
 */
export function extractAssertion(request: Request): string | null {
  const header = request.headers.get(ACCESS_ASSERTION_HEADER);
  const fromHeader = normaliseAssertion(header);
  if (fromHeader !== null) return fromHeader;

  return normaliseAssertion(readCookie(request.headers.get("Cookie"), ACCESS_ASSERTION_COOKIE));
}

/** `extractAssertion`, but a missing credential is a 401 rather than a `null`. */
export function requireAssertion(request: Request): string {
  const token = extractAssertion(request);

  if (token === null) {
    throw new PrickError("UNAUTHENTICATED", "No Cloudflare Access assertion was presented.", {
      hint: `Requests must carry the ${ACCESS_ASSERTION_HEADER} header, or the ${ACCESS_ASSERTION_COOKIE} cookie set by Access.`,
    });
  }

  return token;
}

function normaliseAssertion(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed;
}

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Split on the FIRST `=` only. A JWT is unpadded base64url and so contains no
 * `=`, but a parser that splits on every `=` is wrong for the general case and
 * this one is used on attacker-controlled input.
 */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }

  return null;
}

interface AccessTokenHeader {
  alg: string;
  kid: string;
  typ?: string;
}

/**
 * The JOSE header and JWT payload as they arrive: every field `unknown`.
 *
 * Declared as named optional properties rather than a `Record<string, unknown>`
 * so each read is a checked property access. With an index signature, a typo
 * (`payload.common_nane`) would type-check as `unknown` and silently classify
 * every service token as unidentified.
 */
interface RawJoseHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface RawAccessPayload {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  email?: unknown;
  common_name?: unknown;
  identity_nonce?: unknown;
  country?: unknown;
  type?: unknown;
}

function base64UrlToString(part: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw unauthenticated("The access token is malformed.");
  }

  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw unauthenticated("The access token is malformed.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function unauthenticated(message: string, hint?: string): PrickError {
  return new PrickError("UNAUTHENTICATED", message, hint === undefined ? {} : { hint });
}

/**
 * Parse and strictly validate the JOSE header.
 *
 * Done here rather than left to `verifyWithJwks` because the `kid` is needed
 * BEFORE verification -- it is what selects the algorithm.
 */
function decodeTokenHeader(token: string): AccessTokenHeader {
  if (token.length > MAX_ASSERTION_LENGTH) {
    throw unauthenticated("The access token is malformed.");
  }

  const [encodedHeader, encodedPayload, signature, ...rest] = token.split(".");
  if (
    rest.length !== 0 ||
    encodedHeader === undefined ||
    encodedHeader === "" ||
    encodedPayload === undefined ||
    encodedPayload === "" ||
    signature === undefined
  ) {
    throw unauthenticated("The access token is malformed.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToString(encodedHeader));
  } catch (error) {
    if (error instanceof PrickError) throw error;
    throw unauthenticated("The access token is malformed.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw unauthenticated("The access token is malformed.");
  }

  const header = parsed as RawJoseHeader;

  if (typeof header.alg !== "string" || header.alg === "") {
    throw unauthenticated("The access token header declares no algorithm.");
  }

  // Access always sets `kid`, and without one there is nothing to select a key
  // by -- "try every key" is how a retired key stays usable forever.
  if (typeof header.kid !== "string" || header.kid === "") {
    throw unauthenticated("The access token header declares no key id.");
  }

  if (header.typ !== undefined && header.typ !== "JWT") {
    throw unauthenticated("The access token is not a JWT.");
  }

  const result: AccessTokenHeader = { alg: header.alg, kid: header.kid };
  if (typeof header.typ === "string") result.typ = header.typ;
  return result;
}

function numericClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Verify a Cloudflare Access JWT and return its claims.
 *
 * Order matters: the key is resolved from `kid` first, so the algorithm is
 * known before a single byte of the signature is checked.
 */
export async function verifyAccessJwt(
  token: string,
  options: AccessVerifyOptions,
): Promise<AccessClaims> {
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

  const issuer = `https://${options.team.trim()}.cloudflareaccess.com`;
  const certsUrl = resolveCertsUrl(options.team, options.certsUrl);

  if (typeof token !== "string" || token.trim() === "") {
    throw unauthenticated("No Cloudflare Access assertion was presented.");
  }

  const header = decodeTokenHeader(token.trim());

  // THE key step. The algorithm comes from the JWKS entry, never the header.
  const key = await findJwksKey(certsUrl, header.kid, now);

  let payload: RawAccessPayload;
  try {
    payload = (await verifyWithJwks(token.trim(), {
      keys: [key],
      // Pinned to the ONE algorithm the JWKS entry declares. A token whose
      // header says HS256, RS512 or none never reaches signature verification.
      allowedAlgorithms: [key.alg as "RS256"],
      // Every temporal claim is asserted below against the INJECTED clock.
      // Leaving these on would silently re-check them against `Date.now()`,
      // giving two different answers for one token.
      verification: { exp: false, nbf: false, iat: false },
    })) as RawAccessPayload;
  } catch (cause) {
    throw new PrickError("UNAUTHENTICATED", "The access token could not be verified.", {
      hint: "The signature, algorithm or key id did not match a current Access signing key.",
      cause,
    });
  }

  // --- iss: exact string equality, no prefix match, no regex ---------------
  if (typeof payload.iss !== "string" || payload.iss !== issuer) {
    throw unauthenticated("The access token was issued by a different Access team.");
  }
  const iss: string = payload.iss;

  // --- aud: an ARRAY. `.includes`, never `===` ----------------------------
  if (
    !Array.isArray(payload.aud) ||
    payload.aud.length === 0 ||
    !payload.aud.every((tag: unknown) => typeof tag === "string")
  ) {
    throw unauthenticated("The access token carries no audience list.");
  }
  const aud = payload.aud as string[];

  if (!aud.includes(options.aud)) {
    throw unauthenticated("The access token was issued for a different Access application.");
  }

  // --- exp: REQUIRED, and in the future. No skew allowance ----------------
  const exp = numericClaim(payload.exp);
  if (exp === null) {
    throw unauthenticated("The access token carries no expiry.");
  }
  if (exp <= nowSeconds) {
    throw unauthenticated(
      "The access token has expired.",
      "Sign in again to obtain a fresh token.",
    );
  }

  // --- nbf: ONLY IF PRESENT. Service tokens do not carry one --------------
  let nbf: number | undefined;
  if (payload.nbf !== undefined) {
    const value = numericClaim(payload.nbf);
    if (value === null) {
      throw unauthenticated("The access token carries a malformed not-before claim.");
    }
    if (value > nowSeconds + skew) {
      throw unauthenticated("The access token is not valid yet.");
    }
    nbf = value;
  }

  // --- iat: only if present, with skew ------------------------------------
  let iat: number | undefined;
  if (payload.iat !== undefined) {
    const value = numericClaim(payload.iat);
    if (value === null) {
      throw unauthenticated("The access token carries a malformed issued-at claim.");
    }
    if (value > nowSeconds + skew) {
      throw unauthenticated("The access token was issued in the future.");
    }
    iat = value;
  }

  // --- sub: a string, possibly EMPTY (that is the service-token shape) -----
  if (typeof payload.sub !== "string") {
    throw unauthenticated("The access token carries no subject.");
  }

  if (payload.email !== undefined && typeof payload.email !== "string") {
    throw unauthenticated("The access token carries a malformed email claim.");
  }
  if (payload.common_name !== undefined && typeof payload.common_name !== "string") {
    throw unauthenticated("The access token carries a malformed common name claim.");
  }

  const claims: AccessClaims = { iss, aud, sub: payload.sub, exp };

  if (iat !== undefined) claims.iat = iat;
  if (nbf !== undefined) claims.nbf = nbf;
  if (typeof payload.email === "string") claims.email = payload.email;
  if (typeof payload.common_name === "string") claims.common_name = payload.common_name;
  if (typeof payload.identity_nonce === "string") claims.identity_nonce = payload.identity_nonce;
  if (typeof payload.country === "string") claims.country = payload.country;
  if (typeof payload.type === "string") claims.type = payload.type;

  return claims;
}

/** Extract, then verify. The one entry point a transport should call. */
export async function verifyAccessRequest(
  request: Request,
  options: AccessVerifyOptions,
): Promise<AccessClaims> {
  return verifyAccessJwt(requireAssertion(request), options);
}

/**
 * Defence-in-depth check against Access-on-Workers (`ctx.access`).
 *
 * Cloudflare shipped this on 2026-08-14 and it is not yet in the config
 * reference. It is used as an ASSERTION alongside our own verification, never
 * instead of it, and is gated behind `REQUIRE_CTX_ACCESS` which stays `false`
 * until the feature is documented AND confirmed not to swallow service-token
 * requests. If it did swallow them, making it load-bearing would break every
 * CI client at once with no local signal.
 */
export function assertCtxAccess(ctx: unknown, options: { requireCtxAccess: boolean }): void {
  if (!options.requireCtxAccess) return;

  const access =
    typeof ctx === "object" && ctx !== null ? (ctx as { access?: unknown }).access : undefined;

  if (typeof access !== "object" || access === null) {
    throw new PrickError("UNAUTHENTICATED", "Access-on-Workers did not attest this request.", {
      hint: "REQUIRE_CTX_ACCESS is true but ctx.access is absent. Set REQUIRE_CTX_ACCESS to false unless the Worker is bound to an Access application.",
    });
  }
}

/**
 * Claims -> `Actor`.
 *
 * `identityId` is `null` and `bootstrap` is `false` here on purpose: both are
 * facts about the DATABASE, and this function does not have one. They are
 * filled in by `resolveAuthorization`, which is also where the identity row is
 * created or touched.
 */
export function actorFromClaims(claims: AccessClaims): Actor {
  const { kind, subject } = classifyClaims(claims);
  return { kind, subject, identityId: null, bootstrap: false };
}
