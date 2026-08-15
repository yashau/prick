import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi } from "$lib/client/fixtures";
import { fieldErrors } from "$lib/client/forms";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Project-scoped access.
 *
 * The same grants, filtered to this project and the environments under it.
 * Two screens rather than one filter on the global screen because the audience
 * differs: a project admin manages their own project's access and should not
 * have to scan a table containing every other project to do it.
 *
 * FIXTURE SEAM -- becomes `core.listGrants(ctx)` scoped by the project.
 */
export const load: PageServerLoad = async ({ params }) => {
  const [project, environments, grants, identities, projects] = await Promise.all([
    fixtureApi.getProject(params.project),
    fixtureApi.listEnvironments(params.project),
    fixtureApi.listGrants(),
    fixtureApi.listIdentities(),
    fixtureApi.listProjects(),
  ]);

  return {
    project,
    environments,
    identities,
    projects,
    grants: grants.filter((grant) => grant.projectSlug === params.project),
    /**
     * Shown as context, not as something manageable here: a global grant
     * confers access to this project but is not this project's to revoke.
     */
    globalGrants: grants.filter((grant) => grant.scopeType === "global"),
  };
};

export const actions: Actions = {
  createGrant: async ({ params, request }) => {
    const form = await request.formData();
    const scopeType = String(form.get("scope_type") ?? "project");
    const expiresRaw = String(form.get("expires_at") ?? "").trim();

    const base = {
      identity_id: String(form.get("identity_id") ?? ""),
      role: String(form.get("role") ?? "reader"),
      expires_at: expiresRaw === "" ? null : Number(expiresRaw),
    };

    // The project is taken from the URL, never from the form. A project-scoped
    // screen that let the posted body choose the project would be an
    // authorization decision made by the client.
    const body =
      scopeType === "environment"
        ? {
            ...base,
            scope_type: "environment",
            project: params.project,
            environment: String(form.get("environment") ?? ""),
          }
        : { ...base, scope_type: "project", project: params.project };

    const parsed = CreateGrantBody.safeParse(body);
    if (!parsed.success) {
      return fail(422, {
        action: "createGrant" as const,
        errors: fieldErrors(parsed.error.issues),
      });
    }

    try {
      await fixtureApi.createGrant({
        identity_id: parsed.data.identity_id,
        role: parsed.data.role,
        scope_type: parsed.data.scope_type,
        ...("project" in parsed.data ? { project: parsed.data.project } : {}),
        ...("environment" in parsed.data ? { environment: parsed.data.environment } : {}),
        expires_at: parsed.data.expires_at,
      });
      return { action: "createGrant" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "createGrant" as const,
          errors: { form: cause.hint ? `${cause.message} ${cause.hint}` : cause.message },
        });
      }
      throw cause;
    }
  },

  revokeGrant: async ({ request }) => {
    const form = await request.formData();
    try {
      await fixtureApi.revokeGrant(String(form.get("grant_id") ?? ""));
      return { action: "revokeGrant" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "revokeGrant" as const,
          errors: { form: cause.hint ? `${cause.message} ${cause.hint}` : cause.message },
        });
      }
      throw cause;
    }
  },
};
