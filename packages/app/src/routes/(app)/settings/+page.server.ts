import { fail } from "@sveltejs/kit";

import { ApiError } from "$lib/client/errors";
import { fixtureApi, fixtureViewer } from "$lib/client/fixtures";

import type { Actions, PageServerLoad } from "./$types";

/**
 * Install settings: keyring state and the rekey.
 *
 * SERVER-RENDERED. Key IDs are not secrets -- they are the first eight bytes
 * of an HKDF output over the master key and are stored in every envelope in
 * the clear, precisely so that an operator can tell "this row predates the
 * rotation" from "this row has been tampered with".
 *
 * FIXTURE SEAM -- becomes `core.getKeyringStatus(ctx)` / `core.rekeyPage(ctx)`.
 */
export const load: PageServerLoad = async () => {
  const keyring = await fixtureApi.getKeyringStatus();
  return { keyring, viewer: fixtureViewer };
};

export const actions: Actions = {
  rekey: async ({ request }) => {
    const form = await request.formData();
    const limit = Number(form.get("limit") ?? 100);

    try {
      // One bounded page per invocation. The full rekey is driven by a cron
      // trigger; this button exists so an operator can push it along and watch
      // the count fall rather than waiting on a schedule they cannot see.
      const result = await fixtureApi.rekeyPage(Number.isFinite(limit) ? limit : 100);
      return { action: "rekey" as const, ...result };
    } catch (cause) {
      if (cause instanceof ApiError) {
        return fail(cause.status || 500, {
          action: "rekey" as const,
          errors: { form: cause.message },
        });
      }
      throw cause;
    }
  },
};
