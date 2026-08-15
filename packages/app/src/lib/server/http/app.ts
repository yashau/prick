import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { toErrorBody, statusFor } from "./errors.js";
import { requestId } from "./middleware.js";

export interface ApiEnv {
  Bindings: Env;
  Variables: {
    requestId: string;
  };
}

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
   * Versioned from day one. `/api/v1` is not aspirational: the CLI is a
   * separately released binary that users upgrade on their own schedule, so a
   * deployed Worker will always be serving some older client.
   *
   * TODO(build order steps 11-13): mount the route set --
   *   projects, environments,
   *   secrets (+ :batch, :import?dry_run, :export),
   *   versions + rollback,
   *   identities / grants / access/unknown-identities,
   *   audit,
   *   admin/rekey.
   * Plus the slug aliases /p/:slug/e/:slug/... for CLI ergonomics --
   * EXACT MATCH ONLY, never a prefix.
   */
  const v1 = new Hono<ApiEnv>();

  /**
   * Unauthenticated liveness probe.
   *
   * `prk login <url>` probes this endpoint first. If it answers 200 with JSON
   * for an UNAUTHENTICATED caller, the CLI emits a loud warning -- because that
   * means Cloudflare Access is not actually in front of this hostname, and an
   * unprotected secrets manager is the failure this whole design exists to
   * prevent. So this handler must never grow a field that reveals anything
   * beyond "something is listening here".
   */
  v1.get("/health", (c) => c.json({ status: "ok", version: "0.0.0-dev" }));

  app.route("/api/v1", v1);

  app.notFound((c) =>
    c.json(
      { code: "NOT_FOUND", message: "No such endpoint.", request_id: c.get("requestId") },
      404,
    ),
  );

  app.onError((error, c) => {
    const body = toErrorBody(error, c.get("requestId"));
    // TODO(build order step 12): audit with outcome 'error' / 'denied' here.
    return c.json(body, statusFor(error) as 400);
  });

  return app;
}

export type Api = ReturnType<typeof createApi>;
