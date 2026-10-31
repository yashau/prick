/**
 * The service tokens screen renders in the browser only.
 *
 * A create or a rotate answers with a client secret, the one copy of it that
 * will ever exist. With SSR off there is no server render and no
 * `__sveltekit_data` payload for that secret -- or the token list -- to be
 * serialised into: every request on this screen is a client `fetch` to
 * `/api/v1/service-tokens`, and the secret lives only in the page's component
 * state while its reveal panel is open. The same mechanism, and the same
 * reasoning, as `(app)/p/[project]/[env]/+layout.ts`.
 *
 * Corollary: no `+page.server.ts` or `+layout.server.ts` under this directory
 * may touch token data, and no form action here may return a secret. The shell
 * still receives the `(app)` layout's server data (projects, viewer, and the
 * `serviceTokens` capability), none of which is a secret.
 */
export const ssr = false;

/**
 * Prerendering stays off too: a prerendered shell is served from static assets
 * without invoking the Worker, which would skip its `no-store` headers and the
 * Access check in front of it.
 */
export const prerender = false;
