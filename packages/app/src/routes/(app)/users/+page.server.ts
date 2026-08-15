import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import type { AdminScopes, GroupRefView, IdentityView } from "$lib/components/rbac/types";
import {
  createGrant,
  listGrants,
  listGroupMembers,
  listGroups,
  listIdentities,
  listProjects,
  revokeGrant,
  updateIdentity,
} from "$lib/server/core";

import { refuse, refuseAction } from "../transport";
import { adminScopes, grantScopeFields, grantTerms } from "./scopes";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Identities, the groups they are in, and the grants they hold directly.
 *
 * SERVER-RENDERED. Subjects, slugs, roles and timestamps — no secret value can
 * reach this load, because nothing it calls can produce one.
 *
 * Every call is IN-PROCESS and shares one `CoreContext`, so authorization is
 * resolved once. Each of them gates on admin-at-any-scope and then narrows PER
 * ROW to what this actor administers; that narrowing is `core`'s, and nothing
 * here re-does it. Filtering in a transport would be a second authorization
 * decision written in the wrong place.
 */
export const load: PageServerLoad = async ({ locals }) => {
  try {
    const [identities, grants, projects, groups] = await Promise.all([
      listIdentities(locals.ctx),
      listGrants(locals.ctx),
      listProjects(locals.ctx),
      listGroups(locals.ctx),
    ]);

    /*
     * Memberships, resolved GROUP BY GROUP rather than identity by identity.
     *
     * Both directions answer the same question and the difference is which
     * dimension the query count grows in. Identities grow without bound — every
     * service token that has ever authenticated is one — while groups are
     * administrative objects a human creates by hand, so the bound that matters
     * is the one on groups. `listGroupMembers` re-reads the memoised
     * authorization snapshot rather than resolving it again, so this is one
     * statement per group and nothing else.
     */
    const rosters = await Promise.all(
      groups.map(async (group) => ({
        group,
        members: await listGroupMembers(locals.ctx, group.id),
      })),
    );

    const memberships: Record<string, GroupRefView[]> = {};
    for (const { group, members } of rosters) {
      for (const member of members) {
        (memberships[member.identityId] ??= []).push({
          id: group.id,
          slug: group.slug,
          name: group.name,
        });
      }
    }

    const grantCounts: Record<string, number> = {};
    for (const grant of grants) {
      grantCounts[grant.identityId] = (grantCounts[grant.identityId] ?? 0) + 1;
    }

    // Annotated with the mirror types the components are written against, so
    // `mise run typecheck` fails if `core` changes shape underneath them.
    const view: IdentityView[] = identities;
    const scopes: AdminScopes = await adminScopes(locals.ctx, projects);

    return { identities: view, grants, groups, memberships, grantCounts, scopes };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  createGrant: async ({ locals, request }) => {
    const form = await request.formData();

    const parsed = CreateGrantBody.safeParse({
      identity_id: String(form.get("identity_id") ?? ""),
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
      /*
       * LAST_ADMIN is the refusal that has to be readable rather than generic:
       * removing the final global admin while BOOTSTRAP_ADMINS is empty locks
       * everyone out permanently, by design, so the server refuses rather than
       * confirming. `refuseAction` appends the hint for exactly this case.
       */
      return refuseAction("revokeGrant" as const, locals.ctx, cause);
    }
  },

  updateIdentity: async ({ locals, request }) => {
    const form = await request.formData();

    try {
      await updateIdentity(locals.ctx, String(form.get("identity_id") ?? ""), {
        disabled: form.get("disabled") === "true",
      });
      return { action: "updateIdentity" as const, ok: true };
    } catch (cause) {
      return refuseAction("updateIdentity" as const, locals.ctx, cause);
    }
  },
};
