import type { Context, MiddlewareHandler } from "hono";

import {
  accessOptionsFromConfig,
  actorFromClaims,
  assertAdminsConfigured,
  assertCtxAccess,
  hydrateActor,
  isBootstrapAdmin,
  scheduleAccessDisplayNameSync,
  selfHealBootstrapGrant,
  upsertIdentity,
  verifyAccessRequest,
} from "../auth/index.js";
import type { CoreContext } from "../core/context.js";
import { createDatabase } from "../db/client.js";
import type { ApiEnv } from "./env.js";

/**
 * Authentication, and the construction of the ONE object every route hands to
 * `core`.
 *
 * This middleware is the entire authentication surface of the HTTP transport.
 * No route reads a header, decodes a token, or looks at `c.env` -- they read
 * `c.get("core")` and pass it on. That is what makes "authorization is written
 * once, in core" true of this layer rather than aspirational: a route physically
 * has nothing to make an authorization decision WITH.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THE STEPS BELOW IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 *  1. Verify the Access JWT. Failure is 401 and nothing else runs -- in
 *     particular no database row is touched, so an unauthenticated caller cannot
 *     make this Worker write anything at all.
 *
 *  2. `assertCtxAccess`, defence in depth, gated behind `REQUIRE_CTX_ACCESS`
 *     which is `false` until Access-on-Workers is documented and confirmed not
 *     to swallow service-token requests.
 *
 *  3. Build the `CoreContext`. FRESH PER REQUEST, and the object identity
 *     matters: `resolveAuthorization` memoises the authorization snapshot in a
 *     `WeakMap` keyed by this exact reference, which is what makes a 200-secret
 *     operation perform one authorization query instead of two hundred. A
 *     module-scope context would leak one caller's grants into another's
 *     request.
 *
 *  4. `assertAdminsConfigured` -> 503 `NO_ADMINS_CONFIGURED` when neither
 *     `BOOTSTRAP_ADMINS` nor a usable global admin grant exists. Before the
 *     identity upsert, so an installation nobody can administer does not quietly
 *     accumulate identity rows while refusing every request.
 *
 *  5. The identity upsert, and this is the step that is easy to leave out and
 *     expensive to leave out. `identities` is written HERE, on every
 *     authenticated request, because it is the only place a subject is ever
 *     seen: Access mints service tokens and we learn a `common_name` exists only
 *     when one arrives. Without this row a denied service token could never be
 *     granted anything -- `createGrant` takes an `identity_id`, and the
 *     "Seen but not granted" screen exists precisely to turn a denial into a
 *     grant in one click. It also maintains `last_seen_at`, which is how an
 *     operator finds the token that has not been used in a year.
 *
 *     A bootstrap admin takes the self-heal path instead, which upserts the
 *     identity itself and additionally converts the var into a real, revocable
 *     grant. Both branches must run BEFORE step 6, because `hydrateActor`
 *     resolves and CACHES the snapshot -- caching it first would report the
 *     actor as having no identity on the very request that created one.
 *
 *  6. `hydrateActor` fills in the two facts only the database knows,
 *     `identityId` and `bootstrap`. Mutated in place on the same `Actor` object
 *     the context already holds, so the snapshot cache keyed on the context
 *     stays valid.
 */
export interface CoreVariables {
  core: CoreContext;
}

export const authenticate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const config = c.get("config");
  const now = Date.now();

  const claims = await verifyAccessRequest(c.req.raw, accessOptionsFromConfig(config, now));

  if (config.requireCtxAccess) {
    // Only reached when the var is on. `c.executionCtx` throws when the runtime
    // did not supply one, and reading it unconditionally would turn a disabled
    // feature into a crash on any transport that omits it.
    assertCtxAccess(c.executionCtx, { requireCtxAccess: true });
  }

  const ctx: CoreContext = {
    db: createDatabase(c.env.DB),
    actor: actorFromClaims(claims),
    requestId: c.get("requestId"),
    now,
    config,
    keyring: c.get("keyring"),
  };

  await assertAdminsConfigured(ctx);

  if (isBootstrapAdmin(config, ctx.actor.subject)) {
    await selfHealBootstrapGrant(ctx);
  } else {
    await upsertIdentity(ctx);
  }

  const hydrated = await hydrateActor(ctx);
  ctx.actor.identityId = hydrated.identityId;
  ctx.actor.bootstrap = hydrated.bootstrap;
  ctx.actor.displayName = hydrated.displayName;

  scheduleAccessDisplayNameSync(ctx, c.req.raw, executionCtxWaitUntil(c));

  c.set("core", ctx);

  await next();
};

/**
 * `c.executionCtx.waitUntil`, or `undefined` when there is no execution context.
 *
 * Reading `c.executionCtx` THROWS rather than returning undefined when the
 * runtime supplied none -- the same trap the `requireCtxAccess` branch above
 * documents. A background task is optional, so the throw is caught and the
 * caller simply gets no `waitUntil`.
 */
function executionCtxWaitUntil(c: Context<ApiEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx;
    return executionCtx.waitUntil.bind(executionCtx);
  } catch {
    return undefined;
  }
}

/** The request's `CoreContext`. Only ever set by `authenticate` above. */
export function core(c: Context<ApiEnv>): CoreContext {
  return c.get("core");
}
