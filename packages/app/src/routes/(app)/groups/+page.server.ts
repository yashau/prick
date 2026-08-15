import { CreateGroupBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import type { GroupView } from "$lib/components/rbac/types";
import { createGroup, listGroups } from "$lib/server/core";

import { refuse, refuseAction } from "../transport";
import { isGlobalAdmin } from "../users/scopes";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The groups in this install.
 *
 * VISIBLE TO ANY ADMIN, at any scope, and that is `core.listGroups`'s decision
 * rather than this load's. A project admin has to be able to grant a role to a
 * group inside their project, and they cannot pick one from a list they are not
 * allowed to see. What a group's name discloses is an organisational roster —
 * a much weaker disclosure than the per-row narrowing on its GRANTS is
 * protecting, which is who has access to what.
 *
 * CREATING one is a different question and needs GLOBAL admin, so the load
 * reports which authority the viewer holds and the screen offers the button
 * only to somebody who can use it. That flag is presentation: `createGroup`
 * asserts global admin itself, and a hand-posted form is refused identically.
 */
export const load: PageServerLoad = async ({ locals }) => {
  try {
    const groups: GroupView[] = await listGroups(locals.ctx);

    return { groups, canManage: await isGlobalAdmin(locals.ctx) };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const form = await request.formData();
    const description = String(form.get("description") ?? "").trim();

    const parsed = CreateGroupBody.safeParse({
      slug: String(form.get("slug") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      ...(description === "" ? {} : { description }),
    });

    if (!parsed.success) {
      return fail(422, { action: "create" as const, errors: fieldErrors(parsed.error.issues) });
    }

    try {
      await createGroup(locals.ctx, parsed.data);
      return { action: "create" as const, ok: true };
    } catch (cause) {
      return refuseAction("create" as const, locals.ctx, cause);
    }
  },
};
