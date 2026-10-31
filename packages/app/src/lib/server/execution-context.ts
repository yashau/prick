import { AsyncLocalStorage } from "node:async_hooks";

import type { ExecutionContext } from "hono";
import { waitUntil } from "cloudflare:workers";

/**
 * The runtime's per-request `ExecutionContext`, carried from the Worker entry
 * to `hooks.server.ts`.
 *
 * `@sveltejs/adapter-cloudflare` generates a Worker entry whose `fetch(req,
 * env)` hands SvelteKit the request and nothing else, so `ctx` -- and with it
 * `ctx.access`, the Access-on-Workers assertion `REQUIRE_CTX_ACCESS` checks --
 * would stop at the adapter. The build wraps that entry instead (the
 * `wrap-worker-entry` plugin in `vite.config.ts`): the wrapper calls
 * `withExecutionContext`, which runs each request inside this storage, and the
 * hook reads it back with `currentExecutionContext`. `/api` is handed the
 * runtime's own object, exactly as the Worker received it.
 *
 * The storage is registered on `globalThis` because two copies of this module
 * exist in a built Worker: one in the SvelteKit server bundle, which Vite
 * produces, and one in the wrapper, which wrangler bundles around it. Both must
 * name the same store or the hook would read an empty one.
 */

const STORAGE_KEY = Symbol.for("prick.executionContext");

type Registry = typeof globalThis & { [STORAGE_KEY]?: AsyncLocalStorage<ExecutionContext> };

const registry = globalThis as Registry;
const storage = (registry[STORAGE_KEY] ??= new AsyncLocalStorage<ExecutionContext>());

/**
 * The context `vite dev` runs under, where no wrapper exists: the adapter's
 * `platformProxy` serves the request and supplies `cloudflare:workers`. Its
 * `waitUntil` is bound to the request in flight. `access` is absent, so
 * `REQUIRE_CTX_ACCESS="true"` refuses every request here, which is the
 * fail-closed answer to a context that cannot vouch for Access.
 */
const devContext: ExecutionContext = {
  waitUntil,
  passThroughOnException() {},
  props: {},
};

/** The handler shape the adapter's generated entry exports. */
interface WorkerHandler<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}

/** Wraps a Worker handler so each request runs with its `ctx` in the storage. */
export function withExecutionContext<E>(handler: WorkerHandler<E>): WorkerHandler<E> {
  return {
    fetch(request, env, ctx) {
      return storage.run(ctx, () => handler.fetch(request, env, ctx));
    },
  };
}

/** The current request's `ExecutionContext`. */
export function currentExecutionContext(): ExecutionContext {
  return storage.getStore() ?? devContext;
}
