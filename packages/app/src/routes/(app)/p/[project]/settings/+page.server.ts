import { UpdateProjectBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi } from "$lib/client/fixtures";
import { fieldErrors } from "$lib/client/forms";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Project settings: rename, describe, delete.
 *
 * The SLUG is deliberately not editable. It appears in CLI scopes, in grant
 * rows, in every `prk` invocation in someone's CI config and in the audit log,
 * and a rename would silently break all of them. Renaming a display name is a
 * cosmetic change; renaming a slug is a migration.
 *
 * FIXTURE SEAM -- becomes `core.getProjectBySlug` / `core.updateProject`.
 */
export const load: PageServerLoad = async ({ params }) => {
  const [project, environments] = await Promise.all([
    fixtureApi.getProject(params.project),
    fixtureApi.listEnvironments(params.project),
  ]);

  return { project, environments };
};

export const actions: Actions = {
  update: async ({ params, request }) => {
    const form = await request.formData();
    const description = String(form.get("description") ?? "").trim();

    const parsed = UpdateProjectBody.safeParse({
      name: String(form.get("name") ?? "").trim(),
      description: description === "" ? null : description,
    });

    if (!parsed.success) {
      return fail(422, { action: "update" as const, errors: fieldErrors(parsed.error.issues) });
    }

    try {
      await fixtureApi.updateProject(params.project, parsed.data);
      return { action: "update" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "update" as const,
          errors: { form: cause.message },
        });
      }
      throw cause;
    }
  },
};
