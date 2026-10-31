import {
  AdoptServiceTokenBody,
  CreateServiceTokenBody,
  ReconcileServiceTokensBody,
  RotateServiceTokenBody,
} from "@prick/shared";
import { Hono } from "hono";

import {
  adoptServiceToken,
  createServiceToken,
  listServiceTokens,
  refreshServiceToken,
  revokeServiceToken,
  rotateServiceToken,
} from "../../core/service-tokens.js";
import { reconcileServiceTokens } from "../../core/service-token-reconcile.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { noStore } from "../middleware.js";
import { describe, jsonBody, jsonResponse, NO_STORE_HEADERS } from "../openapi.js";
import {
  IdParams,
  IssuedServiceTokenResponse,
  ReconcileResultResponse,
  RotatedServiceTokenResponse,
  ServiceTokenListResponse,
  ServiceTokenRecordResponse,
} from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Cloudflare Access service tokens, managed by this Worker.
 *
 * Every route is **global admin** only, and every route answers
 * `503 SERVICE_TOKENS_UNCONFIGURED` -- after the admin check, so a non-admin
 * learns nothing about configuration -- when the Worker has no `CF_API_TOKEN`
 * secret or `CF_ACCOUNT_ID` var. `GET /capabilities` reports the same thing
 * without the round trip.
 *
 * The two responses that carry a client secret are `no-store`, by path, ahead
 * of the handlers -- the same mechanism the secret export uses.
 */
export function serviceTokenRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.use("/service-tokens", async (c, next) =>
    c.req.method === "POST" ? noStore(c, next) : next(),
  );
  app.use("/service-tokens/:id/rotate", noStore);

  const unconfigured =
    "`SERVICE_TOKENS_UNCONFIGURED` — the Worker has no `CF_API_TOKEN` secret or `CF_ACCOUNT_ID` var, or Cloudflare refused the token it holds. The hint names which.";
  const upstream =
    "`UPSTREAM_FAILED` — the Cloudflare API failed. The hint says whether anything was left half done.";

  app.get(
    "/service-tokens",
    describe({
      summary: "List managed service tokens",
      description:
        'Every service token this deployment manages, revoked ones included, each with Cloudflare\'s live view of it (expiry, last use, leak reports) when Cloudflare could be asked. `cloudflare: "unavailable"` says it could not, in which case each record\'s `cloudflare` is `null` and no record is reported `missing`.\n\n`status: "missing"` is a token prick still considers live that Cloudflare no longer has — deleted in the dashboard. `POST /service-tokens/reconcile` retires it.',
      tags: ["service-tokens"],
      operationId: "listServiceTokens",
      responses: {
        200: jsonResponse("Managed service tokens, oldest first.", ServiceTokenListResponse),
      },
      errors: { 503: unconfigured },
    }),
    async (c) => c.json(await listServiceTokens(core(c))),
  );

  app.post(
    "/service-tokens",
    describe({
      summary: "Create a service token",
      description:
        "Asks Cloudflare for a new Access service token, then records the identity it authenticates as — subject = its client id, display name = `name` — and, if `grant` is given, that grant, in one transaction with its audit rows. The token's first request is therefore already authorized; it never has to be refused first to introduce itself.\n\n**The client secret is in this response and nowhere else.** prick stores no copy and no derivative of it, and the response is `no-store`. Lose it and rotate.\n\nThe grant needs admin at its scope, which a global admin always has; a project or environment that does not exist is a `404` before Cloudflare is asked for anything.\n\nIf the transaction fails after Cloudflare issued the token, the token is deleted again before the error is returned, so nothing usable is left behind.",
      tags: ["service-tokens"],
      operationId: "createServiceToken",
      requestBody: jsonBody(
        "The token's name, lifetime and optional first grant.",
        CreateServiceTokenBody,
      ),
      responses: {
        201: {
          ...jsonResponse(
            "The new token, its grant, and its client secret (shown once).",
            IssuedServiceTokenResponse,
          ),
          headers: NO_STORE_HEADERS,
        },
      },
      errors: { 502: upstream, 503: unconfigured },
    }),
    validate("json", CreateServiceTokenBody),
    async (c) => c.json(await createServiceToken(core(c), c.req.valid("json")), 201),
  );

  app.post(
    "/service-tokens/adopt",
    describe({
      summary: "Adopt a service token made in the dashboard",
      description:
        "Brings an existing Cloudflare service token, found by client id, under this deployment's management so it can be rotated, extended and revoked here. Its identity is created if the token has never authenticated, and reused — grants and all — if it has. No secret is involved or returned.",
      tags: ["service-tokens"],
      operationId: "adoptServiceToken",
      requestBody: jsonBody(
        "The token's client id and an optional display name.",
        AdoptServiceTokenBody,
      ),
      responses: { 201: jsonResponse("The adopted token.", ServiceTokenRecordResponse) },
      errors: {
        409: "`CONFLICT` — that token is already managed here.",
        502: upstream,
        503: unconfigured,
      },
    }),
    validate("json", AdoptServiceTokenBody),
    async (c) => c.json(await adoptServiceToken(core(c), c.req.valid("json")), 201),
  );

  app.post(
    "/service-tokens/reconcile",
    describe({
      summary: "Find, and optionally repair, disagreements with Cloudflare",
      description:
        "`orphan`: a Cloudflare token named for THIS deployment (`prick:<instance>:…`) that prick has no record of — a create that crashed between Cloudflare and D1. `missing`: a live record whose token Cloudflare no longer has. `revoke_incomplete`: a revoked record whose token still exists in Cloudflare. `foreign`: a token named for another prick deployment sharing the account — reported, never touched.\n\nWith `apply: true`, orphans and incomplete revocations are deleted from Cloudflare and missing tokens are retired (identity disabled), each with its own audit row. Tokens with any other name were made by hand and are not considered.",
      tags: ["service-tokens"],
      operationId: "reconcileServiceTokens",
      requestBody: jsonBody("Whether to repair what is found.", ReconcileServiceTokensBody),
      responses: {
        200: jsonResponse("What disagreed, and what was repaired.", ReconcileResultResponse),
      },
      errors: { 502: upstream, 503: unconfigured },
    }),
    validate("json", ReconcileServiceTokensBody),
    async (c) => c.json(await reconcileServiceTokens(core(c), c.req.valid("json"))),
  );

  app.post(
    "/service-tokens/:id/rotate",
    describe({
      summary: "Rotate a service token's secret",
      description:
        "A new client secret for the same client id, so the identity and every grant it holds are unchanged. `grace_seconds` keeps the previous secret valid that long (at most 30 days); `0`, the default, ends it immediately — the right answer when it leaked.\n\nThe new secret is in this response only, and the response is `no-store`. A rotation whose audit row cannot be written is refused and its secret discarded.",
      tags: ["service-tokens"],
      operationId: "rotateServiceToken",
      requestBody: jsonBody("How long the previous secret stays valid.", RotateServiceTokenBody),
      responses: {
        200: {
          ...jsonResponse(
            "The token and its new client secret (shown once).",
            RotatedServiceTokenResponse,
          ),
          headers: NO_STORE_HEADERS,
        },
      },
      errors: { 502: upstream, 503: unconfigured },
    }),
    validate("param", IdParams),
    validate("json", RotateServiceTokenBody),
    async (c) =>
      c.json(await rotateServiceToken(core(c), c.req.valid("param").id, c.req.valid("json"))),
  );

  app.post(
    "/service-tokens/:id/refresh",
    describe({
      summary: "Extend a service token's expiry",
      description:
        "Asks Cloudflare to extend the token's expiry by its duration. No new secret; nothing about the identity changes.",
      tags: ["service-tokens"],
      operationId: "refreshServiceToken",
      responses: {
        200: jsonResponse("The token, with its new expiry.", ServiceTokenRecordResponse),
      },
      errors: { 502: upstream, 503: unconfigured },
    }),
    validate("param", IdParams),
    async (c) => c.json(await refreshServiceToken(core(c), c.req.valid("param").id)),
  );

  app.delete(
    "/service-tokens/:id",
    describe({
      summary: "Revoke a service token",
      description:
        "Disables the token's identity — the kill switch, which outranks every grant — and marks the record revoked, in one transaction with its audit row; then deletes the token from Cloudflare. The order means access is gone the moment the transaction commits. If the Cloudflare delete fails, the response is `502` and the token, already refused by prick, is finished by `POST /service-tokens/reconcile`.\n\nGrants are kept as the record of what the token held; `GET /identities/{id}/effective-permissions` still lists them.",
      tags: ["service-tokens"],
      operationId: "revokeServiceToken",
      responses: { 204: { description: "Revoked." } },
      errors: {
        409: "`LAST_ADMIN` — this token is the last usable global administrator and `BOOTSTRAP_ADMINS` is empty.",
        502: upstream,
        503: unconfigured,
      },
    }),
    validate("param", IdParams),
    async (c) => {
      await revokeServiceToken(core(c), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  return app;
}
