import { error, type Handle, type HandleServerError } from "@sveltejs/kit";

import { readAppearance, THEME_COOKIE, type Appearance } from "$lib/client/theme";
import {
  accessOptionsFromConfig,
  actorFromClaims,
  assertAdminsConfigured,
  assertCtxAccess,
  hydrateActor,
  isBootstrapAdmin,
  selfHealBootstrapGrant,
  upsertIdentity,
  verifyAccessRequest,
} from "$lib/server/auth";
import { loadRuntimeConfig, toPrickError, type CoreContext } from "$lib/server/core";
import { getKeyring, type MasterKeyEnv } from "$lib/server/crypto";
import { createDatabase, uuidv7 } from "$lib/server/db";
import { createApi } from "$lib/server/http/app";

/**
 * THE ARCHITECTURAL SEAM.
 *
 * One Worker, two transports:
 *
 *   /api/*  -> the Hono app
 *   else    -> SvelteKit
 *
 * Both call `src/lib/server/core/*` IN-PROCESS. There is no internal HTTP hop
 * between the UI and the API, and that is a deliberate design property rather
 * than an optimisation:
 *
 *   - `event.fetch` does not forward arbitrary headers, so a server load
 *     calling its own /api could not pass `CF-Access-JWT-Assertion` through,
 *     and the `CF_Authorization` cookie is documented as not guaranteed to be
 *     passed either. An internal hop would therefore have to re-solve
 *     authentication, badly.
 *   - Authorization gets written exactly once, in core. The failure mode where
 *     one handler checks scope and the handler next to it forgets is not
 *     something discipline prevents here -- it is unreachable, because both
 *     transports enter through the same function.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS TO THE SVELTEKIT HALF
 * ---------------------------------------------------------------------------
 * It is `http/context.ts:authenticate`, for the other transport: the ONE place
 * a SvelteKit request is authenticated, and the only place `event.locals.ctx`
 * is ever set. No load reads a header, decodes a token or touches
 * `event.platform.env`. They read `locals.ctx` and pass it to `core`, which
 * means a load physically has nothing to make an authorization decision WITH.
 *
 * The steps below are deliberately the SAME steps, in the SAME order, as the
 * Hono middleware. Where the two differ the difference is noted; anywhere else,
 * a divergence is a bug in this file rather than a local adaptation.
 */

const api = createApi();

/** `X-Request-Id`, echoed on the response and stored on every audit row. */
const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * `app.html`'s opening tag, VERBATIM. Editing it there means editing it here.
 *
 * THE WHOLE TAG, not the `<html` prefix, and that is a correction rather than
 * caution. `String.replace` with a string pattern rewrites the FIRST occurrence
 * in the document -- and the first occurrence of a short prefix is whatever
 * mentions it first, which the initial version of this discovered the hard way:
 * a comment above the tag explaining that the tag gets rewritten was itself the
 * thing that got rewritten, leaving the real element untouched and `lang="en"`
 * apparently missing from the served page.
 *
 * If the two ever disagree the replace is a no-op, the untransformed tag is
 * served, and the only symptom is the palette arriving one frame late. That is
 * the right failure: cosmetic, self-correcting on hydration, and impossible to
 * turn into malformed markup.
 */
const HTML_OPEN = '<html lang="en">';

/**
 * The opening tag, carrying what the server knows about the palette.
 *
 * `class="dark"` is the mechanism -- `app.css` defines the dark tokens under
 * `.dark` and Tailwind's dark variant is `&:is(.dark *)`, so the class on
 * `<html>` is what selects the palette for the whole document.
 *
 * `color-scheme` covers what CSS custom properties cannot: the canvas painted
 * before any stylesheet applies, scrollbars, and native form controls. With no
 * cookie it is `light dark`, which is the honest answer rather than a fallback
 * -- it tells the UA this page renders correctly either way, so those surfaces
 * follow the OS preference instead of being assumed light.
 *
 * `appearance` comes from `readAppearance`, a two-value allowlist. That matters
 * here and not merely for tidiness: the cookie cannot be `HttpOnly` (JavaScript
 * writes it), so its value is untrusted input being interpolated into a tag.
 * Nothing below escapes anything, because nothing above accepts anything that
 * would need escaping -- a cookie of `dark" onload="…` is UNRECOGNISED, not
 * sanitised.
 */
function htmlOpenFor(appearance: Appearance | null): string {
  const attributes =
    appearance === null
      ? 'style="color-scheme: light dark"'
      : appearance === "dark"
        ? 'class="dark" style="color-scheme: dark"'
        : 'style="color-scheme: light"';

  // Built FROM the anchor rather than restating it, so the tag being matched
  // and the tag being written cannot drift apart into a rewrite that finds
  // nothing or one that drops an attribute `app.html` carries.
  return HTML_OPEN.replace(">", ` ${attributes}>`);
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  const platform = event.platform;

  // In `vite dev` this is supplied by the adapter's platformProxy; in
  // production by the runtime. If it is missing, the bindings are missing, and
  // serving a request without a database or a master key would mean failing in
  // some more creative way further down.
  if (!platform) {
    throw error(503, "Cloudflare bindings are unavailable.");
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return api.fetch(event.request, platform.env, platform.ctx);
  }

  /*
   * GENERATED, never taken from the request.
   *
   * The Hono transport accepts a client-supplied `X-Request-Id` because its
   * clients are the CLI and CI, which correlate their own logs against ours.
   * Nothing on this side can: a browser navigation cannot set a header, and
   * SvelteKit's own `__data.json` fetches do not set this one. Honouring an
   * attacker-chosen id here would therefore only ever be a way to write a
   * chosen string into an audit row.
   */
  const requestId = uuidv7();

  event.locals.ctx = await createContext(event.request, platform, requestId);
  event.locals.actor = event.locals.ctx.actor;

  const appearance = readAppearance(event.cookies.get(THEME_COOKIE));

  const response = await resolve(event, {
    /*
     * Paint the right palette in the FIRST BYTE.
     *
     * Applied to every page, including the `ssr = false` secrets shell -- that
     * subtree renders no data, but it still renders `app.html`, and it is where
     * a flash is most visible because there is nothing else on screen yet.
     *
     * ATTRIBUTE INSERTION, NOT A `%placeholder%`. SvelteKit expands only its own
     * `%sveltekit.*%` tokens, so a custom one renders literally wherever this
     * transform does not run -- and there is such a path: an error thrown from
     * `handle` builds its response WITHOUT calling `resolve`. Inserting into
     * `<html` instead means the untransformed tag is the valid default, and the
     * anchor is the one substring of `app.html` that cannot drift.
     */
    transformPageChunk: ({ html }) => html.replace(HTML_OPEN, htmlOpenFor(appearance)),
  });

  response.headers.set(REQUEST_ID_HEADER, requestId);

  /*
   * The response varies on a cookie, so a shared cache must not serve one
   * visitor's palette to another. Cloudflare does not cache Worker HTML
   * responses by default, and this says so explicitly rather than relying on
   * that staying true.
   */
  response.headers.append("Vary", "Cookie");

  return response;
};

/**
 * Authenticate, and build the one object every load hands to `core`.
 *
 * THE ORDER OF THE STEPS IS LOAD-BEARING, and it is `http/context.ts`'s order:
 *
 *  1. The key ring and the parsed config, FAIL CLOSED, before anything else.
 *     A Worker whose `MASTER_KEY` decodes to 31 bytes cannot read or write a
 *     single value, and rendering a shell that looks fine would report the
 *     opposite of the truth.
 *  2. Verify the Access JWT. Failure is 401 and nothing else runs -- in
 *     particular no database row is touched, so an unauthenticated caller
 *     cannot make this Worker write anything at all.
 *  3. `assertCtxAccess`, defence in depth, gated behind `REQUIRE_CTX_ACCESS`.
 *     Called unconditionally because it returns immediately when the flag is
 *     off, and because `event.platform.ctx` -- unlike Hono's `c.executionCtx`
 *     -- does not throw when the runtime supplied none.
 *  4. Build the `CoreContext`. FRESH PER REQUEST, and the object identity
 *     matters: `resolveAuthorization` memoises the authorization snapshot in a
 *     `WeakMap` keyed by this exact reference, which is what makes a layout
 *     load and three page loads share one authorization query. A module-scope
 *     context would leak one caller's grants into another's request.
 *  5. `assertAdminsConfigured` -> 503 before the identity upsert, so an
 *     installation nobody can administer does not quietly accumulate identity
 *     rows while refusing every request.
 *  6. The identity upsert. `identities` is written HERE, on every authenticated
 *     request, because it is the only place a subject is ever seen -- and
 *     without that row a denied service token could never be granted anything,
 *     since `createGrant` takes an `identity_id`. Opening the admin UI in a
 *     browser is one of the two ways a subject first becomes visible, so this
 *     step is not optional on this transport either.
 *  7. `hydrateActor` fills in the two facts only the database knows,
 *     `identityId` and `bootstrap`. Mutated in place on the same `Actor` the
 *     context already holds, so the snapshot cache keyed on the context stays
 *     valid -- and so `locals.actor` and `locals.ctx.actor` stay one object.
 */
async function createContext(
  request: Request,
  platform: App.Platform,
  requestId: string,
): Promise<CoreContext> {
  const now = Date.now();

  try {
    // `MASTER_KEY` is a Worker SECRET, so `wrangler types` does not put it on
    // `Env` -- it only knows about `vars` and bindings declared in
    // wrangler.jsonc. `MasterKeyEnv` is structural for exactly this reason.
    const keyring = await getKeyring(platform.env as unknown as MasterKeyEnv);
    const config = loadRuntimeConfig(platform.env);

    const claims = await verifyAccessRequest(request, accessOptionsFromConfig(config, now));

    assertCtxAccess(platform.ctx, { requireCtxAccess: config.requireCtxAccess });

    const ctx: CoreContext = {
      db: createDatabase(platform.env.DB),
      actor: actorFromClaims(claims),
      requestId,
      now,
      config,
      keyring,
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

    return ctx;
  } catch (cause) {
    /*
     * The SvelteKit spelling of `http/errors.ts:toErrorBody`.
     *
     * `toPrickError` is what stops a `CryptoError` -- a bad master key, the one
     * failure an operator most needs named -- degrading into a bare 500 with a
     * generic message. Anything it does not classify becomes INTERNAL with a
     * CONSTANT message, because a throwable nothing classified is by definition
     * one whose `message` nobody has established the contents of.
     */
    const failure = toPrickError(cause);

    error(failure.status, {
      code: failure.wireCode,
      message: failure.message,
      requestId,
      ...(failure.hint === undefined ? {} : { hint: failure.hint }),
    });
  }
}

/**
 * Give an UNEXPECTED throwable the same shape `+error.svelte` renders for an
 * expected one.
 *
 * SvelteKit calls this only for errors that are not `error()` throws, so
 * everything arriving here escaped a load without being classified. The request
 * id is the reason it is worth doing: it is on the audit rows this request
 * wrote, so "paste me the id in the red box" stays a complete support
 * interaction even for a failure nobody anticipated.
 *
 * The message comes from `toPrickError`, which means an unclassified throwable
 * contributes the constant INTERNAL text and never its own -- this is the one
 * place a decrypt failure's or a database driver's message could otherwise
 * reach a rendered page.
 */
export const handleError: HandleServerError = ({ error: cause, event }) => {
  const failure = toPrickError(cause);

  // `Locals` declares both fields as non-optional because a LOAD is never
  // reached without them. This hook is: it also runs for failures raised before
  // `handle` finished populating them, so the read has to admit that.
  const ctx = (event.locals as Partial<App.Locals>).ctx;

  return {
    code: failure.wireCode,
    message: failure.message,
    ...(ctx === undefined ? {} : { requestId: ctx.requestId }),
    ...(failure.hint === undefined ? {} : { hint: failure.hint }),
  };
};
