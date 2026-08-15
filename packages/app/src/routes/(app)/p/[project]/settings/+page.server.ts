import { UpdateProjectBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import { getProjectBySlug, listEnvironments, updateProject } from "$lib/server/core";

import { refuse, refuseAction } from "../../../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Project settings: rename, describe, delete.
 *
 * The SLUG is deliberately not editable. It appears in CLI scopes, in grant
 * rows, in every `prk` invocation in someone's CI config and in the audit log,
 * and a rename would silently break all of them. Renaming a display name is a
 * cosmetic change; renaming a slug is a migration.
 *
 * `core.updateProject` requires writer AT THE PROJECT and re-reads the row it
 * wrote, so the value this screen renders after a save is the stored one rather
 * than the submitted one.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  try {
    const [project, environments] = await Promise.all([
      getProjectBySlug(locals.ctx, params.project),
      listEnvironments(locals.ctx, params.project),
    ]);

    return { project, environments };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  update: async ({ locals, params, request }) => {
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
      await updateProject(locals.ctx, params.project, parsed.data);
      return { action: "update" as const, ok: true };
    } catch (cause) {
      return refuseAction("update" as const, locals.ctx, cause);
    }
  },
};
