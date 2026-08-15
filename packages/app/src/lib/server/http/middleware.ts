import type { MiddlewareHandler } from "hono";

/**
 * `Cache-Control: no-store` for reveal/export responses.
 *
 * Bound to those routes specifically rather than applied globally, so the
 * choice is visible at each route rather than being an ambient property nobody
 * checks.
 *
 * Three headers, all necessary:
 *
 *   Cache-Control                  the browser and any intermediary
 *   Cloudflare-CDN-Cache-Control   Cloudflare's own edge cache, which does NOT
 *                                  necessarily follow Cache-Control
 *   Vary: Cf-Access-Jwt-Assertion  so a cached entry can never be served across
 *                                  identities
 */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
  c.header("Vary", "Cf-Access-Jwt-Assertion");
};

/**
 * Echo `X-Request-Id`.
 *
 * The id is stored on every audit row this request produces, which is the whole
 * point: a user pastes the id from an error toast into a support thread and an
 * admin finds the exact event, instead of correlating on a timestamp and a
 * guess.
 *
 * TODO(build order step 9): switch to `uuidv7()` once implemented, so a request
 * id sorts alongside the audit rows it produced. A client-supplied value is
 * accepted but length-bounded and pattern-checked -- it goes into a log line
 * and a database column.
 */
export const requestId: MiddlewareHandler<{ Variables: { requestId: string } }> = async (
  c,
  next,
) => {
  const supplied = c.req.header("X-Request-Id");
  const id = supplied && /^[A-Za-z0-9._-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

/**
 * TODO(build order step 10/11): authenticate, resolve the actor, build the
 * `CoreContext`.
 *
 * NOTE ON CORS -- there is none, deliberately.
 *
 * There is no CORS middleware in this app and there must never be one. Omitting
 * `Access-Control-Allow-Origin` entirely is what stops any other site on the
 * internet from reading a response from this API in a victim's browser, and the
 * browser enforces that for free. The UI is served from the same origin as the
 * API, so it needs nothing.
 */
