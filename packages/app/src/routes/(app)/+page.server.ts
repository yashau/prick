import type { PageServerLoad } from "./$types";

export interface ProjectRow {
  slug: string;
  name: string;
  description: string | null;
  environmentCount: number;
}

/**
 * The projects screen is SERVER-RENDERED, and it is allowed to be because it
 * carries no secret values -- only names, slugs and counts.
 *
 * The rule this sits inside: SSR is the default, and `ssr = false` is applied
 * to exactly one subtree (the secrets pages). See
 * `(app)/p/[project]/[env]/+layout.ts`.
 *
 * TODO(build order step 15): call `core.listProjects(ctx)` IN-PROCESS from
 * here. Build the CoreContext from `event.platform.env` plus the verified
 * Access actor -- do NOT `event.fetch('/api/v1/projects')`: that hop cannot
 * forward `CF-Access-JWT-Assertion`, and it would duplicate the authorization
 * that core already performs.
 *
 * CI ENFORCES what must not appear in this file: a test greps every
 * `+*.server.ts` module for `revealSecret|exportSecrets|decrypt` and fails the
 * build on a hit. A server load that decrypts anything puts plaintext in the
 * `__sveltekit_data` payload of a rendered page.
 */
export const load: PageServerLoad = () => {
  const projects: ProjectRow[] = [];
  return { projects };
};
