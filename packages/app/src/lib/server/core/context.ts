import type { IdentityKind, Role, ScopeType } from "@prick/shared";
import {
  BODY_MAX_BYTES,
  ENV_MAX_SECRETS,
  SECRET_VALUE_MAX_BYTES,
} from "@prick/shared";

import type { Keyring } from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { PrickError } from "./errors.js";

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

/**
 * A resolved authorization scope.
 *
 * RECONCILED (was: `auth/authorize.ts` declared a widened `AuthorizationScope`
 * locally because this type could not express an environment's project).
 *
 * A project-scoped grant covers every environment in that project, so resolving
 * an environment scope needs the environment's `project_id`. A caller that has
 * already loaded the environment row -- which is every caller in `core`, since
 * they all resolve the slug pair first -- knows it, and passing it here saves a
 * query per request. `projectId` is therefore OPTIONAL on the environment
 * variant: present when the caller knows it, looked up and memoised when not.
 *
 * With this field in place `AuthorizationScope` in `auth/authorize.ts` is
 * structurally identical to `Scope` and can be deleted; its `AuthorizationScope
 * | Scope` unions collapse to `Scope`. That edit belongs to the auth owner --
 * nothing here needs it to happen, because the two types already unify.
 */
export type Scope =
  | { type: Extract<ScopeType, "global"> }
  | { type: Extract<ScopeType, "project">; projectId: string }
  | {
      type: Extract<ScopeType, "environment">;
      environmentId: string;
      /** The environment's project. Optional; looked up when omitted. */
      projectId?: string;
    };

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
  /**
   * The master key ring, resolved ONCE per request by the fail-closed
   * middleware before any route runs.
   *
   * OPTIONAL on the type, and never optional in practice on a request path: the
   * middleware in `http/app.ts` refuses the request with 500
   * `SERVER_MISCONFIGURED` before a handler is reached if the ring cannot be
   * built, so a context that arrives at `revealSecret` without one is a wiring
   * bug rather than a configuration one. `requireKeyring()` below is what turns
   * that bug into a fail-closed 500 instead of a `TypeError` reading `.active`
   * of undefined.
   *
   * It is optional at the type level so that the many `core` functions with no
   * cryptography in them -- every projects, environments, identities and audit
   * call -- can be exercised from a context that never built one.
   */
  keyring?: Keyring;
}

/**
 * The keyring, or a fail-closed 500.
 *
 * Never returns `undefined`, so no call site has to decide what to do without
 * one. There is no sensible degraded mode for a secrets manager that cannot
 * find its master key: skipping decryption would return an environment with
 * some of its values missing, which is the exact failure this whole design
 * exists to make impossible.
 */
export function requireKeyring(ctx: CoreContext): Keyring {
  if (ctx.keyring === undefined) {
    throw new PrickError(
      "SERVER_MISCONFIGURED",
      "The master key ring was not resolved for this request.",
      {
        hint: "Every route must run behind the keyring middleware. This is a wiring bug, not a configuration one.",
      },
    );
  }

  return ctx.keyring;
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
  /**
   * Overrides the team-derived JWKS URL. RECONCILED (was: absent, and
   * `auth/access.ts` read `ACCESS_CERTS_URL` straight off `env` instead).
   *
   * OPTIONAL rather than required, for one mechanical reason: making it
   * required would be a compile error in the auth suite's fixtures module,
   * which builds a `RuntimeConfig` literal and is owned elsewhere.
   *
   * (Deliberately not naming that file's path. A sentinel test greps every
   * shipped source for references into the test tree, because a Worker that
   * mentions one is a Worker that might import one -- and the one seam that
   * makes the real JWT verifier testable, `ACCESS_CERTS_URL`, has to stay
   * configuration rather than a code path.)
   *
   * FOR THE AUTH OWNER, to finish the reconciliation:
   *   1. `accessOptionsFromEnv(env, now)` becomes `accessOptionsFromConfig(config, now)`,
   *      reading `config.accessTeam` / `.accessAud` / `.accessCertsUrl`. It
   *      then stops being the only place in the codebase that parses a `var`,
   *      and `AccessEnvLike` can go.
   *   2. This field becomes required and the `?` disappears.
   * Until then `loadRuntimeConfig()` populates it and nothing reads it, which
   * costs nothing and leaves the seam visible.
   */
  accessCertsUrl?: string | undefined;
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

// ---------------------------------------------------------------------------
// Parsing `vars`
// ---------------------------------------------------------------------------

/**
 * The `vars` this module reads, declared structurally.
 *
 * Not `Env`: `wrangler types` generates that from `wrangler.jsonc`, so it
 * describes the deployed configuration exactly and describes a test harness's
 * partial one not at all. Structural typing lets both satisfy it.
 */
export interface RuntimeConfigEnv {
  ACCESS_TEAM?: string | undefined;
  ACCESS_AUD?: string | undefined;
  ACCESS_CERTS_URL?: string | undefined;
  BOOTSTRAP_ADMINS?: string | undefined;
  REQUIRE_CTX_ACCESS?: string | undefined;
  SECRET_MAX_BYTES?: string | undefined;
  ENV_MAX_SECRETS?: string | undefined;
  BODY_MAX_BYTES?: string | undefined;
}

/**
 * A numeric `var`, or the shared default.
 *
 * A var that is present but unparseable is a REFUSAL, not a silent fallback.
 * `ENV_MAX_SECRETS: "5OO"` (letter O) falling back to 500 would look like it
 * worked; the operator who meant to lower the cap to 50 would never find out
 * that they had not.
 */
function numericVar(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw.trim());

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PrickError("SERVER_MISCONFIGURED", `${name} must be a positive integer.`, {
      hint: `Set ${name} in wrangler.jsonc to a positive integer, or remove it to use the default of ${String(fallback)}.`,
    });
  }

  return parsed;
}

/** A boolean `var`. Only the two literals; anything else is a refusal. */
function booleanVar(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;

  const normalised = raw.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;

  throw new PrickError("SERVER_MISCONFIGURED", `${name} must be "true" or "false".`, {
    hint: `${name} is a string var, so a JSON boolean in wrangler.jsonc arrives here as something else. Quote it.`,
  });
}

/**
 * Parse the comma-separated bootstrap admin list.
 *
 * Duplicated from `auth/bootstrap.ts:parseBootstrapAdmins` rather than imported,
 * to keep `core` free of an import from `auth` -- the dependency runs the other
 * way round everywhere else, and reversing it here would make the two directories
 * mutually recursive. The two implementations are three lines each and are
 * asserted to agree in `test/core/context.test.ts`.
 */
function parseAdmins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];

  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalised = entry.trim().toLowerCase();
    if (normalised !== "") seen.add(normalised);
  }

  return [...seen];
}

/**
 * Build the runtime config from Worker `vars`.
 *
 * Deliberately does NOT validate `ACCESS_TEAM` / `ACCESS_AUD` for emptiness:
 * `accessOptionsFromEnv` already fails closed on those at the point of use, and
 * duplicating the check here would mean `/health` -- which is unauthenticated by
 * design -- started failing on an Access misconfiguration that does not affect
 * it. The master key is the opposite case, and is handled by the middleware.
 */
export function loadRuntimeConfig(env: RuntimeConfigEnv): RuntimeConfig {
  const config: RuntimeConfig = {
    accessTeam: (env.ACCESS_TEAM ?? "").trim(),
    accessAud: (env.ACCESS_AUD ?? "").trim(),
    bootstrapAdmins: parseAdmins(env.BOOTSTRAP_ADMINS),
    requireCtxAccess: booleanVar(env.REQUIRE_CTX_ACCESS, "REQUIRE_CTX_ACCESS", false),
    secretMaxBytes: numericVar(env.SECRET_MAX_BYTES, "SECRET_MAX_BYTES", SECRET_VALUE_MAX_BYTES),
    envMaxSecrets: numericVar(env.ENV_MAX_SECRETS, "ENV_MAX_SECRETS", ENV_MAX_SECRETS),
    bodyMaxBytes: numericVar(env.BODY_MAX_BYTES, "BODY_MAX_BYTES", BODY_MAX_BYTES),
  };

  const certsUrl = env.ACCESS_CERTS_URL?.trim();
  if (certsUrl !== undefined && certsUrl !== "") config.accessCertsUrl = certsUrl;

  return config;
}
