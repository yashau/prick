import { error, fail, type ActionFailure } from "@sveltejs/kit";

import type { Viewer } from "$lib/client/api";
import type { FormErrors } from "$lib/client/forms";
import { resolveEffectiveRole } from "$lib/server/auth";
import { toPrickError, type CoreContext } from "$lib/server/core";

/**
 * The SvelteKit transport's three shared moves.
 *
 * `core` throws `PrickError` and knows nothing about HTTP. The Hono half maps
 * that onto a JSON body in `http/errors.ts`; this is the other half of the same
 * mapping, onto SvelteKit's `error()` and `fail()`. It exists so the mapping is
 * written once: a load that spells its own 404 is a load that will eventually
 * spell it differently from the one next to it, and the difference between a
 * 403 and a 404 in this application is a deliberate security property rather
 * than a formatting choice.
 *
 * WHY IT LIVES HERE rather than in `$lib`. It imports `$lib/server/core`, so it
 * is a server module; `$lib/client` may not hold it, because that directory's
 * whole contract is that nothing in it can reach a value-carrying server module
 * (see the header of `api.ts`). SvelteKit ignores files in `src/routes` that do
 * not begin with `+`, so colocating it with the loads that use it is supported
 * and keeps it next to its only callers. If a component ever imports it, the
 * build fails on the server-only import chain rather than shipping it.
 */

/**
 * Turn a `PrickError` into the error page, with the status it asked for.
 *
 * THE STATUS HAS TO COME FROM HERE and not from `handleError`, which cannot
 * change it: an uncaught `NOT_FOUND` would otherwise render a 500 page whose
 * body says "No such project", which is the one combination that tells a user
 * their URL was fine and the server broke.
 *
 * `notFound()` in `core` deliberately cannot distinguish absent from invisible,
 * and nothing here softens that -- both arrive as the same 404 with the same
 * hint, because the alternative is an oracle for which project names are in
 * use.
 */
export function refuse(ctx: CoreContext, cause: unknown): never {
  const failure = toPrickError(cause);

  error(failure.status, {
    code: failure.wireCode,
    message: failure.message,
    // Echoed as `X-Request-Id` and stored on every audit row this request
    // wrote, including the denial that produced this page.
    requestId: ctx.requestId,
    ...(failure.hint === undefined ? {} : { hint: failure.hint }),
  });
}

/**
 * The same mapping for a form action, where a failure re-renders the form
 * rather than replacing the page.
 *
 * THE HINT IS ALWAYS APPENDED. `PrickError.hint` is written to be actionable
 * ("Revoke the existing grant first", "Set BOOTSTRAP_ADMINS and redeploy"), and
 * the refusals that reach a form are exactly the ones where the next step is
 * not obvious -- `LAST_ADMIN` being the one that matters most, since it refuses
 * an operation whose consequence is a permanent lockout by design.
 */
export function refuseAction<A extends string>(
  action: A,
  ctx: CoreContext,
  cause: unknown,
): ActionFailure<{ action: A; errors: FormErrors; requestId: string }> {
  const failure = toPrickError(cause);

  return fail(failure.status, {
    action,
    errors: {
      form: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}`,
    },
    requestId: ctx.requestId,
  });
}

/**
 * Who the shell renders in the sidebar, and whether to warn about bootstrap.
 *
 * This is `GET /api/v1/whoami`, computed in-process. Everything but `role` was
 * already resolved by `hooks.server.ts`; `role` reads the authorization
 * snapshot that is memoised on `ctx`, so it issues no query of its own.
 *
 * `role` is the GLOBAL role and nothing else. Reporting "the highest role held
 * anywhere" would mean taking a maximum over the per-project and
 * per-environment maps, which is an authorization decision, and a transport
 * does not make those.
 */
export async function viewer(ctx: CoreContext): Promise<Viewer> {
  return {
    kind: ctx.actor.kind,
    subject: ctx.actor.subject,
    identityId: ctx.actor.identityId,
    role: await resolveEffectiveRole(ctx, { type: "global" }),
    bootstrap: ctx.actor.bootstrap,
  };
}
