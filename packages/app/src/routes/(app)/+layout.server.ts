import { listProjects } from "$lib/server/core";

import { refuse, viewer } from "./transport";
import type { LayoutServerLoad } from "./$types";

/**
 * The shell's data: who is looking, and what they can navigate to.
 *
 * SERVER-RENDERED, and allowed to be, because none of it is a secret value --
 * only slugs, display names and counts. That is the whole rule: SSR is the
 * default and `ssr = false` is applied to exactly one subtree, the secrets
 * pages. See `(app)/p/[project]/[env]/+layout.ts`.
 *
 * A note on what this load must never grow: a server load that decrypts
 * anything puts plaintext into the `__sveltekit_data` payload of a rendered
 * page, where it survives in the HTML source, in the back/forward cache, and in
 * any proxy that logged the body. `e2e/tests/ssr-boundary.spec.ts` asserts on
 * the raw HTML of both a secrets page and a server-rendered one, so the
 * property is checked against what is actually served rather than against what
 * this comment claims.
 *
 * IN-PROCESS, never `event.fetch('/api/v1/projects')`: that hop cannot forward
 * `CF-Access-JWT-Assertion`, the `CF_Authorization` cookie is documented as not
 * guaranteed to be passed, and it would re-solve authorization a second, worse
 * time. `locals.ctx` is the same `CoreContext` shape the Hono routes build, so
 * `listProjects` cannot tell which transport called it.
 *
 * `listProjects` scopes to the visible set IN THE QUERY, so this list is also
 * what the project switcher and the command palette may show. It is not
 * filtered afterwards and must not be.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  try {
    return {
      projects: await listProjects(locals.ctx),
      viewer: await viewer(locals.ctx),
    };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};
