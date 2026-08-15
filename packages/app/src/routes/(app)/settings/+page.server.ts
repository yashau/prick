import { getKeyringStatus, rekeyPage, REKEY_DEFAULT_PAGE } from "$lib/server/core";

import { refuse, refuseAction, viewer } from "../transport";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Install settings: keyring state and the rekey.
 *
 * SERVER-RENDERED. Key IDs are not secrets -- they are the first eight bytes
 * of an HKDF output over the master key and are stored in every envelope in
 * the clear, precisely so that an operator can tell "this row predates the
 * rotation" from "this row has been tampered with". Row counts are not secrets
 * either. Nothing on this screen decrypts anything, so nothing it returns can
 * reach the page payload as plaintext.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO DEGRADED MODE HERE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `keyring` was nullable while `core.getKeyringStatus` was a stub: the panel
 * rendered "unavailable in this build" rather than inventing a number. It is
 * implemented now, so the nullability is gone with it -- and it must not come
 * back as a catch that turns a failure into an empty ring. A
 * "safe to remove MASTER_KEY_OLD" indicator computed from a status this load
 * failed to fetch is the one irreversible mistake this design leaves
 * available: those values can never be decrypted again, by anyone.
 *
 * So every failure takes the page down, through the same `refuse` every other
 * load uses. That includes a `FORBIDDEN` for a caller who is not a global
 * admin: `getKeyringStatus` requires one, this screen is install
 * administration, and a 403 is the honest answer rather than a page with its
 * only content missing.
 */
export const load: PageServerLoad = async ({ locals }) => {
  try {
    return {
      keyring: await getKeyringStatus(locals.ctx),
      viewer: await viewer(locals.ctx),
    };
  } catch (cause) {
    refuse(locals.ctx, cause);
  }
};

export const actions: Actions = {
  /**
   * Run ONE page of the rekey.
   *
   * Nothing schedules this. There is no cron trigger in `wrangler.jsonc`, so
   * this button is the only thing that moves rows that ordinary writes do not
   * touch, and an operator presses it until the count reaches zero. Saying so
   * in the UI rather than implying a background job is the difference between
   * an operator who finishes the rotation and one who waits for a schedule that
   * does not exist.
   */
  rekey: async ({ locals, request }) => {
    const form = await request.formData();
    const requested = Number(form.get("limit"));
    // A hidden field is still a field a client controls. `core` refuses a page
    // size that is not a positive integer; this only decides what a missing or
    // malformed one means, which is "the default", not "everything".
    const limit = Number.isInteger(requested) && requested > 0 ? requested : REKEY_DEFAULT_PAGE;

    try {
      const result = await rekeyPage(locals.ctx, limit);
      return { action: "rekey" as const, ...result };
    } catch (cause) {
      return refuseAction("rekey" as const, locals.ctx, cause);
    }
  },
};
