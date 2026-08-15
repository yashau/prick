import type { Actor, RuntimeConfig } from "../core/context.js";
import type { AccessClaims } from "./claims.js";

/**
 * Verify a Cloudflare Access JWT and turn it into an `Actor`.
 *
 * TODO(build order step 10): implement on top of `verifyWithJwks` from
 * `hono/jwt`. No `jose` dependency -- Hono already ships what is needed and a
 * second JOSE implementation is a second thing to keep patched.
 *
 * The generic helper does not model Access exactly, so these assertions go on
 * top of it and each one is load-bearing:
 *
 *   alg   taken from the JWKS entry matched by `kid`, NEVER from the token
 *         header. This is what rejects `alg: none` and RS256->HS256 confusion.
 *   iss   exact equality with `https://<ACCESS_TEAM>.cloudflareaccess.com`.
 *   aud   an ARRAY -- assert `.includes(ACCESS_AUD)`, not `===`.
 *   exp   required, always checked.
 *   nbf   checked ONLY IF PRESENT. Service tokens have no `nbf`, and a verifier
 *         that requires one rejects every machine client.
 *   iat   checked only if present, with clock skew allowance.
 *
 * The token arrives in the `CF-Access-JWT-Assertion` header, or in the
 * `CF_Authorization` cookie. Prefer the header: the cookie is documented as not
 * guaranteed to be passed in every context.
 *
 * The FULL negative suite belongs with this function, before anything else is
 * built on it: wrong `aud`, wrong `iss`, expired, `nbf` ABSENT (must PASS),
 * unknown `kid`, `alg: none`, RS->HS confusion.
 */
export function verifyAccessJwt(
  _token: string,
  _config: RuntimeConfig,
  _now: number,
): Promise<AccessClaims> {
  throw new Error("verifyAccessJwt() is not implemented yet");
}

/**
 * Extract the assertion from a request.
 *
 * TODO(build order step 10): header first, cookie as fallback.
 */
export function extractAssertion(_request: Request): string | null {
  throw new Error("extractAssertion() is not implemented yet");
}

/**
 * Defence-in-depth check against Access-on-Workers (`ctx.access`).
 *
 * TODO: Cloudflare shipped this on 2026-08-14 and it is not yet in the config
 * reference. It is used as an ASSERTION alongside our own verification, never
 * instead of it, and is gated behind `REQUIRE_CTX_ACCESS` which stays `false`
 * until the feature is documented AND confirmed not to swallow service-token
 * requests. If it did swallow them, making it load-bearing would break every
 * CI client at once with no local signal.
 */
export function assertCtxAccess(_ctx: unknown, _config: RuntimeConfig): void {
  throw new Error("assertCtxAccess() is not implemented yet");
}

/**
 * TODO(build order step 10/11): claims -> `Actor`, creating or touching the
 * `identities` row.
 */
export function actorFromClaims(_claims: AccessClaims, _config: RuntimeConfig): Actor {
  throw new Error("actorFromClaims() is not implemented yet");
}
