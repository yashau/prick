import type { AdminEnvironment, AdminProject, AdminScopes } from "$lib/components/rbac/types";
import { can } from "$lib/server/auth";
import {
  environmentScope,
  listEnvironments,
  type CoreContext,
  type ProjectSummary,
} from "$lib/server/core";

/**
 * "Where may I grant?", answered once for the two RBAC screens.
 *
 * WHY IT LIVES IN A ROUTE DIRECTORY. SvelteKit ignores files under `src/routes`
 * that do not begin with `+`, so a module colocated with its callers is
 * supported -- `(app)/transport.ts` is the same pattern. It cannot live in
 * `$lib/client`, because it imports `$lib/server`; it should not live in
 * `$lib/server/core`, because it is not domain logic. It is a transport's
 * question: what does this screen offer.
 *
 * `(app)/groups/**` imports it from here rather than keeping a second copy.
 * Two implementations of "which scopes may this actor grant at" is how one of
 * them ends up offering a scope the other would have hidden.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT AN AUTHORIZATION DECISION AND MUST NEVER BECOME ONE
 * ---------------------------------------------------------------------------
 * `core.createGrant` / `core.createGroupGrant` resolve the scope and then
 * `assertRole(scope, "admin")`. That is the decision, it is written once, and a
 * request that skips this UI is checked by it identically. Everything below
 * only decides which options a form renders -- so a bug here is a missing
 * button, never a granted role.
 */

/**
 * Global admin, which is the authority the group operations that are NOT
 * delegable need: creating, renaming and deleting a group, changing its
 * membership, and flipping an identity's kill switch.
 *
 * Reads the memoised authorization snapshot, so calling it costs nothing on a
 * load that has already touched `core`.
 */
export function isGlobalAdmin(ctx: CoreContext): Promise<boolean> {
  return can(ctx, { type: "global" }, "admin");
}

/**
 * The scopes `ctx.actor` may create a grant at, resolved from the projects the
 * caller has ALREADY loaded.
 *
 * Takes the project list as an argument rather than calling `listProjects`
 * itself: every caller needs that list anyway, and fetching it twice per page
 * would be two identical queries to answer one question.
 *
 * COSTS ONE QUERY PER VISIBLE PROJECT and no more. `can()` reads the
 * authorization snapshot memoised on the context, so the role checks below
 * issue nothing; `listEnvironments` is the only statement in the loop, and it
 * has already narrowed its rows to the environments this actor may see.
 */
export async function adminScopes(
  ctx: CoreContext,
  projects: readonly ProjectSummary[],
): Promise<AdminScopes> {
  const global = await can(ctx, { type: "global" }, "admin");

  const resolved = await Promise.all(
    projects.map(async (project): Promise<AdminProject | null> => {
      const grantable =
        global || (await can(ctx, { type: "project", projectId: project.id }, "admin"));

      const environments = await listEnvironments(ctx, project.slug);
      const allowed: AdminEnvironment[] = [];

      for (const environment of environments) {
        // A project admin may grant on every environment under it; an
        // environment admin may grant on theirs and no sibling. Both fall out
        // of `can()`, which applies the ordinary downward-inheritance rule.
        const may = grantable || (await can(ctx, environmentScope(environment), "admin"));
        if (may) allowed.push({ slug: environment.slug, name: environment.name });
      }

      // A project the actor can SEE but may not grant anywhere inside is not an
      // option on a grant form. It stays visible on every other screen; it is
      // simply not somewhere this actor can hand out a role.
      if (!grantable && allowed.length === 0) return null;

      return { slug: project.slug, name: project.name, grantable, environments: allowed };
    }),
  );

  return { global, projects: resolved.filter((project) => project !== null) };
}

/** True when this actor can create a grant at all. Drives whether the form exists. */
export function canGrantAnywhere(scopes: AdminScopes): boolean {
  return scopes.global || scopes.projects.length > 0;
}

export type GrantScopeFields =
  | { scope_type: "global" }
  | { scope_type: "project"; project: string }
  | { scope_type: "environment"; project: string; environment: string };

/**
 * The scope half of a grant body, built from flat form fields.
 *
 * The scope fields are attached ONLY for the scope types that carry them, so a
 * global grant cannot arrive with a stray `project` that a later reader has to
 * decide the meaning of. `.strict()` on `CreateGrantBody` / `CreateGroupGrantBody`
 * turns that stray field into a 422 rather than something silently dropped --
 * which is the ambiguity that produces an over-broad grant nobody notices.
 */
export function grantScopeFields(form: FormData): GrantScopeFields {
  const scopeType = String(form.get("scope_type") ?? "global");

  if (scopeType === "project") {
    return { scope_type: "project", project: String(form.get("project") ?? "") };
  }

  if (scopeType === "environment") {
    return {
      scope_type: "environment",
      project: String(form.get("project") ?? ""),
      environment: String(form.get("environment") ?? ""),
    };
  }

  return { scope_type: "global" };
}

/** Role and expiry, shared by identity grants and group grants alike. */
export function grantTerms(form: FormData): { role: string; expires_at: number | null } {
  const expires = String(form.get("expires_at") ?? "").trim();

  return {
    role: String(form.get("role") ?? "reader"),
    expires_at: expires === "" ? null : Number(expires),
  };
}
