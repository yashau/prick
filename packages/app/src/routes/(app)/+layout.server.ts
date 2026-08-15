import { fixtureApi, fixtureViewer } from "$lib/client/fixtures";

import type { LayoutServerLoad } from "./$types";

/**
 * The shell's data: who is looking, and what they can navigate to.
 *
 * SERVER-RENDERED, and allowed to be, because none of it is a secret value --
 * only slugs, display names and counts. That is the whole rule: SSR is the
 * default and `ssr = false` is applied to exactly one subtree, the secrets
 * pages. See `(app)/p/[project]/[env]/+layout.ts`.
 *
 * A note on what this load must never grow: CI greps every `+*.server.ts`
 * module for `revealSecret|exportSecrets|decrypt` and fails the build on a
 * hit. A server load that decrypts anything puts plaintext into the
 * `__sveltekit_data` payload of a rendered page, where it survives in the HTML
 * source, in the back/forward cache, and in any proxy that logged the body.
 *
 * FIXTURE SEAM -- `/api/v1` and most of `core` are being built in parallel.
 * When they land this becomes:
 *
 *   import * as core from "$lib/server/core";
 *   const ctx = createContext(event);           // db + verified actor
 *   const projects = await core.listProjects(ctx);
 *
 * IN-PROCESS, never `event.fetch('/api/v1/projects')`: that hop cannot forward
 * `CF-Access-JWT-Assertion`, the `CF_Authorization` cookie is documented as not
 * guaranteed to be passed, and it would re-solve authorization a second, worse
 * time.
 */
export const load: LayoutServerLoad = async () => {
  const projects = await fixtureApi.listProjects();

  return {
    projects,
    viewer: fixtureViewer,
  };
};
