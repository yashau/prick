/**
 * ================================================================
 * THE SECURITY BOUNDARY. This one line is the mechanism, not a hint.
 * ================================================================
 *
 * Everything below this layout is the secrets subtree, and it is the only part
 * of the app that can ever hold a decrypted value. Turning SSR off here means:
 *
 *   - no server render of these pages,
 *   - therefore no `__sveltekit_data` payload embedded in the HTML,
 *   - therefore nothing for a value to leak into.
 *
 * Values are fetched from `/api/v1` by the browser, held only in the
 * `reveal.svelte.ts` rune store (a SvelteMap with a 30 s expiry), and wiped by
 * `idle.svelte.ts` after 15 minutes idle. Never in a page store, never in
 * `localStorage`, never in a service worker cache -- there is no service
 * worker, and `worker-src 'none'` in the CSP makes registering one fail.
 *
 * Two corollaries that are easy to violate by accident:
 *
 *   1. NO `+page.server.ts` / `+layout.server.ts` under this directory may
 *      touch a value. CI greps every `+*.server.ts` module for
 *      `revealSecret|exportSecrets|decrypt` and fails on a hit.
 *   2. NO form action here may RETURN a secret value. SvelteKit serialises an
 *      action's return value into page data, which would put the value right
 *      back into the payload this file exists to keep empty. Form actions are
 *      for projects, environments and grants only -- which is why there is not
 *      a single `+page.server.ts` anywhere in this subtree, and why every
 *      mutation on these screens goes through a client `fetch`.
 */
export const ssr = false;

/**
 * Prerendering must stay off as well, and for a different reason.
 *
 * `ssr = false` is about not RENDERING these pages on the server. Prerendering
 * would additionally freeze a shell of them into the static assets bundle,
 * which Cloudflare serves WITHOUT invoking the Worker -- so the Hono
 * `Cache-Control: no-store` middleware and the Access check in front of the
 * Worker would both be bypassed for that response. Stated explicitly rather
 * than relying on the default.
 */
export const prerender = false;
