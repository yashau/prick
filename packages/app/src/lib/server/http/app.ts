import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { secureHeaders } from "hono/secure-headers";

import { authenticate } from "./context.js";
import type { ApiEnv } from "./env.js";
import { statusFor, toErrorBody } from "./errors.js";
import { bodyLimit, docsCsp, keyring, requestId, SCALAR_CDN } from "./middleware.js";
import { GENERATOR_OPTIONS } from "./openapi.js";
import { accessRoutes } from "./routes/access.js";
import { adminRoutes } from "./routes/admin.js";
import { auditRoutes } from "./routes/audit.js";
import { environmentCollectionRoutes, registerEnvironmentRoutes } from "./routes/environments.js";
import { groupRoutes } from "./routes/groups.js";
import { healthRoutes, whoamiRoutes } from "./routes/meta.js";
import { projectRoutes } from "./routes/projects.js";
import { registerSecretRoutes } from "./routes/secrets.js";

export type { ApiEnv } from "./env.js";

/**
 * The `/api` half of the Worker.
 *
 * It is created by a factory rather than exported as a module-scope singleton
 * so that the integration tests can build one against a stubbed environment
 * without the SvelteKit half existing at all -- which is what lets
 * `vitest.config.ts` point `main` at a Hono-only entry and never need a
 * SvelteKit build to run the server test suite.
 */
export function createApi() {
  const app = new Hono<ApiEnv>();

  app.use("*", requestId);

  // Applied to Worker responses. Static assets never reach this middleware --
  // they are served without invoking the Worker at all -- which is why
  // `static/_headers` exists alongside it.
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
      crossOriginOpenerPolicy: "same-origin",
      crossOriginResourcePolicy: "same-origin",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    }),
  );

  /*
   * THERE IS NO CORS MIDDLEWARE HERE AND THERE MUST NEVER BE ONE.
   *
   * Not an omission, and not something to "fix" when a browser request fails.
   * Omitting `Access-Control-Allow-Origin` entirely is the single mechanism that
   * stops any other site on the internet reading a response from this API in a
   * logged-in victim's browser -- the browser enforces it for free, and it is
   * the only defence that does not depend on this Worker getting a check right.
   *
   * The admin UI is served from the same origin by the same Worker, so it needs
   * nothing. A client that wants cross-origin access wants a service token and a
   * server-side call, which is what the CLI and the MCP package do.
   */

  /*
   * FAIL CLOSED, AHEAD OF EVERY ROUTE MOUNT.
   *
   * This line's POSITION is the feature. It runs before `/health`, before the
   * route set, before anything -- so a Worker whose `MASTER_KEY` is missing,
   * not base64, or not exactly 32 bytes answers 500 SERVER_MISCONFIGURED to
   * every request rather than booting half-working.
   *
   * Moving it below `app.route("/api/v1", v1)` would leave `/health` answering
   * 200 on an installation that cannot decrypt a single value -- and `/health`
   * is precisely what the CLI probes and what a deploy check curls, so the one
   * endpoint that would still work is the one whose answer everybody trusts.
   *
   * It is deliberately NOT wrapped in a try/catch here. The error propagates to
   * `onError`, which maps `MasterKeyConfigError` onto SERVER_MISCONFIGURED with
   * its original message -- the message names what is wrong with the key (and
   * never any part of the key itself), which is the only thing that makes the
   * failure fixable.
   */
  app.use("*", keyring);

  /*
   * Versioned from day one. `/api/v1` is not aspirational: the CLI is a
   * separately released binary that users upgrade on their own schedule, so a
   * deployed Worker will always be serving some older client.
   */
  const v1 = new Hono<ApiEnv>();

  // Unauthenticated, and the only route that is. Mounted before `authenticate`.
  v1.route("/", healthRoutes());

  /*
   * The reference viewer and the document itself.
   *
   * Deliberately ahead of `authenticate`, and worth being explicit about why
   * that is safe: this document describes the SHAPE of the API. It contains no
   * project slugs, no key names, no identities and no data of any kind -- it is
   * generated from the route table and from zod schemas, both of which are
   * already public in the source repository. Putting it behind Access would mean
   * an operator cannot read the reference to work out how to authenticate.
   *
   * Cloudflare Access sits in front of the whole hostname in a real deployment,
   * so this is defence in depth about content, not the access decision.
   */
  v1.get("/openapi.json", openAPIRouteHandler(app, GENERATOR_OPTIONS));

  /*
   * THE VIEWER LOADS THIRD-PARTY JAVASCRIPT, AND THAT IS WORTH BEING EXPLICIT
   * ABOUT ON A SECRETS MANAGER.
   *
   * `Scalar()` renders a page whose only content is a script tag pointing at
   * jsDelivr. Two mitigations, and one residual risk that is documented rather
   * than hidden:
   *
   *   PINNED. The `cdn` default is an unversioned URL, i.e. "whatever is latest
   *   at the moment a browser asks". That is a dependency this repository's
   *   supply-chain policy governs nowhere -- `minimumReleaseAge` applies to what
   *   pnpm resolves, not to what a page fetches at view time -- so the version
   *   is pinned here. jsDelivr serves versioned artefacts immutably, so a pinned
   *   URL cannot change under the deployment.
   *
   *   CONFINED. `docsCsp` gives this one route a policy whose important clause
   *   is `connect-src 'self'`: the page may fetch its own OpenAPI document and
   *   nothing else, so a compromised bundle has no egress. `form-action 'none'`
   *   and `base-uri 'none'` close the two ways a script exfiltrates without
   *   `fetch`.
   *
   *   RESIDUAL. The bundle still executes on this origin, and a browser will
   *   attach the viewer's Access cookie to same-origin requests -- so a
   *   compromised artefact could read the API as whoever is looking at the docs.
   *   The complete fix is to self-host the bundle as a static asset; until then
   *   this is a pinned, egress-confined third-party script and an operator who
   *   is unwilling to accept that should not mount this route.
   */
  v1.get(
    "/docs",
    docsCsp,
    Scalar({
      url: "/api/v1/openapi.json",
      pageTitle: "prick API",
      cdn: SCALAR_CDN,
    }),
  );

  /*
   * EVERYTHING BELOW THIS LINE REQUIRES A VERIFIED ACCESS ASSERTION.
   *
   * One middleware, mounted once, ahead of every remaining mount -- rather than
   * per router, which is how one router ends up mounted without it. It also
   * builds the `CoreContext` that every handler passes to `core`, so a route
   * that somehow escaped this line would not merely be unauthenticated: it would
   * have nothing to call `core` WITH, and would fail rather than serve.
   */
  v1.use("*", authenticate);

  // Body size, after authentication: an anonymous caller should not be able to
  // make this Worker read a megabyte before it decides it does not know them.
  v1.use("*", bodyLimit);

  v1.route("/", whoamiRoutes());
  v1.route("/projects", projectRoutes());
  v1.route("/projects/:project/environments", environmentCollectionRoutes());

  /*
   * THE SLUG ALIAS. One sub-application, two mounts.
   *
   * `/p/:project/e/:env/…` exists for CLI ergonomics -- typing the canonical
   * `/projects/x/environments/y/secrets` on a command line is a chore, and the
   * CLI addresses a scope as `project:environment` anyway. Both mounts serve the
   * SAME handlers, so there is no second implementation to drift, and the
   * parameter names are identical (`project`, `env`) so one validator covers
   * both.
   *
   * EXACT MATCH ONLY, never a prefix. That is a property of the `Slug` grammar
   * rather than of this router: slugs are `[a-z0-9]` with single interior
   * hyphens, which excludes `/` (so a slug cannot add a path segment) and `:`
   * (so `project:environment` has exactly one parse, and so `KEY:reveal` does
   * too).
   */
  const environmentApp = new Hono<ApiEnv>();
  registerEnvironmentRoutes(environmentApp);
  registerSecretRoutes(environmentApp);

  v1.route("/projects/:project/environments/:env", environmentApp);
  v1.route("/p/:project/e/:env", environmentApp);

  v1.route("/", accessRoutes());
  v1.route("/", groupRoutes());
  v1.route("/", auditRoutes());
  v1.route("/", adminRoutes());

  app.route("/api/v1", v1);

  app.notFound((c) =>
    c.json(
      { code: "NOT_FOUND", message: "No such endpoint.", request_id: c.get("requestId") },
      404,
    ),
  );

  app.onError((error, c) => {
    const body = toErrorBody(error, c.get("requestId"));
    // NOT audited here. An audit row needs an actor and a database, and this
    // handler catches failures that occur BEFORE either is resolved -- a
    // misconfigured keyring being the obvious one. Denials and decrypt failures
    // are audited at the point they happen, in `core`, where the actor is known.
    return c.json(body, statusFor(error) as 400);
  });

  return app;
}

export type Api = ReturnType<typeof createApi>;
