import type { Role } from "@prick/shared";

import { assertCan, can } from "../auth/authorize.js";
import { recordDenial } from "./audit.js";
import type { CoreContext, Scope } from "./context.js";
import { notFound } from "./errors.js";

/**
 * The two-step access check every `core` read and write performs, in this
 * order and never the other way round.
 *
 *   1. assertVisible(...)  -- can this actor see that this thing EXISTS?  404
 *   2. assertCan(...)      -- may they do the thing to it?                403
 *
 * The order is the whole point, and getting it backwards is the leak.
 *
 * A single `assertCan(ctx, scope, 'writer')` on a project the actor cannot see
 * at all returns 403. That 403 is a statement: "this project exists, and you may
 * not write to it". An actor with no grant anywhere can then walk a slug
 * dictionary and read off which project names are in use in an organisation they
 * have no access to -- and slugs are things like `acme-payroll-migration`. The
 * response has leaked the fact the API was asked to protect.
 *
 * So visibility is resolved first and its failure is INDISTINGUISHABLE from
 * absence: `notFound()` takes no argument that could vary between the two cases,
 * and both paths reach it. A 403 is only ever produced for something the actor
 * has already been shown to be able to see, where it leaks nothing they did not
 * already know.
 */

/**
 * Reader at `scope`, or a 404 that says nothing about why.
 *
 * The denial is still AUDITED before it throws. That is not for the caller's
 * benefit -- they are told nothing -- but for the operator's: a denial row is
 * how an unrecognised service token first appears in "Seen but not granted", and
 * a 404 path that recorded nothing would make the most common provisioning flow
 * ("point CI at prick, watch it fail, click Grant") stop working for exactly the
 * requests that matter most.
 */
export async function assertVisible(ctx: CoreContext, scope: Scope, kind: string): Promise<void> {
  if (await can(ctx, scope, "reader")) return;

  await recordDenial(ctx, { scope, required: "reader", resource: kind });

  throw notFound(kind);
}

/**
 * Step 2: the capability check, for something already established as visible.
 *
 * A thin pass-through to `auth/authorize.ts` so that `core` has ONE import for
 * the pair and no call site can perform step 2 while forgetting step 1 -- they
 * are next to each other in this file and in every caller.
 */
export async function assertRole(ctx: CoreContext, scope: Scope, required: Role): Promise<void> {
  await assertCan(ctx, scope, required);
}
