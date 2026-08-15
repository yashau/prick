import { CreateEnvironmentBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import {
  createEnvironment,
  deleteEnvironment,
  getProjectBySlug,
  listEnvironments,
  queryAudit,
  toPrickError,
} from "$lib/server/core";

import { refuse, refuseAction } from "../../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Environments for one project, plus that project's slice of the audit log.
 *
 * SERVER-RENDERED. Slugs, counts and revisions only -- the values live one
 * level deeper, behind `ssr = false`.
 *
 * The three calls are IN-PROCESS and share one `CoreContext`, which is what
 * makes them cost one authorization query between them: `resolveAuthorization`
 * memoises its snapshot in a `WeakMap` keyed on that object.
 *
 * `getProjectBySlug` 404s for absent AND for invisible, with no way to tell
 * them apart. That is `core`'s decision, not this load's, and softening it here
 * would turn the UI into an oracle for "which project names are in use" that
 * the API deliberately is not.
 *
 * THE ACTIVITY TAB DEGRADES RATHER THAN FAILING. `core.queryAudit` requires
 * admin at some scope -- "may read the secrets" and "may audit who read the
 * secrets" are different sentences, and only the second is a statement about
 * other people -- so a project WRITER opening their own project would otherwise
 * get a 403 page instead of the environments list, which is the point of the
 * screen. A `FORBIDDEN` collapses to an empty list; every other failure still
 * takes the page down, because a database error dressed up as "no recent
 * activity" is a lie the reader cannot see through.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  try {
    const [project, environments] = await Promise.all([
      getProjectBySlug(locals.ctx, params.project),
      listEnvironments(locals.ctx, params.project),
    ]);

    const activity = await queryAudit(locals.ctx, {
      project: params.project,
      limit: 8,
    }).catch((cause: unknown) => {
      if (toPrickError(cause).code === "FORBIDDEN") return { entries: [], cursor: null };
      throw cause;
    });

    return { project, environments, activity: activity.entries };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  createEnvironment: async ({ locals, params, request }) => {
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
      const created = await createEnvironment(locals.ctx, params.project, parsed.data);
      return { action: "createEnvironment" as const, created: created.slug };
    } catch (cause) {
      return refuseAction("createEnvironment" as const, locals.ctx, cause);
    }
  },

  deleteEnvironment: async ({ locals, params, request }) => {
    const form = await request.formData();
    const slug = String(form.get("slug") ?? "");

    if (String(form.get("confirm") ?? "") !== slug) {
      return fail(400, {
        action: "deleteEnvironment" as const,
        errors: { confirm: "That does not match the environment slug." },
      });
    }

    try {
      await deleteEnvironment(locals.ctx, params.project, slug);
      return { action: "deleteEnvironment" as const, deleted: slug };
    } catch (cause) {
      return refuseAction("deleteEnvironment" as const, locals.ctx, cause);
    }
  },
};
