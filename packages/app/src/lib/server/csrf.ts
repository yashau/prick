/**
 * The admin UI's cross-site form guard, applied by `hooks.server.ts` to every
 * request outside `/api`.
 *
 * It is SvelteKit's own origin check, run from `handle` instead of from the
 * framework. SvelteKit applies its check to every path before any hook runs,
 * and in that position it refuses a bodiless `DELETE` from the CLI -- no
 * `Origin`, no `Content-Type` -- before the Hono app ever sees it. `/api` has
 * its own guard (`http/middleware.ts`), written for exactly those clients, so
 * the framework check is switched off in `vite.config.ts` and this one covers
 * the rest of the app with the framework's rule unchanged:
 *
 *   a POST, PUT, PATCH or DELETE
 *   whose media type is one a form can produce, or is absent,
 *   and whose `Origin` is not this app's own
 *
 * is refused with 403. A browser sets `Origin` on every request whose method is
 * not GET or HEAD, so a form action posted from this app always passes, and a
 * page anywhere else cannot.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The media types an HTML form can submit, plus SvelteKit's binary form type. */
const FORM_MEDIA_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/x-sveltekit-formdata",
]);

/** The media type with its parameters (`; charset=utf-8`) stripped. */
function mediaTypeOf(header: string): string {
  const [type = ""] = header.split(";");
  return type.trim().toLowerCase();
}

/** `true` when the request is a form submission another site initiated. */
export function isCrossSiteFormSubmission(request: Request, selfOrigin: string): boolean {
  if (!MUTATING_METHODS.has(request.method)) return false;
  if (request.headers.get("origin") === selfOrigin) return false;

  const contentType = request.headers.get("content-type");
  return !contentType || FORM_MEDIA_TYPES.has(mediaTypeOf(contentType));
}

/** The refusal, in the shape SvelteKit's own check answers with. */
export function crossSiteFormRefusal(request: Request): Response {
  const message = `Cross-site ${request.method} form submissions are forbidden`;

  if (request.headers.get("accept") === "application/json") {
    return Response.json({ message }, { status: 403 });
  }

  return new Response(message, { status: 403 });
}
