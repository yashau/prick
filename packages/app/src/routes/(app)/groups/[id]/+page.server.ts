import { AddGroupMemberBody, CreateGroupGrantBody, UpdateGroupBody } from "@prick/shared";
import { fail, redirect } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import type {
  AdminScopes,
  GroupGrantView,
  GroupMemberView,
  GroupView,
  IdentityView,
} from "$lib/components/rbac/types";
import {
  addGroupMember,
  createGroupGrant,
  deleteGroup,
  getGroup,
  listGroupGrants,
  listGroupMembers,
  listIdentities,
  listProjects,
  removeGroupMember,
  revokeGroupGrant,
  updateGroup,
} from "$lib/server/core";

import { refuse, refuseAction } from "../../transport";
import { adminScopes, grantScopeFields, grantTerms, isGlobalAdmin } from "../../users/scopes";
import type { Actions, PageServerLoad } from "./$types";

/**
 * One group: what it is, who is on it, and what it confers.
 *
 * ---------------------------------------------------------------------------
 * TWO AUTHORITIES ON ONE SCREEN, AND THE SPLIT IS THE POINT
 * ---------------------------------------------------------------------------
 * `canManage` is GLOBAL admin and gates the group's identity and its roster:
 * rename, delete, add member, remove member. `scopes` is admin AT A SCOPE and
 * gates the grants: a project admin may hand this group a role inside their
 * project.
 *
 * Joining the two would be a privilege escalation, not a convenience. Suppose
 * `platform` holds admin on `payments` and on `billing`. The admin of `billing`
 * may grant to `platform` — their scope, their decision. If they could also
 * edit its roster they could add themselves and walk out with admin on
 * `payments`, a project they have nothing to do with, without anybody granting
 * them anything.
 *
 * Both flags are PRESENTATION. `core` re-checks every one of these operations,
 * so a hand-posted form is refused exactly as it was before this load existed.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  try {
    const [group, members, grants, identities, projects, canManage] = await Promise.all([
      getGroup(locals.ctx, params.id),
      listGroupMembers(locals.ctx, params.id),
      listGroupGrants(locals.ctx, params.id),
      listIdentities(locals.ctx),
      listProjects(locals.ctx),
      isGlobalAdmin(locals.ctx),
    ]);

    // Annotated with the mirrors the components are written against, so a
    // change in `core` fails `mise run typecheck` here.
    const view: GroupView = group;
    const roster: GroupMemberView[] = members;
    const held: GroupGrantView[] = grants;
    const candidates: IdentityView[] = identities;
    const scopes: AdminScopes = await adminScopes(locals.ctx, projects);

    return {
      group: view,
      members: roster,
      grants: held,
      identities: candidates,
      scopes,
      canManage,
      /** Read by the shell's breadcrumb. A label, not authorization. */
      crumb: group.name,
    };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  /** Rename, or change the description. GLOBAL admin. The slug is immutable. */
  update: async ({ locals, params, request }) => {
    const form = await request.formData();
    const description = String(form.get("description") ?? "").trim();

    const parsed = UpdateGroupBody.safeParse({
      name: String(form.get("name") ?? "").trim(),
      description: description === "" ? undefined : description,
    });

    if (!parsed.success) {
      return fail(422, { action: "update" as const, errors: fieldErrors(parsed.error.issues) });
    }

    try {
      await updateGroup(locals.ctx, params.id, parsed.data);
      return { action: "update" as const, ok: true };
    } catch (cause) {
      return refuseAction("update" as const, locals.ctx, cause);
    }
  },

  /**
   * Delete the group. GLOBAL admin, and refused outright if it holds the last
   * global admin grant — a lockout is refused rather than confirmed, because
   * this design has no recovery credential.
   */
  delete: async ({ locals, params, request }) => {
    const form = await request.formData();

    // Checked on the SERVER as well as in the dialog. A destructive action
    // whose only guard is client-side is not guarded; it is decorated.
    const slug = String(form.get("slug") ?? "");
    if (String(form.get("confirm") ?? "") !== slug || slug === "") {
      return fail(400, {
        action: "delete" as const,
        errors: { confirm: "That does not match the group slug." },
      });
    }

    try {
      await deleteGroup(locals.ctx, params.id);
    } catch (cause) {
      return refuseAction("delete" as const, locals.ctx, cause);
    }

    // Outside the catch: `redirect` signals by throwing, and swallowing it into
    // `refuseAction` would turn a successful delete into a form error.
    redirect(303, "/groups");
  },

  addMember: async ({ locals, params, request }) => {
    const form = await request.formData();

    const parsed = AddGroupMemberBody.safeParse({
      identity_id: String(form.get("identity_id") ?? ""),
    });

    if (!parsed.success) {
      return fail(422, { action: "addMember" as const, errors: fieldErrors(parsed.error.issues) });
    }

    try {
      await addGroupMember(locals.ctx, params.id, parsed.data);
      return { action: "addMember" as const, ok: true };
    } catch (cause) {
      // A duplicate is a CONFLICT rather than a no-op, deliberately: an
      // idempotent "already there, never mind" would make a double-submitting
      // form indistinguishable from adding somebody twice by mistake.
      return refuseAction("addMember" as const, locals.ctx, cause);
    }
  },

  removeMember: async ({ locals, params, request }) => {
    const form = await request.formData();

    try {
      await removeGroupMember(locals.ctx, params.id, String(form.get("identity_id") ?? ""));
      return { action: "removeMember" as const, ok: true };
    } catch (cause) {
      return refuseAction("removeMember" as const, locals.ctx, cause);
    }
  },

  /** ADMIN AT THE SCOPE BEING GRANTED — the same rule as granting an identity. */
  createGrant: async ({ locals, params, request }) => {
    const form = await request.formData();

    const parsed = CreateGroupGrantBody.safeParse({
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
      await createGroupGrant(locals.ctx, params.id, parsed.data);
      return { action: "createGrant" as const, ok: true };
    } catch (cause) {
      return refuseAction("createGrant" as const, locals.ctx, cause);
    }
  },

  revokeGrant: async ({ locals, params, request }) => {
    const form = await request.formData();

    try {
      // Addressed as (group, grant) rather than by grant id alone, so a UI that
      // passed the wrong pair gets a 404 instead of revoking another group's row.
      await revokeGroupGrant(locals.ctx, params.id, String(form.get("grant_id") ?? ""));
      return { action: "revokeGrant" as const, ok: true };
    } catch (cause) {
      return refuseAction("revokeGrant" as const, locals.ctx, cause);
    }
  },
};
