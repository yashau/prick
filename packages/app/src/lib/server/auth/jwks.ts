/**
 * JWKS fetching and caching for Cloudflare Access.
 *
 * TODO(build order step 10): implement.
 *
 * Cache in MODULE SCOPE with a 1 hour TTL, plus a RATE-LIMITED refetch when a
 * token presents an unknown `kid`. Both halves are necessary: Access rotates
 * signing keys roughly every 6 weeks with a 7-day overlap, so a pure-TTL cache
 * is correct but takes up to an hour to notice a rotation, while an
 * unconditional refetch-on-unknown-kid is a free outbound-request amplifier for
 * anyone who can send this Worker a token with a random `kid`.
 *
 * The certs URL is CONFIGURATION (`ACCESS_CERTS_URL`, defaulting to
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) rather than a
 * constant, because that is what lets the integration tests generate a real
 * RS256 keypair, serve it as JWKS, and exercise the REAL verifier end to end.
 * Injecting a fake verifier instead would leave the one piece of code where a
 * security bug would actually live completely untested. A sentinel grep on the
 * built Worker ensures the test URL never ships.
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
  fetchedAt: number;
}

export function accessCertsUrl(_team: string): string {
  throw new Error("accessCertsUrl() is not implemented yet");
}

export function getJwks(_url: string, _now: number): Promise<JwksKey[]> {
  throw new Error("getJwks() is not implemented yet");
}

/** Rate-limited refetch, for the unknown-`kid` path only. */
export function refreshJwks(_url: string, _now: number): Promise<JwksKey[]> {
  throw new Error("refreshJwks() is not implemented yet");
}
