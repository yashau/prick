import { redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

/**
 * `/` has no content of its own.
 *
 * Projects live at `/projects` because that screen owns create and delete
 * actions, and an action posting to `/` would be indistinguishable in the
 * audit log's `request_id` trail from anything else that happened to be
 * mounted at the root later.
 */
export const load: PageServerLoad = () => {
  redirect(307, "/projects");
};
