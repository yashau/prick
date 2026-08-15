import { fixtureApi } from "$lib/client/fixtures";

import type { PageServerLoad } from "./$types";

/**
 * The audit log.
 *
 * SERVER-RENDERED, and the filters live in the URL rather than in component
 * state. That is deliberate: "here is the exact query I was looking at" has to
 * be a link you can paste into a ticket, and the back button has to work while
 * you narrow a search down.
 *
 * Pagination is KEYSET, never OFFSET. The log is append-only and grows under
 * the reader, so every insert between two offset pages shifts the window by one
 * and silently skips a row -- a paginator that loses audit entries precisely
 * while something is happening is worse than one that fails outright. The
 * cursor is a UUIDv7 primary key, which is why ids are v7 and not
 * `crypto.randomUUID()`.
 *
 * FIXTURE SEAM -- becomes `core.queryAudit(ctx, query)` IN-PROCESS.
 */
export const load: PageServerLoad = async ({ url }) => {
  const params = url.searchParams;

  const since = params.get("since");
  const until = params.get("until");

  const filter = {
    ...(params.get("project") ? { project: params.get("project") as string } : {}),
    ...(params.get("environment") ? { environment: params.get("environment") as string } : {}),
    ...(params.get("actor") ? { actor: params.get("actor") as string } : {}),
    ...(params.get("action") ? { action: params.get("action") as string } : {}),
    ...(params.get("outcome")
      ? { outcome: params.get("outcome") as "success" | "denied" | "error" }
      : {}),
    ...(since ? { since: Number(since) } : {}),
    ...(until ? { until: Number(until) } : {}),
    ...(params.get("cursor") ? { cursor: params.get("cursor") as string } : {}),
    limit: 50,
  };

  const [page, projects] = await Promise.all([
    fixtureApi.queryAudit(filter),
    fixtureApi.listProjects(),
  ]);

  return { page, projects, filter };
};
