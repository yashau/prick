import { Hono } from "hono";

import { getKeyringStatus, rekeyPage } from "../../core/keyring.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import { KeyringStatusResponse, RekeyBody, RekeyResultResponse } from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Key ring status and rekeying.
 *
 * ---------------------------------------------------------------------------
 * BOTH HANDLERS CURRENTLY ANSWER 501, AND THAT IS ACCURATE
 * ---------------------------------------------------------------------------
 * `core/keyring.ts` is a pair of stubs that throw `NOT_IMPLEMENTED`. The routes
 * are mounted anyway, for two reasons: `501 NOT_IMPLEMENTED` is a truthful
 * answer that a client can branch on, whereas a `404` from an unmounted route is
 * indistinguishable from a typo; and mounting them now fixes the paths, so the
 * settings screen and the cron trigger are written against the surface they will
 * keep.
 *
 * ---------------------------------------------------------------------------
 * FOR WHOEVER IMPLEMENTS `core/keyring.ts`
 * ---------------------------------------------------------------------------
 * Neither stub performs an authorization check today, and this layer must not
 * add one -- authorization is written once, in `core`, and a check here would be
 * the second place it lives. So it has to go in there: both functions need
 * `assertRole(ctx, { type: "global" }, "admin")` as their first statement.
 *
 * Until then the 501 leaks nothing: it is the same answer for every
 * authenticated caller regardless of grants, and it reveals no data. But a
 * `rekeyPage` that starts re-encrypting rows without that line would be an
 * unauthenticated-in-effect mutation, so it is written down here as well as
 * there.
 *
 * The rekey itself re-encrypts under the IDENTICAL AAD with a new `kid`, and the
 * version does NOT change. That is exactly why `kid` lives in the envelope
 * rather than in the AAD: a rekey must not alter a row's identity, only the key
 * that protects it.
 */
export function adminRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/admin/keyring",
    describe({
      summary: "Key ring status",
      description:
        "Which key ids exist, how many rows still reference each, and whether `MASTER_KEY_OLD` can be removed.\n\n`safeToRemoveOldKey` is true only when every non-active kid has zero rows remaining. Removing the old key while rows still reference a retired kid is the **one irreversible mistake** available in this design — those values can never be decrypted again — so the indicator only goes green at zero, and the UI has to be what tells you.\n\n**Not implemented yet:** answers `501`.",
      tags: ["admin"],
      operationId: "getKeyringStatus",
      responses: { 200: jsonResponse("The ring.", KeyringStatusResponse) },
      errors: { 501: "`NOT_IMPLEMENTED` — the domain function is a stub in this build." },
    }),
    async (c) => c.json(await getKeyringStatus(core(c))),
  );

  app.post(
    "/admin/rekey",
    describe({
      summary: "Re-encrypt one page of rows onto the active key",
      description:
        "Incremental and resumable: a page per invocation, driven by this endpoint and by a cron trigger, so a large database never needs a batch that approaches the 30 s ceiling.\n\nThe re-encryption uses the **identical** AAD with the new `kid`, and the row's version is unchanged — a rekey alters the key that protects a row, never the row's identity.\n\n**Not implemented yet:** answers `501`.",
      tags: ["admin"],
      operationId: "rekeyPage",
      requestBody: jsonBody("How many rows to re-encrypt in this invocation.", RekeyBody),
      responses: { 200: jsonResponse("Progress.", RekeyResultResponse) },
      errors: { 501: "`NOT_IMPLEMENTED` — the domain function is a stub in this build." },
    }),
    validate("json", RekeyBody),
    async (c) => c.json(await rekeyPage(core(c), c.req.valid("json").limit)),
  );

  return app;
}
