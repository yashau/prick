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
 * AUTHORIZATION LIVES IN `core`, NOT HERE
 * ---------------------------------------------------------------------------
 * Both handlers require GLOBAL admin, and both checks are the first statement of
 * the corresponding function in `core/keyring.ts`. This layer deliberately adds
 * none: authorization is written once, and a check here would be the second
 * place it lives -- two places that must agree, in the one area where they
 * silently disagreeing is a breach rather than a bug.
 *
 * `rekeyPage` is the reason that matters. It re-encrypts rows, so it is a
 * mutation, and a mutation reachable by any authenticated caller would be
 * unauthenticated in effect.
 *
 * ---------------------------------------------------------------------------
 * NOTHING RUNS THE REKEY ON A SCHEDULE
 * ---------------------------------------------------------------------------
 * There is no cron trigger in `wrangler.jsonc`. A rotation advances only when
 * something calls `POST /admin/rekey`, page by page, until `remaining` is zero
 * -- the settings screen has a button, and that is the whole mechanism. Do not
 * describe it as a background sweep anywhere until one exists.
 *
 * The rekey re-encrypts under the IDENTICAL AAD with a new `kid`, and the
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
        "Which key ids exist, how many rows still reference each, and whether `MASTER_KEY_OLD` can be removed. Requires global admin.\n\n`oldKeyLoaded` reports whether this deployment carries a second key at all, and it is the field that separates 'drained' from 'there was never anything to drain'. `safeToRemoveOldKey` is true only when every non-active kid has zero rows remaining, which is VACUOUSLY true on an install that has no old key and nothing stored. Only `oldKeyLoaded && safeToRemoveOldKey` means removing the key now loses nothing; render no instruction from `safeToRemoveOldKey` alone. Removing the old key while rows still reference a retired kid is the **one irreversible mistake** available in this design — those values can never be decrypted again — so the indicator only goes green at zero, and the UI has to be what tells you.\n\nThe counts are taken live over `secret_versions` and include **history**, not just current versions: an earlier version stranded under a retired kid is a rollback that stops working when the key goes.",
      tags: ["admin"],
      operationId: "getKeyringStatus",
      responses: { 200: jsonResponse("The ring.", KeyringStatusResponse) },
    }),
    async (c) => c.json(await getKeyringStatus(core(c))),
  );

  app.post(
    "/admin/rekey",
    describe({
      summary: "Re-encrypt one page of rows onto the active key",
      description:
        "Incremental and resumable: one page per invocation, so a large database never needs a batch that approaches the 30 s ceiling. Requires global admin.\n\n**Nothing calls this on a schedule.** There is no cron trigger; a rotation advances only while something keeps calling this endpoint, and it is finished when `remaining` reaches zero.\n\nThe re-encryption uses the **identical** AAD with the new `kid`, and the row's version is unchanged — a rekey alters the key that protects a row, never the row's identity.\n\nA row that cannot be decrypted fails the whole page rather than being skipped: a skipped row would still be counted as gone, and the ring would report itself safe to prune while an unreadable value remained.",
      tags: ["admin"],
      operationId: "rekeyPage",
      requestBody: jsonBody("How many rows to re-encrypt in this invocation.", RekeyBody),
      responses: { 200: jsonResponse("Progress.", RekeyResultResponse) },
    }),
    validate("json", RekeyBody),
    async (c) => c.json(await rekeyPage(core(c), c.req.valid("json").limit)),
  );

  return app;
}
