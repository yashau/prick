import { PrickError } from "../core/errors.js";

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

export interface ClassifiedIdentity {
  kind: "user" | "service";
  /** Lower-cased, trimmed email, or a service token's `common_name`. */
  subject: string;
}

/**
 * Which kind of Access credential a set of claims represents.
 *
 *   sub !== '' && email        -> { kind: 'user',    subject: email }
 *   common_name && sub === ''  -> { kind: 'service', subject: common_name }
 *   anything else              -> 401
 *
 * The two ambiguous shapes are REJECTED rather than guessed at:
 *
 *   both `email` and `common_name`  -- there is no such token. Picking one
 *       would mean an attacker who could influence either claim chooses which
 *       identity the request is authorized as.
 *   neither                          -- nothing to key a grant on. An identity
 *       of "" is one every future subject would collide with.
 *
 * Mismatched pairs (an `email` with an empty `sub`, a `common_name` with a
 * non-empty `sub`) fall through to the same rejection for the same reason.
 */
export function classifyClaims(claims: AccessClaims): ClassifiedIdentity {
  const sub = typeof claims.sub === "string" ? claims.sub : "";

  const email =
    typeof claims.email === "string" && claims.email.trim() !== ""
      ? claims.email.trim().toLowerCase()
      : null;

  const commonName =
    typeof claims.common_name === "string" && claims.common_name.trim() !== ""
      ? claims.common_name.trim()
      : null;

  if (email !== null && commonName !== null) {
    throw new PrickError(
      "UNAUTHENTICATED",
      "The access token carries both a user and a service identity.",
      { hint: "This is not a shape Cloudflare Access issues; the token is not trusted." },
    );
  }

  if (sub !== "" && email !== null) {
    return { kind: "user", subject: email };
  }

  if (sub === "" && commonName !== null) {
    return { kind: "service", subject: commonName };
  }

  throw new PrickError("UNAUTHENTICATED", "The access token carries no usable identity.", {
    hint: "A user token needs a non-empty `sub` and an `email`; a service token needs a `common_name` and an empty `sub`.",
  });
}
