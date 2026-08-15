/**
 * `core` -- the one architectural decision everything else hangs off.
 *
 * Every function in this directory takes `(ctx, input)`, returns data, or
 * throws `PrickError`. NONE of them know anything about HTTP: no Request, no
 * Response, no status codes, no headers, no Hono, no SvelteKit.
 *
 * The Hono routes under `../http/` and the SvelteKit server loads under
 * `src/routes/` are both thin transports over this. They call it IN-PROCESS --
 * there is no internal HTTP hop -- which is what lets a server load read data
 * without forwarding `CF-Access-JWT-Assertion` through `event.fetch` (which
 * does not forward arbitrary headers) or relying on the `CF_Authorization`
 * cookie (documented as not guaranteed to be passed).
 *
 * It is also why authorization is written exactly once.
 */

export * from "./context.js";
export * from "./errors.js";
export * from "./projects.js";
export * from "./environments.js";
export * from "./secrets.js";
export * from "./identities.js";
export * from "./audit.js";
export * from "./keyring.js";
