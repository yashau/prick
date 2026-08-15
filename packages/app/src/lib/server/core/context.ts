import type { IdentityKind, Role, ScopeType } from "@prick/shared";

import type { Database } from "../db/index.js";

/**
 * Who is making the request, derived from a VERIFIED Access JWT and from
 * nothing else. Never from a header a client controls, never from a cookie.
 *
 *   sub !== '' && email        -> { kind: 'user',    subject: email.toLowerCase() }
 *   common_name && sub === ''  -> { kind: 'service', subject: common_name }
 */
export interface Actor {
  kind: IdentityKind;
  /** Lower-cased email, or a service token's `common_name`. */
  subject: string;
  /**
   * `identities.id`, or `null` when the subject has authenticated but has no
   * identity row yet. A denial for a null-identity actor is still audited --
   * that is what feeds the "Seen but not granted" screen.
   */
  identityId: string | null;
  /**
   * True while this actor is an admin only by virtue of `BOOTSTRAP_ADMINS`
   * rather than a real grant. The UI shows a banner for exactly as long as this
   * is true.
   */
  bootstrap: boolean;
}

/** A resolved authorization scope. */
export type Scope =
  | { type: Extract<ScopeType, "global"> }
  | { type: Extract<ScopeType, "project">; projectId: string }
  | { type: Extract<ScopeType, "environment">; environmentId: string };

/**
 * Everything a `core/*` function needs, and nothing about HTTP.
 *
 * THIS IS THE ARCHITECTURAL SEAM. Hono routes and SvelteKit server loads both
 * build one of these and call the same function. Concretely, that is why a
 * server load can call `listProjects()` IN-PROCESS instead of making an HTTP
 * request to its own Worker: `event.fetch` does not forward arbitrary headers,
 * and the `CF_Authorization` cookie is documented as not guaranteed to be
 * passed, so an internal HTTP hop would have to re-solve authentication badly.
 *
 * It is also why authorization is written once. The upstream bug class where
 * one handler checks scope and the neighbouring one forgets cannot occur when
 * both transports enter through the same function.
 */
export interface CoreContext {
  db: Database;
  actor: Actor;
  /** Echoed as `X-Request-Id` and stored on every audit row this request writes. */
  requestId: string;
  /** Injected rather than read from the clock, so expiry logic is testable. */
  now: number;
  config: RuntimeConfig;
}

/**
 * Parsed, validated `vars`.
 *
 * Everything is read through this rather than off `env` directly, because
 * `wrangler types` gives `vars` string types and half of these are numbers or
 * booleans. Parsing once, at the edge, means no route ever compares a number to
 * the string "500".
 */
export interface RuntimeConfig {
  accessTeam: string;
  accessAud: string;
  /** Parsed from the comma-separated var, lower-cased and de-duplicated. */
  bootstrapAdmins: readonly string[];
  requireCtxAccess: boolean;
  secretMaxBytes: number;
  envMaxSecrets: number;
  bodyMaxBytes: number;
}

/** Total order on roles. `reader < writer < admin`. */
export const ROLE_RANK: Record<Role, number> = {
  reader: 0,
  writer: 1,
  admin: 2,
};
