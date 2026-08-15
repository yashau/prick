import type { KeyringStatus } from "$lib/client/api";
import { getKeyringStatus, rekeyPage, toPrickError } from "$lib/server/core";

import { refuse, refuseAction, viewer } from "../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Install settings: keyring state and the rekey.
 *
 * SERVER-RENDERED. Key IDs are not secrets -- they are the first eight bytes
 * of an HKDF output over the master key and are stored in every envelope in
 * the clear, precisely so that an operator can tell "this row predates the
 * rotation" from "this row has been tampered with".
 *
 * ---------------------------------------------------------------------------
 * THE KEYRING HALF OF THIS SCREEN IS NOT IMPLEMENTED SERVER-SIDE
 * ---------------------------------------------------------------------------
 * `core.getKeyringStatus` and `core.rekeyPage` are stubs that throw
 * `NOT_IMPLEMENTED`, and `GET /api/v1/admin/keyring` answers 501 for the same
 * reason. That is a real gap, not a wiring mistake, and it is surfaced rather
 * than hidden: a `NOT_IMPLEMENTED` collapses to `keyring: null` and the page
 * says so.
 *
 * WHY NOT LET IT FAIL THE PAGE. The bootstrap card below is a security guard --
 * it is how an operator learns that this install has an administrator no screen
 * can revoke -- and it needs nothing from the key ring. Taking the whole screen
 * down over an unimplemented panel would hide the warning behind the missing
 * feature.
 *
 * WHY NOT FAKE IT. A "safe to remove MASTER_KEY_OLD" indicator invented by the
 * UI would be the one irreversible mistake this design leaves available: those
 * values can never be decrypted again, by anyone. The indicator only means
 * something if the server counted the rows, so until it does, there is no
 * indicator.
 *
 * Every other failure still takes the page down. `keyring: null` means "this
 * build does not implement it", and it must not come to mean "something went
 * wrong and we carried on".
 */
export const load: PageServerLoad = async ({ locals }) => {
  let keyring: KeyringStatus | null = null;

  try {
    keyring = await getKeyringStatus(locals.ctx);
  } catch (cause) {
    if (toPrickError(cause).code !== "NOT_IMPLEMENTED") refuse(locals.ctx, cause);
  }

  try {
    return { keyring, viewer: await viewer(locals.ctx) };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  rekey: async ({ locals, request }) => {
    const form = await request.formData();
    const limit = Number(form.get("limit") ?? 100);

    try {
      // One bounded page per invocation. The full rekey is driven by a cron
      // trigger; this button exists so an operator can push it along and watch
      // the count fall rather than waiting on a schedule they cannot see.
      const result = await rekeyPage(locals.ctx, Number.isFinite(limit) ? limit : 100);
      return { action: "rekey" as const, ...result };
    } catch (cause) {
      return refuseAction("rekey" as const, locals.ctx, cause);
    }
  },
};
