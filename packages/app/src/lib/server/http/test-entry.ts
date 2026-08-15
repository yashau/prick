import { createApi } from "./app.js";

/**
 * Worker entry used ONLY by `vitest.config.ts`.
 *
 * `@cloudflare/vitest-pool-workers` points `main` here so the integration
 * suite runs the real Hono app against a real D1 in miniflare WITHOUT needing
 * a SvelteKit build first. A test run that depended on `vite build` would make
 * the crypto and write-path suites -- the ones that must be fastest and
 * greenest -- hostage to the UI build.
 *
 * This file must never be referenced from `wrangler.jsonc`. The deployed entry
 * is `.svelte-kit/cloudflare/_worker.js`.
 */
const api = createApi();

export default {
  fetch: api.fetch,
} satisfies ExportedHandler<Env>;
