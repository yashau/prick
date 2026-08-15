import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import {
  createGrant,
  getProjectBySlug,
  listEnvironments,
  listGrants,
  listIdentities,
  listProjects,
  revokeGrant,
} from "$lib/server/core";

import { refuse, refuseAction } from "../../../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Project-scoped access.
 *
 * The same grants, filtered to this project and the environments under it.
 * Two screens rather than one filter on the global screen because the audience
 * differs: a project admin manages their own project's access and should not
 * have to scan a table containing every other project to do it.
 *
 * THE FILTERING BELOW IS PRESENTATION, NOT AUTHORIZATION. `core.listGrants`
 * has already narrowed the rows to what this actor administers; the `.filter`
 * calls only decide which of those rows belong on THIS screen. Nothing here
 * widens the set, and nothing here may be relied on to narrow it.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  try {
    const [project, environments, grants, identities, projects] = await Promise.all([
      getProjectBySlug(locals.ctx, params.project),
      listEnvironments(locals.ctx, params.project),
      listGrants(locals.ctx),
      listIdentities(locals.ctx),
      listProjects(locals.ctx),
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
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  createGrant: async ({ locals, params, request }) => {
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
      await createGrant(locals.ctx, parsed.data);
      return { action: "createGrant" as const, ok: true };
    } catch (cause) {
      return refuseAction("createGrant" as const, locals.ctx, cause);
    }
  },

  revokeGrant: async ({ locals, request }) => {
    const form = await request.formData();
    try {
      await revokeGrant(locals.ctx, String(form.get("grant_id") ?? ""));
      return { action: "revokeGrant" as const, ok: true };
    } catch (cause) {
      return refuseAction("revokeGrant" as const, locals.ctx, cause);
    }
  },
};
