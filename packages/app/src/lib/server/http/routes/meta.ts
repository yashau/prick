import { Hono } from "hono";

import { APP_VERSION } from "../../../version.js";
import { resolveEffectiveRole } from "../../auth/authorize.js";
import { getCapabilities } from "../../core/capabilities.js";
import { readInstanceId } from "../../core/instance.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonResponse } from "../openapi.js";
import { CapabilitiesResponse, HealthResponse, WhoamiResponse } from "../schemas.js";

/**
 * The two endpoints that describe the server rather than the data.
 */

/**
 * Liveness. UNAUTHENTICATED BY DESIGN, and the only route that is.
 *
 * `prk login <url>` probes this first, and every deployment guide ends with a
 * curl of it. If it answers 200 with JSON to an unauthenticated caller, that
 * means Cloudflare Access is NOT in front of this hostname -- so the CLI emits a
 * loud warning and the deployment is an unprotected secrets manager. This
 * handler must therefore never grow a field that reveals anything beyond "a
 * prick server is listening here".
 *
 * The three fields it does carry, and why each earns its place:
 *
 *   service   the constant `"prick"`. A 200 with a JSON body is not on its own
 *             evidence of anything -- a captive portal or a misconfigured proxy
 *             produces one too -- so a client needs one field it can compare
 *             against a known value before it decides where to send a
 *             credential.
 *   status    `"ok"`, and it MEANS something because the fail-closed keyring
 *             middleware runs ahead of this route. An installation whose
 *             `MASTER_KEY` decodes to 31 bytes answers 500 here, not 200: a
 *             secrets manager that cannot load its root of trust cannot read or
 *             write a single value, and reporting health would be reporting the
 *             opposite of the truth.
 *   version   the web app's CalVer (`APP_VERSION`), stamped from an `app-v*`
 *             tag by `mise run app:set`; `0.0.0-dev` when unstamped.
 *
 * The deployment's instance id is served only to authenticated callers -- in
 * `whoami` and the `Prick-Instance` header -- and never here: it is a stable
 * fingerprint that names WHICH deployment answered, which is more than "a prick
 * server is listening here".
 */
export function healthRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/health",
    describe({
      summary: "Liveness probe",
      description:
        "The only unauthenticated route. Answers `200` only once the fail-closed key ring middleware has succeeded, which is what makes `ok` mean something.\n\n**If this returns 200 to an unauthenticated caller, Cloudflare Access is not in front of this hostname.**",
      tags: ["meta"],
      operationId: "health",
      responses: {
        200: jsonResponse("The server is listening and its key ring loaded.", HealthResponse),
      },
    }),
    (c) => c.json({ service: "prick", status: "ok", version: APP_VERSION } as const),
  );

  return app;
}

/**
 * The identity this server resolved for the caller.
 *
 * Answers the question `prk whoami` and `prk doctor` ask: "which subject does
 * the server think I am, and does it consider me anybody?" Everything in the
 * response was already computed by the authentication middleware except `role`,
 * which is one call into the per-request authorization snapshot and therefore
 * issues no additional query.
 *
 * `role` is the GLOBAL role and nothing else. Reporting "the highest role held
 * anywhere" would mean iterating the snapshot's per-project and per-environment
 * maps and taking a maximum -- which is an authorization decision, and this
 * layer does not make those. A caller who needs to know what they may do to a
 * particular project asks about that project.
 */
export function whoamiRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/whoami",
    describe({
      summary: "Who the server thinks you are",
      description:
        "Derived entirely from the VERIFIED Access assertion plus the identity row it resolved — never from a header a client controls.\n\n`role` is the caller's **global** role, or `null`. It is not the maximum over every scope: a project-scoped admin reports `null` here and is still an admin of that project.\n\n`displayName` is the name Cloudflare Access holds for this caller, resolved lazily from `/cdn-cgi/access/get-identity` and cached on the identity row. It is COSMETIC — `subject` is the identifier, and nothing authorises on a name. It is `null` for service tokens, for providers that supply no name, and until the first lookup has run.\n\n`bootstrap` is true while the caller is an administrator by virtue of `BOOTSTRAP_ADMINS` alone. It goes false the moment the self-heal has converted the var into a real, revocable grant — which happens on the first authenticated request — and the UI shows a banner for exactly as long as it is true.\n\n`instance` is this deployment's permanent, random instance id: 32 lowercase hex characters, written into the database by a migration and never changed. It is the same value every authenticated response carries in the `Prick-Instance` header. A restored backup keeps it; a fresh database has a new one. `null` when the database holds no instance row.",
      tags: ["meta"],
      operationId: "whoami",
      responses: { 200: jsonResponse("The resolved identity.", WhoamiResponse) },
    }),
    async (c) => {
      const ctx = core(c);

      return c.json({
        kind: ctx.actor.kind,
        subject: ctx.actor.subject,
        identityId: ctx.actor.identityId,
        role: await resolveEffectiveRole(ctx, { type: "global" }),
        bootstrap: ctx.actor.bootstrap,
        displayName: ctx.actor.displayName,
        instance: await readInstanceId(ctx.db),
      });
    },
  );

  return app;
}

/**
 * What this server can do, and what the caller may do with it.
 *
 * Authenticated, like everything except `/health`: it names the instance and,
 * to a global admin, how the deployment is configured.
 */
export function capabilitiesRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/capabilities",
    describe({
      summary: "What this server can do",
      description:
        "For clients to decide, before sending anything, whether a feature is there and whether the caller may use it. Not a security boundary: every route still enforces its own authorization.\n\n`features.<name>.allowed` is whether **this caller** may use the feature. `reason` and `hint` are filled in for global administrators only — they describe how the deployment is configured, which nobody else needs to know — and are `null` for everyone else, whose unusable features read `unavailable` whatever the configuration.\n\n`limits` are the caps this deployment enforces, so a client can refuse an oversized write locally and name the offending key. `instance` is the same value as the `Prick-Instance` header.\n\nNew features add keys to `features`; clients ignore keys they do not know. `api` changes only with a breaking change to this API.",
      tags: ["meta"],
      operationId: "getCapabilities",
      responses: {
        200: jsonResponse("This server's capabilities, for this caller.", CapabilitiesResponse),
      },
    }),
    async (c) => c.json(await getCapabilities(core(c))),
  );

  return app;
}
