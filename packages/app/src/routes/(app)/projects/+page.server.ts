import { CreateProjectBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi } from "$lib/client/fixtures";
import { fieldErrors } from "$lib/client/forms";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Projects: list, create, delete.
 *
 * SERVER-RENDERED. Names, slugs and counts only -- there is no value anywhere
 * on this screen, which is why it is allowed to be. CI greps every
 * `+*.server.ts` for `revealSecret|exportSecrets|decrypt` and fails on a hit.
 *
 * FORM ACTIONS ARE USED HERE, and that is safe for exactly the reason it is
 * forbidden in the secrets subtree: SvelteKit serialises an action's return
 * value into page data. A project's name in the payload is fine. A secret
 * value in the payload would defeat `ssr = false` entirely, which is why
 * secret writes go through a client `fetch` instead and there is no action
 * anywhere under `p/[project]/[env]`.
 *
 * FIXTURE SEAM -- becomes `core.listProjects(ctx)` / `core.createProject(...)`
 * called IN-PROCESS. See the note in `(app)/+layout.server.ts`.
 */

export const load: PageServerLoad = async () => {
  const projects = await fixtureApi.listProjects();
  return { projects };
};

export const actions: Actions = {
  create: async ({ request }) => {
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
      const project = await fixtureApi.createProject(parsed.data);
      return { action: "create" as const, created: project.slug };
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.status || 500, {
          action: "create" as const,
          errors: { form: error.message },
          requestId: error.requestId,
        });
      }
      throw error;
    }
  },

  delete: async ({ request }) => {
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
      await fixtureApi.deleteProject(slug);
      return { action: "delete" as const, deleted: slug };
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.status || 500, {
          action: "delete" as const,
          errors: { form: error.message },
          requestId: error.requestId,
        });
      }
      throw error;
    }
  },
};
