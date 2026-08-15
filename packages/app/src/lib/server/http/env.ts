import type { RuntimeConfig } from "../core/context.js";
import type { Keyring } from "../crypto/index.js";
import type { CoreVariables } from "./context.js";

/**
 * The Hono environment every router in this tree is generic over.
 *
 * It lives in its own module rather than in `app.ts` so that a route file can
 * name it without importing the application that mounts it. The imports would be
 * type-only and therefore erased, so the cycle would never exist at runtime --
 * but a cycle that is invisible in the emitted bundle is exactly the kind that
 * survives until someone adds one value import to close it.
 *
 * The three variables are set by three middlewares, in this order, and a route
 * may assume all three: `requestId` (always, even while failing closed),
 * `keyring` + `config` (the fail-closed middleware, ahead of every mount), and
 * `core` (authentication, on everything except `/health`).
 */
export interface ApiEnv {
  Bindings: Env;
  Variables: CoreVariables & {
    requestId: string;
    keyring: Keyring;
    config: RuntimeConfig;
  };
}
