import type { AuditQuery } from "@prick/shared";

import type { ScopeNames } from "$lib/client/audit";
import { listEnvironments, listProjects, queryAudit } from "$lib/server/core";

import { refuse } from "../transport";
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
 * `core.queryAudit` folds the actor's visible set INTO the WHERE clause and
 * gates on admin-at-a-scope. Nothing is filtered here afterwards, and nothing
 * may be: a post-filter would page over rows the reader is not entitled to and
 * then derive a cursor from them.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
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
  } satisfies AuditQuery;

  try {
    const [page, projects] = await Promise.all([
      queryAudit(locals.ctx, filter),
      listProjects(locals.ctx),
    ]);

    return { page, projects, filter, scopes: await scopeNames(locals.ctx, page, projects) };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

/**
 * id -> slug for the rows on THIS page.
 *
 * `core.queryAudit` emits `projectId` and `environmentId` and no slugs, which
 * is right for an append-only log: a denormalised slug is a name frozen at
 * write time, and delete-then-recreate can point that name at a different id.
 * So the resolution happens here, from data the screen already loads, and
 * `scopeLabel()` prints the raw id for anything that cannot be resolved rather
 * than dropping the scope from the row.
 *
 * BOUNDED BY WHAT IS ON SCREEN, not by the size of the installation: the
 * project map is the list the filter dropdown already needed, and environments
 * are listed only for the projects this page's fifty rows actually name --
 * typically one or two, and zero when the page is all install-wide events.
 * Listing every project's environments to label a page would put a query per
 * project on a screen that is usually looking at one.
 *
 * A row that names an environment but no project -- which is what a denial
 * recorded at environment scope looks like, since there is no project on that
 * scope to record -- is therefore unresolvable unless some other row on the
 * page named its project. Those render as the id, which is honest: the row is
 * still there, still readable, and still points at something an admin can look
 * up.
 */
async function scopeNames(
  ctx: App.Locals["ctx"],
  page: { entries: readonly { projectId: string | null; environmentId: string | null }[] },
  projects: readonly { id: string; slug: string }[],
): Promise<ScopeNames> {
  const byId = new Map(projects.map((project) => [project.id, project.slug]));

  const named = new Set<string>();
  for (const entry of page.entries) {
    if (entry.projectId !== null && entry.environmentId !== null) named.add(entry.projectId);
  }

  const environments: Record<string, string> = {};

  for (const projectId of named) {
    const slug = byId.get(projectId);
    if (slug === undefined) continue;

    for (const environment of await listEnvironments(ctx, slug)) {
      environments[environment.id] = environment.slug;
    }
  }

  return { projects: Object.fromEntries(byId), environments };
}
