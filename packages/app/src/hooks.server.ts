import { error, type Handle } from "@sveltejs/kit";

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
 */

const api = createApi();

export const handle: Handle = ({ event, resolve }) => {
  const { pathname } = event.url;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const platform = event.platform;

    // In `vite dev` this is supplied by the adapter's platformProxy; in
    // production by the runtime. If it is missing, the bindings are missing,
    // and serving an API request without a database or a master key would mean
    // failing in some more creative way further down.
    if (!platform) {
      throw error(503, "Cloudflare bindings are unavailable.");
    }

    return api.fetch(event.request, platform.env, platform.ctx);
  }

  return resolve(event);
};
