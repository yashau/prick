import { CreateGrantBody } from "@prick/shared";
import { fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi, fixtureResolveIdentity } from "$lib/client/fixtures";
import { fieldErrors } from "$lib/client/forms";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Install-wide access: identities, grants, and the denied-but-ungranted list.
 *
 * SERVER-RENDERED. Subjects, roles and scopes -- no values anywhere.
 *
 * FIXTURE SEAM -- becomes `core.listIdentities(ctx)`, `core.listGrants(ctx)`
 * and `core.listUnknownIdentities(ctx)`, all IN-PROCESS.
 */
export const load: PageServerLoad = async () => {
  const [identities, grants, unknown, projects] = await Promise.all([
    fixtureApi.listIdentities(),
    fixtureApi.listGrants(),
    fixtureApi.listUnknownIdentities(),
    fixtureApi.listProjects(),
  ]);

  return { identities, grants, unknown, projects };
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

export const actions: Actions = {
  createGrant: async ({ request }) => {
    const form = await request.formData();

    // The "seen but not granted" flow posts a SUBJECT: a service token's
    // `common_name` is the only handle an operator can see, and asking them to
    // transcribe an opaque hex string into an id field is how the wrong token
    // gets granted.
    const subject = String(form.get("subject") ?? "").trim();
    if (subject !== "" && String(form.get("identity_id") ?? "") === "") {
      const kind = String(form.get("kind") ?? "service") === "user" ? "user" : "service";
      form.set("identity_id", fixtureResolveIdentity(subject, kind));
    }

    const parsed = CreateGrantBody.safeParse(grantBodyFrom(form));
    if (!parsed.success) {
      return fail(422, {
        action: "createGrant" as const,
        errors: fieldErrors(parsed.error.issues),
      });
    }

    try {
      await fixtureApi.createGrant({
        identity_id: parsed.data.identity_id,
        role: parsed.data.role,
        scope_type: parsed.data.scope_type,
        ...("project" in parsed.data ? { project: parsed.data.project } : {}),
        ...("environment" in parsed.data ? { environment: parsed.data.environment } : {}),
        expires_at: parsed.data.expires_at,
      });
      return { action: "createGrant" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "createGrant" as const,
          errors: { form: cause.hint ? `${cause.message} ${cause.hint}` : cause.message },
          requestId: cause.requestId,
        });
      }
      throw cause;
    }
  },

  revokeGrant: async ({ request }) => {
    const form = await request.formData();

    try {
      await fixtureApi.revokeGrant(String(form.get("grant_id") ?? ""));
      return { action: "revokeGrant" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        // LAST_ADMIN is the one refusal here that must be readable rather than
        // generic: removing the final global admin while BOOTSTRAP_ADMINS is
        // empty locks everyone out permanently, by design.
        return fail(cause.status || 500, {
          action: "revokeGrant" as const,
          errors: { form: cause.hint ? `${cause.message} ${cause.hint}` : cause.message },
          requestId: cause.requestId,
        });
      }
      throw cause;
    }
  },

  updateIdentity: async ({ request }) => {
    const form = await request.formData();

    try {
      await fixtureApi.updateIdentity(String(form.get("identity_id") ?? ""), {
        disabled: form.get("disabled") === "true",
      });
      return { action: "updateIdentity" as const, ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "updateIdentity" as const,
          errors: { form: cause.message },
          requestId: cause.requestId,
        });
      }
      throw cause;
    }
  },
};
