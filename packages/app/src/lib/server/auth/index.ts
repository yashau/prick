/**
 * Cloudflare Access authentication and prick's own authorization.
 *
 * The split is deliberate and total: Access says WHO the caller is, and nothing
 * in this directory ever takes that on trust from a header a client controls.
 * Everything about WHAT they may do is ours, lives in D1, and is resolved once
 * per request through one code path with no shortcut for any identity kind.
 */

export * from "./claims.js";
export * from "./jwks.js";
export * from "./access.js";
export * from "./authorize.js";
export * from "./bootstrap.js";
