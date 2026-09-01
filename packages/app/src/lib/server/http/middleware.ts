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
// Cross-site writes
// ---------------------------------------------------------------------------

/**
 * Methods that cannot change anything, and are therefore not guarded.
 *
 * `OPTIONS` is in the list because nothing answers it: there is no CORS
 * middleware, so a preflight falls through to `notFound` and a cross-origin
 * request that needed one never happens. Guarding it would only turn that 404
 * into a 403 and say more than the 404 does.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The one media type a request body may declare. */
const JSON_MEDIA_TYPE = "application/json";

/** The media type with its parameters (`; charset=utf-8`) stripped. */
function mediaTypeOf(header: string): string {
  const [type = ""] = header.split(";");
  return type.trim().toLowerCase();
}

/**
 * REFUSE A CROSS-SITE WRITE, WITHOUT TRUSTING THE DEPLOYMENT'S COOKIE SETTINGS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLOSES
 * ---------------------------------------------------------------------------
 * `extractAssertion` falls back to the ambient `CF_Authorization` cookie, which
 * is what makes the admin UI work without the browser ever handling a token. A
 * browser attaches that cookie to a CROSS-SITE form post too, if the Access
 * application's cookie is `SameSite=None` -- a setting that lives in the
 * Cloudflare dashboard, not in this repository, so nothing here can assert it.
 *
 * The absence of CORS (see `app.ts`) stops another site READING a response. It
 * does nothing about a write: an auto-submitting `<form method=post>` needs no
 * response at all, and it is exempt from preflight because its media type is
 * one of the three a form can produce.
 *
 * And such a body is not even rejected on its way in. Hono's `json` validator
 * checks `Content-Type` and, on a mismatch, hands the schema `{}` rather than
 * failing -- so any schema whose every field is optional or defaulted validates
 * a form post as a legitimate call and the handler runs. `RekeyBody` is one:
 * `{}` becomes `{ limit: REKEY_MAX_PAGE }`, and a global admin's browser
 * re-encrypts a page of rows and writes an audit row attributed to them.
 * (`BatchBody` happens to be refused, by a refine that requires `set` or
 * `delete` on a merge -- "happens to be" being exactly the problem: the
 * transport is where that has to be settled, not one schema's invariant.)
 *
 * ---------------------------------------------------------------------------
 * TWO CHECKS, AND WHY BOTH
 * ---------------------------------------------------------------------------
 * ORIGIN. A browser sets `Origin` on every cross-origin request AND on every
 * same-origin request whose method is not GET or HEAD; a non-browser client
 * sets it on none. So "present and not ours" is precisely "a page somewhere
 * else initiated this", and "absent" is precisely "not a browser" -- which is
 * the CLI, the MCP server and the composite action, none of which send the
 * header. This is the same bet `svelte.config.js` makes for the SvelteKit half
 * with `csrf.trustedOrigins: []`, and it is made here rather than inherited
 * because the two halves are different servers behind one hostname.
 *
 * `URL.origin` is the right thing to compare against and not an approximation
 * of one: it keeps a non-default port and drops a default one, which is exactly
 * how a browser spells `Origin`. That is what makes the check hold on
 * `http://localhost:8787` under `wrangler dev` as well as on production https,
 * and the e2e suite exercises the former through a real browser.
 *
 * MEDIA TYPE. Belt to the origin check's braces, and independently a bug fix:
 * `application/json` is not a type a cross-site form can produce and not one a
 * `no-cors` fetch is allowed to set, so requiring it refuses the same attack
 * through a second mechanism -- and it stops a WRONGLY LABELLED body from
 * silently validating as `{}` for any caller, browser or not.
 *
 * ORDER: origin first. A cross-site request fails both checks, and answering
 * 415 would imply that correcting the media type is what it takes to be
 * accepted. It is not.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION READS THE METHOD AND TWO HEADERS. NOTHING ELSE. EVER.
 * ---------------------------------------------------------------------------
 * In particular it does NOT ask whether a body is present, and that is a
 * correction rather than an omission. An earlier version refused a body that
 * declared no media type at all, framing "is there a body" on
 * `c.req.raw.body !== null`. That expression is not the same fact in the two
 * places this Worker runs:
 *
 *   in-process   `vitest-pool-workers`, and any `SELF.fetch` -- a bodiless
 *                DELETE has `body === null`, so the check passed.
 *   over the wire workerd hands the Worker a non-null, empty body stream for
 *                the SAME bodiless DELETE, so the check answered 415.
 *
 * So it 415'd every `DELETE` that actually crossed a socket -- `prk access
 * revoke`, group deletion, group member removal -- in the SHIPPED product,
 * while every in-process test went green. `Content-Length` is no better a
 * signal: a string-bodied `Request` built in-process carries none at all, so
 * framing on it inverts the test instead of the behaviour.
 *
 * The rule that follows is absolute: this guard may only read facts that are
 * byte-identical in both runtimes, which means the request line and the
 * headers. `test/http/csrf.test.ts` reproduces the wire shape in-process (a
 * `ReadableStream` body declares no media type, exactly as workerd's empty
 * stream does) and asserts `raw.body` is never named in this tree.
 *
 * WHAT DROPPING THAT CHECK COSTS, precisely. A request with no `Content-Type`
 * is, per RFC 9110, a request asserting it has no content -- and that is
 * already how Hono's validator reads it, so guard and validator now agree
 * instead of disagreeing. The CSRF defence is untouched: a browser sets
 * `Origin` on EVERY request whose method is not GET or HEAD, with no exception
 * and no way for the initiating page to suppress it, so a cross-site write is
 * refused on the origin whatever it declares -- including the one shape that
 * could omit a media type, a `no-cors` fetch of a `Blob` whose `type` is empty.
 * What is given up is one belt-and-braces case for CREDENTIALED NON-BROWSER
 * callers: a client that sends a body and labels it with nothing now reaches
 * the schema, which sees `{}` and answers 422 wherever a field is required. On
 * a route whose every field is defaulted it would run -- `RekeyBody` is the
 * only one -- which is a broken client holding a valid credential, not a
 * stranger's page. Pinned as such in the test file rather than left implicit.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS A LEGITIMATE CLIENT
 * ---------------------------------------------------------------------------
 * Nothing, and that was checked against each of them rather than assumed:
 * `prick-api`'s Rust client builds every API body with reqwest's `.json()`
 * (`Body::Form` reaches Access's OAuth token endpoint only, never `/api`), the
 * MCP server sets `Content-Type: application/json` whenever it has a body, the
 * composite action spawns the CLI, and `lib/client/api.ts` sets the header in
 * the browser. None of the three non-browser clients sends `Origin` at all.
 *
 * A bodiless request -- every `DELETE` in this API -- declares no media type
 * and is not required to. There is nothing to parse, so there is no wrong way
 * to have labelled it; the origin check is what covers those, and it covers
 * them completely, because a `<form>` can only issue GET and POST.
 */
export const crossSiteGuard: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header("Origin");

    // `Origin: null` -- a sandboxed frame, or a cross-origin redirect -- is a
    // browser telling us it will not name the initiator. It is not ours.
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      throw new PrickError(
        "FORBIDDEN",
        "A state-changing request may not come from another origin.",
        {
          hint: "This API is same-origin for browsers and credential-bearing for everything else. A cross-origin caller wants an Access service token and a server-side request, which is what the CLI and the MCP server use.",
        },
      );
    }

    const declared = c.req.header("Content-Type");

    if (declared !== undefined && mediaTypeOf(declared) !== JSON_MEDIA_TYPE) {
      throw unsupportedMediaType(mediaTypeOf(declared));
    }
  }

  await next();
};

/**
 * `type/subtype` in RFC 9110's token grammar, and short.
 *
 * Anything else is not echoed. A media type is a fixed vocabulary chosen by the
 * client's HTTP stack rather than caller data, so naming it is what makes the
 * failure fixable -- but the header is still a string an attacker controls, and
 * it reaches a response body and a log line. Same reasoning as `requestId`
 * above: pattern-check, bound, and replace what does not match.
 */
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/;

/** The 415, with the offending type named when it is safe to name. */
function unsupportedMediaType(found: string): PrickError {
  const described = MEDIA_TYPE_PATTERN.test(found) ? found : "something else";

  return new PrickError(
    "UNSUPPORTED_MEDIA_TYPE",
    `A request body must be ${JSON_MEDIA_TYPE}; this one declared ${described}.`,
    {
      hint: `Send Content-Type: ${JSON_MEDIA_TYPE}, or send no body and no Content-Type at all. A body in any other encoding is not read -- it would reach the schema as an empty object and write something nobody asked for.`,
      detail: { expected: JSON_MEDIA_TYPE },
    },
  );
}

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
