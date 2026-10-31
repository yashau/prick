import type { PageLoad } from "./$types";

/** The breadcrumb's label for `/access/tokens`, read by the `(app)` layout. */
export const load: PageLoad = () => ({ crumb: "Service tokens" });
