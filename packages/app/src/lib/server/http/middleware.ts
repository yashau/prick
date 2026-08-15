import type { MiddlewareHandler } from "hono";

import { loadRuntimeConfig, type RuntimeConfig } from "../core/context.js";
import { toPrickError } from "../core/errors.js";
import { getKeyring, type Keyring, type MasterKeyEnv } from "../crypto/index.js";
import { uuidv7 } from "../db/ids.js";

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
 * The generated id is a UUIDv7, so it sorts alongside the audit rows it
 * produced -- `crypto.randomUUID()` is v4 and would sort arbitrarily against
 * the very rows it is supposed to help you find.
 *
 * A client-supplied value is accepted, but length-bounded and pattern-checked:
 * it goes into a log line and a database column, and neither should be able to
 * carry a newline.
 */
export const requestId: MiddlewareHandler<{ Variables: { requestId: string } }> = async (
  c,
  next,
) => {
  const supplied = c.req.header("X-Request-Id");
  const id = supplied && /^[A-Za-z0-9._-]{1,64}$/.test(supplied) ? supplied : uuidv7();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

export interface KeyringVariables {
  keyring: Keyring;
  config: RuntimeConfig;
}

/**
 * FAIL CLOSED. Resolve the keyring and the parsed config before ANY route runs.
 *
 * Mounted with `app.use("*", ...)` AHEAD of every route mount, including
 * `/health`. That placement is the whole feature, and it is worth being explicit
 * about why `/health` is not exempted despite being the one endpoint that
 * plausibly should answer when everything else is broken:
 *
 * `prk login <url>` probes `/health` first, and the deployment guide tells an
 * operator to curl it after a deploy. A secrets manager whose `MASTER_KEY`
 * decodes to 31 bytes is a secrets manager that cannot read or write a single
 * value -- and if `/health` answers `{"status":"ok"}` anyway, the deploy looks
 * successful, the CI job that follows it looks successful, and the failure
 * surfaces hours later as a decrypt error on a production read. Answering 200
 * there is not "degraded but useful"; it is reporting the opposite of the truth.
 *
 * So: no exemptions, no partial boot, no lazy first-use derivation. Either the
 * root of trust is loadable or this Worker serves 500 to everything.
 *
 * The ring itself is memoised per isolate inside `buildKeyring`, so this costs
 * two HKDF derivations once and a map lookup thereafter -- the middleware is not
 * re-deriving a key on every request.
 */
export const keyring: MiddlewareHandler<{
  Bindings: Env;
  Variables: KeyringVariables;
}> = async (c, next) => {
  // `MASTER_KEY` is a Worker SECRET, so `wrangler types` does not put it on
  // `Env` -- it only knows about `vars` and bindings declared in
  // wrangler.jsonc. `MasterKeyEnv` is structural for exactly this reason.
  const ring = await getKeyring(c.env as unknown as MasterKeyEnv);

  // Parsed here rather than per route, and parsed AFTER the ring: a bad numeric
  // var and a bad master key are both fail-closed, but the master key is the one
  // an operator most needs named first.
  const config = loadRuntimeConfig(c.env);

  c.set("keyring", ring);
  c.set("config", config);

  await next();
};

/**
 * The `MasterKeyConfigError` a bad key throws is a `CryptoError`, not a
 * `PrickError`, so it would otherwise reach `onError` as an unclassified
 * throwable and degrade to a bare INTERNAL with a generic message -- losing
 * exactly the text that tells the operator what is wrong with their key.
 *
 * Exported so the error handler can normalise it in one place.
 */
export { toPrickError };
