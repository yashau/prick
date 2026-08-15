/**
 * THE FIXTURE SEAM. This whole seam is scaffolding and is meant to be deleted.
 *
 * `/api/v1` is being built by another agent right now. Rather than block the
 * UI on it, every screen is developed against this in-memory dataset, which
 * implements `PrickApi` exactly. Two consumers:
 *
 *   1. `api.ts` selects it over `httpApi` while `USE_FIXTURES` is true.
 *   2. The SSR-rendered screens' `+page.server.ts` loads import `fixtureApi`
 *      DIRECTLY, each at a marked call site. Those calls become in-process
 *      `core.*` calls -- NOT `event.fetch('/api/v1/...')`, which cannot forward
 *      `CF-Access-JWT-Assertion` and would re-solve authorization badly.
 *
 * Cutover is therefore: flip `USE_FIXTURES`, replace the marked server-load
 * call sites with `core.*`, delete this file and its four `fixture-*` siblings.
 * No component and no route template changes.
 *
 * THE FILES, and why there is more than one:
 *
 *   ./fixture-store.ts     the dataset, and the lookups over it
 *   ./fixture-projects.ts  projects and environments
 *   ./fixture-secrets.ts   secrets -- the only slice that handles VALUES
 *   ./fixture-admin.ts     identities, grants, the audit log, the keyring
 *
 * The split is by domain and deliberately shallow, because the whole seam is
 * scheduled for deletion: each slice is a `Pick<PrickApi, ...>` object, and
 * `fixtureApi` below is the three of them spread into one. TypeScript rejects
 * the spread if a method is missing or the wrong shape, so the interface stays
 * implemented exactly, in one place, at compile time.
 *
 * NOTE ON WHAT THIS SEAM IS ALLOWED TO CONTAIN: secret VALUES, because it is a
 * fake database. `fixture-store.ts` and `fixture-secrets.ts` are the only files
 * in `src/lib/client` that hold one, they are obviously fake, and they
 * disappear with the seam. Nothing here is imported by a component.
 */

import type { PrickApi } from "./api.js";
import { fixtureAdminApi } from "./fixture-admin.js";
import { fixtureProjectApi } from "./fixture-projects.js";
import { fixtureSecretApi } from "./fixture-secrets.js";

export { fixtureResolveIdentity } from "./fixture-admin.js";

/**
 * The one switch. `false` puts every screen on `httpApi` and this module goes
 * unreferenced -- the bundler drops it, and the tree-shake is the proof that
 * nothing outside the seam reached into it.
 */
export const USE_FIXTURES = true;

/**
 * Who the app thinks is looking at it.
 *
 * NOT part of `PrickApi`: the real value comes from the verified Access actor
 * on `event.locals`, which `hooks.server.ts` will attach in build order step
 * 10/11. This exists so the shell can render an avatar and the bootstrap
 * banner before that lands.
 *
 * `bootstrapAdmin` is true while the only thing making this actor an admin is
 * the `BOOTSTRAP_ADMINS` var rather than a `grants` row. The banner that flag
 * drives is a guard, not decoration -- an install left in that state has an
 * admin nobody can revoke through the UI.
 */
export interface Viewer {
  kind: "user" | "service";
  subject: string;
  displayName: string | null;
  role: "reader" | "writer" | "admin";
  bootstrapAdmin: boolean;
}

export const fixtureViewer: Viewer = {
  kind: "user",
  subject: "ada@example.com",
  displayName: "Ada Lovelace",
  role: "admin",
  bootstrapAdmin: true,
};

export const fixtureApi: PrickApi = {
  ...fixtureProjectApi,
  ...fixtureSecretApi,
  ...fixtureAdminApi,
};
