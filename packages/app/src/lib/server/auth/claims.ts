/**
 * The claim shape of a Cloudflare Access JWT, as it actually arrives -- not as
 * a generic JWT helper assumes it does.
 *
 * A SERVICE TOKEN payload has no `email`, no `nbf`, and `sub` is the EMPTY
 * STRING. A verifier written against the human token shape -- requiring `nbf`,
 * or requiring a non-empty `sub`, or requiring `email` -- rejects every machine
 * client with a message that explains nothing. That is an explicit negative
 * test, not a footnote.
 */
export interface AccessClaims {
  /** `https://<team>.cloudflareaccess.com`. Asserted by EXACT equality. */
  iss: string;

  /**
   * An ARRAY of AUD tags, not a string. Assert `.includes(ACCESS_AUD)`.
   * A verifier that compares `aud === expected` fails on every real token.
   */
  aud: string[];

  /** Empty string for a service token. */
  sub: string;

  exp: number;
  iat?: number;
  /** ABSENT on service tokens. Only validated when present. */
  nbf?: number;

  /** Human tokens only. */
  email?: string;

  /**
   * Service tokens only, e.g. `e367826f93b8d71185e03fe518aff3b4.access`.
   * Opaque by design -- see `listUnknownIdentities`.
   */
  common_name?: string;

  identity_nonce?: string;
  country?: string;
  type?: string;
}

/**
 * Which kind of Access credential a set of claims represents.
 *
 * TODO(build order step 10): implement, and cover the ambiguous cases
 * explicitly -- claims carrying BOTH `email` and `common_name`, and claims
 * carrying neither, must both be rejected rather than guessed at.
 */
export function classifyClaims(_claims: AccessClaims): {
  kind: "user" | "service";
  subject: string;
} {
  throw new Error("classifyClaims() is not implemented yet");
}
