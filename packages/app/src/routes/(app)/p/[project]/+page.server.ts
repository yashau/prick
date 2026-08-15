import { CreateEnvironmentBody } from "@prick/shared";
import { error, fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi } from "$lib/client/fixtures";
import { fieldErrors } from "$lib/client/forms";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Environments for one project, plus that project's slice of the audit log.
 *
 * SERVER-RENDERED. Slugs, counts and revisions only -- the values live one
 * level deeper, behind `ssr = false`.
 *
 * FIXTURE SEAM -- becomes `core.listEnvironments(ctx, slug)` and
 * `core.queryAudit(ctx, {project: slug, limit: 8})`, both IN-PROCESS.
 */
export const load: PageServerLoad = async ({ params }) => {
  try {
    const [project, environments, activity] = await Promise.all([
      fixtureApi.getProject(params.project),
      fixtureApi.listEnvironments(params.project),
      fixtureApi.queryAudit({ project: params.project, limit: 8 }),
    ]);

    return { project, environments, activity: activity.entries };
  } catch (cause) {
    if (cause instanceof ApiError) {
      // 404 for absent AND for invisible, with no way to tell them apart --
      // the API answers the same way, and softening it here would turn the UI
      // into an oracle for "which project names are in use".
      error(cause.status || 500, {
        code: cause.code,
        message: cause.message,
        requestId: cause.requestId ?? undefined,
        hint: cause.hint ?? undefined,
      });
    }
    throw cause;
  }
};

export const actions: Actions = {
  createEnvironment: async ({ params, request }) => {
    const form = await request.formData();

    const description = String(form.get("description") ?? "").trim();
    const parsed = CreateEnvironmentBody.safeParse({
      slug: String(form.get("slug") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      ...(description === "" ? {} : { description }),
    });

    if (!parsed.success) {
      return fail(422, {
        action: "createEnvironment" as const,
        errors: fieldErrors(parsed.error.issues),
      });
    }

    try {
      const created = await fixtureApi.createEnvironment(params.project, parsed.data);
      return { action: "createEnvironment" as const, created: created.slug };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "createEnvironment" as const,
          errors: { form: cause.message },
          requestId: cause.requestId,
        });
      }
      throw cause;
    }
  },

  deleteEnvironment: async ({ params, request }) => {
    const form = await request.formData();
    const slug = String(form.get("slug") ?? "");

    if (String(form.get("confirm") ?? "") !== slug) {
      return fail(400, {
        action: "deleteEnvironment" as const,
        errors: { confirm: "That does not match the environment slug." },
      });
    }

    try {
      await fixtureApi.deleteEnvironment(params.project, slug);
      return { action: "deleteEnvironment" as const, deleted: slug };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "deleteEnvironment" as const,
          errors: { form: cause.message },
          requestId: cause.requestId,
        });
      }
      throw cause;
    }
  },
};
