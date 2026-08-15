import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";

import { loadRuntimeConfig, type RuntimeConfig } from "../core/context.js";
import { PrickError, toPrickError } from "../core/errors.js";
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
 * Refuse an oversized body before it is read.
 *
 * Built per request rather than at mount time because the limit is a `var`
 * (`BODY_MAX_BYTES`) parsed by the keyring middleware above, and `bodyLimit`
 * takes a fixed number. Constructing it here costs an object per request and
 * keeps the limit configurable without a redeploy of this file's assumptions.
 *
 * This is the cheap outer bound -- `Content-Length`, before parsing. The
 * meaningful caps (`ENV_MAX_SECRETS`, `SECRET_MAX_BYTES`) are enforced in `core`
 * and in the schemas, where the units are secrets rather than bytes.
 */
export const bodyLimit: MiddlewareHandler<{
  Bindings: Env;
  Variables: KeyringVariables;
}> = (c, next) => {
  const maxSize = c.get("config").bodyMaxBytes;

  return honoBodyLimit({
    maxSize,
    onError: () => {
      throw new PrickError(
        "PAYLOAD_TOO_LARGE",
        `The request body exceeds the ${String(maxSize)} byte limit.`,
        {
          hint: "Split the write, or raise BODY_MAX_BYTES in wrangler.jsonc. A bulk write must still fit inside ENV_MAX_SECRETS.",
          detail: { limit: maxSize },
        },
      );
    },
  })(c, next);
};

// ---------------------------------------------------------------------------
// The reference viewer
// ---------------------------------------------------------------------------

/**
 * The exact Scalar bundle `/api/v1/docs` loads.
 *
 * PINNED TO A VERSION, and that is the whole point of naming it here. Scalar's
 * default `cdn` is an unversioned jsDelivr URL, which means "whatever is latest
 * when a browser asks" -- a dependency of this deployment that nothing in the
 * repository governs. `pnpm-workspace.yaml`'s `minimumReleaseAge` covers what
 * pnpm resolves at install time and has no reach over what a page fetches at
 * view time.
 *
 * jsDelivr serves versioned artefacts immutably, so a pinned URL is a fixed set
 * of bytes. It moves when somebody edits this line, which is the property a
 * secrets manager wants from every third party it executes.
 *
 * Matched to `@scalar/hono-api-reference` in `package.json` -- the two are
 * released together, and a viewer shell from one release driving a bundle from
 * another is a combination nobody has run.
 */
export const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.1";

/**
 * A content security policy for the docs page, and ONLY the docs page.
 *
 * `connect-src 'self'` is the clause that matters. The page's job is to fetch
 * one document from this origin and render it; with that clause a compromised
 * bundle has nowhere to send anything, which converts "third-party script on the
 * secrets manager's origin" from an exfiltration primitive into a defacement
 * one. `form-action` and `base-uri` close the two ways a script gets data out
 * without `fetch`.
 *
 * `'unsafe-inline'` on scripts and styles is unavoidable: Scalar's shell renders
 * an inline configuration block and injects styles at runtime. A nonce would be
 * better and the integration does support one, but the nonce would have to reach
 * the inline block Scalar itself emits -- which it does, via its `nonce` option,
 * and is the obvious next hardening step if this page grows in importance.
 *
 * Bound to this route rather than applied globally, because it is wrong for
 * every other route: the API returns JSON to non-browser clients, and the admin
 * UI has its own policy from `svelte.config.js`.
 */
export const docsCsp: MiddlewareHandler = async (c, next) => {
  await next();

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src ${SCALAR_CDN_ORIGIN} 'unsafe-inline'`,
      `style-src ${SCALAR_CDN_ORIGIN} 'unsafe-inline'`,
      `font-src ${SCALAR_CDN_ORIGIN} data:`,
      "img-src 'self' data:",
      // The one that matters: the page may talk to this origin and nowhere else.
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
};

const SCALAR_CDN_ORIGIN = "https://cdn.jsdelivr.net";

// ---------------------------------------------------------------------------
// ETag / If-Match over the environment revision
// ---------------------------------------------------------------------------

/**
 * The entity tag for an environment at revision `rev`.
 *
 * The revision IS the tag. `environments.rev` is bumped by exactly one statement
 * -- the first in every secrets batch -- so it already is a monotonic version of
 * the whole secret collection, and deriving a hash of the listing instead would
 * produce a tag that changes when nothing did (a re-read after a rekey) and,
 * worse, one that `core`'s optimistic-concurrency guard cannot compare against.
 * The guard is `expected_rev`; the ETag has to be the same number or the two
 * mechanisms disagree.
 *
 * A STRONG tag, deliberately. `W/` would signal "semantically equivalent", and
 * `If-Match` on a weak tag is not allowed to be used for a conditional write --
 * which is the only thing this tag exists for.
 */
export function revisionEtag(rev: number): string {
  return `"${String(rev)}"`;
}

const ETAG_PATTERN = /^(?:W\/)?"(\d{1,15})"$/;

/**
 * Parse `If-Match` into an `expected_rev`, or `undefined` for "no condition".
 *
 * Handled cases, and why each is what it is:
 *
 *   absent      -> `undefined`. An unconditional write. This is the normal case
 *                  for a merge of one key, where there is no read-modify-write
 *                  to lose a race on.
 *   `*`         -> `undefined`. RFC 9110 defines `*` as "any current
 *                  representation", i.e. a guard on EXISTENCE only. The
 *                  environment was already resolved by the time a write runs, so
 *                  it exists, and there is nothing further to assert.
 *   `"3"`       -> `3`. The revision guard.
 *   a LIST      -> 400. `If-Match: "3", "4"` means "any of these", and `core`'s
 *                  guard is a single-value equality test -- there is no honest
 *                  way to express a disjunction as `expected_rev`, and silently
 *                  taking the first element would apply a guard the caller did
 *                  not ask for.
 *   anything else -> 400. Not a silent fallback to unconditional: a client that
 *                  sent a malformed precondition believes it is writing
 *                  conditionally, and answering 200 to that is the failure this
 *                  header exists to prevent.
 */
export function expectedRevFromIfMatch(c: Context): number | undefined {
  const header = c.req.header("If-Match")?.trim();

  if (header === undefined || header === "") return undefined;
  if (header === "*") return undefined;

  const match = ETAG_PATTERN.exec(header);

  if (match === null) {
    throw new PrickError("BAD_REQUEST", "The If-Match header is not a single entity tag.", {
      hint: 'Send the ETag from the most recent GET of this collection verbatim, for example If-Match: "3". A list of tags is not supported.',
    });
  }

  return Number(match[1]);
}

/**
 * Reconcile `If-Match` with a body-level `expected_rev`.
 *
 * Two spellings of one guard, so they are allowed to be used together only when
 * they agree. Disagreement is a 400 rather than a precedence rule: a precedence
 * rule means one of the two silently does nothing, and the caller who sent both
 * did so because they wanted the guard applied.
 */
export function reconcileExpectedRev(
  fromHeader: number | undefined,
  fromBody: number | undefined,
): number | undefined {
  if (fromHeader === undefined) return fromBody;
  if (fromBody === undefined) return fromHeader;

  if (fromHeader !== fromBody) {
    throw new PrickError(
      "BAD_REQUEST",
      "If-Match and expected_rev disagree about which revision to write against.",
      { hint: "Send one or the other, or send the same revision in both." },
    );
  }

  return fromBody;
}

/**
 * The `MasterKeyConfigError` a bad key throws is a `CryptoError`, not a
 * `PrickError`, so it would otherwise reach `onError` as an unclassified
 * throwable and degrade to a bare INTERNAL with a generic message -- losing
 * exactly the text that tells the operator what is wrong with their key.
 *
 * Exported so the error handler can normalise it in one place.
 */
export { toPrickError };
