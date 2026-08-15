import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { fieldErrors } from "$lib/client/forms";
import {
  createGrant,
  listGrants,
  listIdentities,
  listProjects,
  listUnknownIdentities,
  revokeGrant,
  updateIdentity,
  type IdentityRecord,
} from "$lib/server/core";

import { refuse, refuseAction } from "../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Install-wide access: identities, grants, and the denied-but-ungranted list.
 *
 * SERVER-RENDERED. Subjects, roles and scopes -- no values anywhere.
 *
 * All four calls are IN-PROCESS and share one `CoreContext`. Each gates on
 * admin-at-any-scope and then narrows PER ROW to what this actor administers,
 * so a project admin sees their project's access graph and not the
 * organisation's. That narrowing is `core`'s, not this load's: filtering here
 * would be a second authorization decision written in a transport.
 */
export const load: PageServerLoad = async ({ locals }) => {
  try {
    const [identities, grants, unknown, projects] = await Promise.all([
      listIdentities(locals.ctx),
      listGrants(locals.ctx),
      listUnknownIdentities(locals.ctx),
      listProjects(locals.ctx),
    ]);

    return { identities, grants, unknown, projects };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

/**
 * Build the discriminated `CreateGrantBody` from flat form fields.
 *
 * The scope fields are attached ONLY for the scope types that carry them, so
 * a global grant cannot arrive with a stray `project` that some later reader
 * has to decide the meaning of. `.strict()` on the schema turns that stray
 * field into a 422 rather than something silently dropped.
 */
function grantBodyFrom(form: FormData) {
  const scopeType = String(form.get("scope_type") ?? "global");
  const role = String(form.get("role") ?? "reader");
  const expiresRaw = String(form.get("expires_at") ?? "").trim();

  const base = {
    identity_id: String(form.get("identity_id") ?? ""),
    role,
    expires_at: expiresRaw === "" ? null : Number(expiresRaw),
  };

  if (scopeType === "project") {
    return { ...base, scope_type: "project", project: String(form.get("project") ?? "") };
  }

  if (scopeType === "environment") {
    return {
      ...base,
      scope_type: "environment",
      project: String(form.get("project") ?? ""),
      environment: String(form.get("environment") ?? ""),
    };
  }

  return { ...base, scope_type: "global" };
}

/**
 * Turn a SUBJECT into the `identity_id` a grant needs.
 *
 * The "seen but not granted" flow posts a subject, because a service token's
 * `common_name` is the only handle an operator can see and asking them to
 * transcribe an opaque hex string into an id field is how the wrong token gets
 * granted. That list is read out of the AUDIT LOG, which records subjects
 * rather than identity rows, so the pairing has to happen somewhere.
 *
 * It happens against `listIdentities`, which is exactly the join the API
 * documents for this ("match it to `GET /identities` on `subject`"), and it
 * always finds a row: every authenticated request upserts its subject's
 * identity before anything else touches the database, so a subject that was
 * denied has been recorded by definition.
 *
 * It deliberately does NOT create one. An id that resolves to nothing is a
 * `NOT_FOUND` from `createGrant` -- the honest answer -- whereas inventing a
 * row here would let a typo in a posted subject manufacture an identity that
 * has never authenticated and then grant it access.
 */
function identityIdFor(identities: readonly IdentityRecord[], subject: string): string {
  return identities.find((identity) => identity.subject === subject)?.id ?? "";
}

export const actions: Actions = {
  createGrant: async ({ locals, request }) => {
    const form = await request.formData();

    const subject = String(form.get("subject") ?? "").trim();
    if (subject !== "" && String(form.get("identity_id") ?? "") === "") {
      try {
        form.set("identity_id", identityIdFor(await listIdentities(locals.ctx), subject));
      } catch (cause) {
        return refuseAction("createGrant" as const, locals.ctx, cause);
      }
    }

    const parsed = CreateGrantBody.safeParse(grantBodyFrom(form));
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
      // LAST_ADMIN is the one refusal here that must be readable rather than
      // generic: removing the final global admin while BOOTSTRAP_ADMINS is
      // empty locks everyone out permanently, by design. `refuseAction` appends
      // the hint for exactly this reason.
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
