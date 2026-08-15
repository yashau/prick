import { CreateProjectBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import { createProject, deleteProject, listProjects } from "$lib/server/core";

import { refuse, refuseAction } from "../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Projects: list, create, delete.
 *
 * SERVER-RENDERED. Names, slugs and counts only -- there is no value anywhere
 * on this screen, which is why it is allowed to be. `core.listProjects` is
 * called IN-PROCESS with the same `CoreContext` the Hono routes build; there is
 * no HTTP hop to `/api/v1` and therefore no second place authorization is
 * decided.
 *
 * FORM ACTIONS ARE USED HERE, and that is safe for exactly the reason it is
 * forbidden in the secrets subtree: SvelteKit serialises an action's return
 * value into page data. A project's name in the payload is fine. A secret
 * value in the payload would defeat `ssr = false` entirely, which is why
 * secret writes go through a client `fetch` instead and there is no action
 * anywhere under `p/[project]/[env]`.
 */

export const load: PageServerLoad = async ({ locals }) => {
  try {
    return { projects: await listProjects(locals.ctx) };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const form = await request.formData();

    const description = String(form.get("description") ?? "").trim();
    const parsed = CreateProjectBody.safeParse({
      slug: String(form.get("slug") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      ...(description === "" ? {} : { description }),
    });

    if (!parsed.success) {
      return fail(422, {
        action: "create" as const,
        errors: fieldErrors(parsed.error.issues),
      });
    }

    try {
      const project = await createProject(locals.ctx, parsed.data);
      return { action: "create" as const, created: project.slug };
    } catch (cause) {
      return refuseAction("create" as const, locals.ctx, cause);
    }
  },

  delete: async ({ locals, request }) => {
    const form = await request.formData();
    const slug = String(form.get("slug") ?? "");

    // The typed confirmation is checked on the SERVER as well as in the
    // dialog. A destructive action whose only guard is client-side is not
    // guarded; it is decorated.
    if (String(form.get("confirm") ?? "") !== slug) {
      return fail(400, {
        action: "delete" as const,
        errors: { confirm: "That does not match the project slug." },
      });
    }

    try {
      await deleteProject(locals.ctx, slug);
      return { action: "delete" as const, deleted: slug };
    } catch (cause) {
      return refuseAction("delete" as const, locals.ctx, cause);
    }
  },
};
