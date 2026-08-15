import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { statusFor, toErrorBody } from "./errors.js";
import { keyring, requestId, type KeyringVariables } from "./middleware.js";

export interface ApiEnv {
  Bindings: Env;
  Variables: KeyringVariables & {
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
   *
   * It answers 200 only once the keyring middleware above has succeeded, which
   * is what makes "ok" mean something.
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
    // NOT audited here. An audit row needs an actor and a database, and this
    // handler catches failures that occur BEFORE either is resolved -- a
    // misconfigured keyring being the obvious one. Denials and decrypt failures
    // are audited at the point they happen, in `core`, where the actor is known.
    return c.json(body, statusFor(error) as 400);
  });

  return app;
}

export type Api = ReturnType<typeof createApi>;
