/**
 * Schemas and constants shared by the Worker (Hono routes + core) and the
 * SvelteKit UI.
 *
 * This package is the single definition of the wire format. The Worker
 * validates inbound requests with it; the UI builds outbound requests against
 * the inferred types. A field cannot be added on one side only.
 *
 * It is source-only (`exports` points at `.ts`) and consumed exclusively
 * through the workspace link, so there is no build step and no `dist/` to go
 * stale.
 */

export * from "./limits.js";
export * from "./primitives.js";
export * from "./api.js";
