import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import type { AdminScopes, EffectivePermissionsView, GroupView } from "$lib/components/rbac/types";
import {
  addGroupMember,
  createGrant,
  explainIdentityPermissions,
  listGrants,
  listGroups,
  listProjects,
  removeGroupMember,
  revokeGrant,
  updateIdentity,
} from "$lib/server/core";

import { refuse, refuseAction } from "../../transport";
import { adminScopes, grantScopeFields, grantTerms } from "../scopes";
import type { Actions, PageServerLoad } from "./$types";

/**
 * One identity, and WHY it can do what it can do.
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN THIS APPLICATION MOST NEEDED
 * ---------------------------------------------------------------------------
 * `GET /grants` lists direct grants; a group's grants live under
 * `/groups/{id}/grants`. Neither list, nor both side by side, answers "why does
 * this identity have production" — because the answer may be a grant on the
 * environment, on its project, a global grant, any of those held through a
 * group, or the `BOOTSTRAP_ADMINS` variable, which has no row anywhere.
 *
 * `explainIdentityPermissions` answers it in one call, with every source that
 * reaches each scope and exactly one of them marked `decisive`. This load does
 * no assembling of its own: an explanation computed in a transport is an
 * explanation that can disagree with the enforcement, and one that disagrees is
 * worse than none.
 *
 * SERVER-RENDERED, and safe to be: subjects, slugs, roles, group names and
 * timestamps. Nothing here can produce a secret value.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  try {
    const [permissions, grants, projects, groups] = await Promise.all([
      explainIdentityPermissions(locals.ctx, params.id),
      listGrants(locals.ctx),
      listProjects(locals.ctx),
      listGroups(locals.ctx),
    ]);

    // Annotated with the mirror the components are written against; a change to
    // `core.EffectivePermissions` fails `mise run typecheck` here rather than
    // rendering something subtly wrong on an access review.
    const view: EffectivePermissionsView = permissions;
    const allGroups: GroupView[] = groups;
    const scopes: AdminScopes = await adminScopes(locals.ctx, projects);

    return {
      permissions: view,
      groups: allGroups,
      scopes,
      /*
       * The direct grants held by THIS identity.
       *
       * Filtered here rather than queried, because `listGrants` is the call
       * that applies the per-row narrowing and running a second, narrower query
       * would mean writing that rule twice. The filter only chooses which of
       * the already-authorized rows belong on this screen.
       */
      grants: grants.filter((grant) => grant.identityId === params.id),
      /** Read by the shell's breadcrumb. Not authorization, just a label. */
      crumb: permissions.identity.displayName ?? permissions.identity.subject,
    };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  createGrant: async ({ locals, params, request }) => {
    const form = await request.formData();

    // The identity comes from the URL, never from the posted body. A screen
    // scoped to one identity that let the form choose the grantee would be an
    // authorization-relevant decision made by the client.
    const parsed = CreateGrantBody.safeParse({
      identity_id: params.id,
      ...grantTerms(form),
      ...grantScopeFields(form),
    });

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

  updateIdentity: async ({ locals, params, request }) => {
    const form = await request.formData();

    try {
      await updateIdentity(locals.ctx, params.id, { disabled: form.get("disabled") === "true" });
      return { action: "updateIdentity" as const, ok: true };
    } catch (cause) {
      return refuseAction("updateIdentity" as const, locals.ctx, cause);
    }
  },

  /** GLOBAL admin. See the header of `core/groups.ts` for why membership is not delegable. */
  addToGroup: async ({ locals, params, request }) => {
    const form = await request.formData();

    try {
      await addGroupMember(locals.ctx, String(form.get("group_id") ?? ""), {
        identity_id: params.id,
      });
      return { action: "addToGroup" as const, ok: true };
    } catch (cause) {
      return refuseAction("addToGroup" as const, locals.ctx, cause);
    }
  },

  removeFromGroup: async ({ locals, params, request }) => {
    const form = await request.formData();

    try {
      await removeGroupMember(locals.ctx, String(form.get("group_id") ?? ""), params.id);
      return { action: "removeFromGroup" as const, ok: true };
    } catch (cause) {
      return refuseAction("removeFromGroup" as const, locals.ctx, cause);
    }
  },
};
