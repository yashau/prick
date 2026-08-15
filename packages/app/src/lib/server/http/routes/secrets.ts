import { BatchBody, ImportBody, RollbackBody } from "@prick/shared";
import { Hono } from "hono";
import { z } from "zod";

import { getEnvironment } from "../../core/environments.js";
import { PrickError } from "../../core/errors.js";
import {
  exportSecrets,
  importSecrets,
  listSecrets,
  listVersions,
  renameSecret,
  revealSecret,
  rollbackSecret,
  writeSecrets,
} from "../../core/secrets.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import {
  expectedRevFromIfMatch,
  noStore,
  reconcileExpectedRev,
  revisionEtag,
} from "../middleware.js";
import {
  describe,
  ETAG_HEADER,
  IF_MATCH_PARAMETER,
  jsonBody,
  jsonResponse,
  NO_STORE_HEADERS,
} from "../openapi.js";
import {
  EnvironmentParams,
  ExportResponse,
  ImportResultResponse,
  RenameBody,
  RenameResultResponse,
  RevealParams,
  RevealResponse,
  RevealQuery,
  RollbackResultResponse,
  SecretKeyParams,
  SecretListEntryResponse,
  VersionEntryResponse,
  WriteSecretsResultResponse,
} from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Secrets: the routes that carry values, and the ones that deliberately do not.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ROUTES THAT RETURN PLAINTEXT
 * ---------------------------------------------------------------------------
 * `GET …/secrets/{key}` (reveal) and `GET …/secrets:export`. Both are bound to
 * the `noStore` middleware by PATH, at the top of this function, rather than by
 * each handler setting three headers on its way out. The difference matters the
 * next time somebody adds a value-returning route: a handler-level convention is
 * something to remember, whereas a `use()` line sitting above the route table is
 * something to notice missing.
 *
 * Everything else in this file returns key NAMES, versions, counts and diffs.
 * Key names are plaintext metadata by design -- they live unencrypted in
 * `secrets.key` and are what makes the audit log readable.
 *
 * ---------------------------------------------------------------------------
 * ETag AND If-Match
 * ---------------------------------------------------------------------------
 * `GET …/secrets` answers with `ETag: "<rev>"`. Send it back as `If-Match` on a
 * write and the write becomes conditional; a mismatch is `412` and the
 * environment is left byte-for-byte unchanged, because `core`'s guard is a
 * deliberate constraint violation inside the same `batch()` -- the guard's
 * failure mode IS the rollback.
 *
 * `If-Match` is accepted only by the two routes that can honour it (`:batch` and
 * `:import`). On `:rename` and `:rollback` it is REFUSED with 400 rather than
 * ignored: `core` exposes no revision guard on those, and a caller who sent a
 * precondition believes their write is conditional. Answering 200 to that is
 * exactly the lost update the header exists to prevent.
 */
export function registerSecretRoutes(app: Hono<ApiEnv>): void {
  // Bound to the two value-returning paths, ahead of the route table, so the
  // binding is visible as a fact about the router rather than as three lines
  // inside two handlers.
  app.use("/secrets:export", noStore);
  app.use("/secrets/:key", noStore);

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  app.get(
    "/secrets",
    describe({
      summary: "List an environment's secrets",
      description:
        "Key names, versions and metadata. **No values, ever.** Every row is nonetheless decrypted and the plaintext discarded immediately, because `unreadable` cannot be determined any other way — AES-GCM has no verify-without-decrypting operation, the tag check IS the decryption. A row that fails comes back marked rather than omitted, and the read is audited with `outcome: 'error'`.",
      tags: ["secrets"],
      operationId: "listSecrets",
      responses: {
        200: {
          ...jsonResponse("The secrets, ordered by key.", z.array(SecretListEntryResponse)),
          headers: ETAG_HEADER,
        },
      },
    }),
    validate("param", EnvironmentParams),
    async (c) => {
      const { project, env } = c.req.valid("param");
      const ctx = core(c);

      /*
       * The revision is read BEFORE the listing, and the order is the
       * correctness argument rather than a style choice.
       *
       * Read it after, and a write landing in between would produce an `ETag`
       * NEWER than the listing it labels -- so a client that immediately writes
       * with `If-Match` would pass a guard against a revision whose contents it
       * has never seen, which is precisely the lost update the header exists to
       * prevent. Read it first and the same race produces an `ETag` that is
       * merely stale, the conditional write 412s, and the client re-reads.
       * Fails closed in the only direction that matters.
       */
      const environment = await getEnvironment(ctx, project, env);
      const entries = await listSecrets(ctx, project, env);

      c.header("ETag", revisionEtag(environment.rev));
      return c.json(entries);
    },
  );

  app.get(
    "/secrets/:key/versions",
    describe({
      summary: "List a key's version history",
      description:
        "Newest first, including tombstones — a `deleted` entry records that the key ceased to exist at that version, and occupies the number, which is what makes delete-then-recreate continue the sequence rather than collide with its own history.",
      tags: ["secrets"],
      operationId: "listSecretVersions",
      responses: {
        200: jsonResponse("The version history.", z.array(VersionEntryResponse)),
      },
    }),
    validate("param", SecretKeyParams),
    async (c) => {
      const { project, env, key } = c.req.valid("param");
      return c.json(await listVersions(core(c), project, env, key));
    },
  );

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  app.post(
    "/secrets:batch",
    describe({
      summary: "Write an environment's secrets atomically",
      description:
        "One D1 `batch()` — a real transaction — containing the revision bump, the new versions, the upserts, the tombstones, the deletes and the audit row, in that order with the audit row LAST. There is no partial application: either every statement lands or none does.\n\n`mode` decides what happens to keys named in neither `set` nor `delete`: `merge` leaves them alone, `replace` deletes them. A key named in both is a 422, because one order stores the value and the other tombstones it and the request does not say which was meant.\n\nOn a version race the losing batch writes **nothing** and is retried once against freshly read state; a second loss is `409`.",
      tags: ["secrets"],
      operationId: "writeSecrets",
      parameters: [IF_MATCH_PARAMETER],
      requestBody: jsonBody("The mutation to apply.", BatchBody),
      responses: {
        200: {
          ...jsonResponse(
            "The revision after the write, and the diff.",
            WriteSecretsResultResponse,
          ),
          headers: ETAG_HEADER,
        },
      },
      errors: {
        409: "`VERSION_CONFLICT` — another writer took the same version twice. Nothing was written.",
        412: "`PRECONDITION_FAILED` — `If-Match`/`expected_rev` did not match. The environment is byte-for-byte unchanged.",
        413: "`PAYLOAD_TOO_LARGE` — the write would leave more than `ENV_MAX_SECRETS` secrets, or the body is over `BODY_MAX_BYTES`. The cap exists because a full replace must fit in ONE batch; splitting it would forfeit atomicity, so the write is refused rather than made non-atomic.",
      },
    }),
    validate("param", EnvironmentParams),
    validate("json", BatchBody),
    async (c) => {
      const { project, env } = c.req.valid("param");
      const body = c.req.valid("json");

      const expectedRev = reconcileExpectedRev(expectedRevFromIfMatch(c), body.expected_rev);
      const input: BatchBody =
        expectedRev === undefined ? body : { ...body, expected_rev: expectedRev };

      const result = await writeSecrets(core(c), project, env, input);

      c.header("ETag", revisionEtag(result.rev));
      return c.json(result);
    },
  );

  app.post(
    "/secrets:import",
    describe({
      summary: "Import a `.env` or JSON blob",
      description:
        'With `dry_run: true` the server parses, validates and computes the diff **without writing**, through the same planning function the write path uses — so what it shows is what would happen rather than a second implementation that agrees by inspection.\n\nThe diff carries key names and change kinds only. `changed` means "this key already existed and is being rewritten"; it does **not** mean the value differs, and it cannot, because telling those apart would require decrypting every existing value to compare — a silent full-environment reveal performed by the screen whose purpose is to avoid one.',
      tags: ["secrets"],
      operationId: "importSecrets",
      parameters: [IF_MATCH_PARAMETER],
      requestBody: jsonBody("The blob, and how to apply it.", ImportBody),
      responses: { 200: jsonResponse("The diff.", ImportResultResponse) },
      errors: {
        409: "`VERSION_CONFLICT` — another writer took the same version twice.",
        412: "`PRECONDITION_FAILED` — the revision guard did not match.",
        413: "`PAYLOAD_TOO_LARGE` — over `ENV_MAX_SECRETS` or `BODY_MAX_BYTES`.",
      },
    }),
    validate("param", EnvironmentParams),
    validate("json", ImportBody),
    async (c) => {
      const { project, env } = c.req.valid("param");
      const body = c.req.valid("json");

      const expectedRev = reconcileExpectedRev(expectedRevFromIfMatch(c), body.expected_rev);
      const input: ImportBody =
        expectedRev === undefined ? body : { ...body, expected_rev: expectedRev };

      return c.json(await importSecrets(core(c), project, env, input));
    },
  );

  app.post(
    "/secrets:rename",
    describe({
      summary: "Rename a key",
      description:
        "There is no cheap rename and there cannot be one. The ciphertext is bound to the key NAME through the AAD, so moving the blob would fail its next tag check — and removing `key` from the AAD to make that work would reintroduce cross-key transplant, the vulnerability the AAD exists to close. So: decrypt under the old identity, re-encrypt under the new one, tombstone the old, all in one batch. The new version is `max(history of the DESTINATION key) + 1`, which matters when renaming onto a name that was previously used and deleted.",
      tags: ["secrets"],
      operationId: "renameSecret",
      requestBody: jsonBody("The old and new key names. Never a value.", RenameBody),
      responses: { 200: jsonResponse("The revision after the rename.", RenameResultResponse) },
      errors: { 409: "`CONFLICT` — a live secret already uses the destination name." },
    }),
    validate("param", EnvironmentParams),
    validate("json", RenameBody),
    async (c) => {
      rejectPrecondition(c.req.header("If-Match"), "secrets:batch");

      const { project, env } = c.req.valid("param");
      const { from, to } = c.req.valid("json");

      return c.json(await renameSecret(core(c), project, env, from, to));
    },
  );

  app.post(
    "/secrets:rollback",
    describe({
      summary: "Roll a key back to an earlier version",
      description:
        "A rollback moves FORWARD. Version N is decrypted and re-encrypted as `current + 1` under fresh AAD; the old envelope is never resurrected, because its AAD binds it to version N and writing those exact bytes back as current would fail the next read's tag check. History is append-only in both directions.\n\nRolling back to a tombstone is a 422 — that version recorded a deletion and carries no value.",
      tags: ["secrets"],
      operationId: "rollbackSecret",
      requestBody: jsonBody("The key and the version to restore.", RollbackBody),
      responses: {
        200: jsonResponse("The revision and the new version number.", RollbackResultResponse),
      },
    }),
    validate("param", EnvironmentParams),
    validate("json", RollbackBody),
    async (c) => {
      rejectPrecondition(c.req.header("If-Match"), "secrets:batch");

      const { project, env } = c.req.valid("param");
      return c.json(await rollbackSecret(core(c), project, env, c.req.valid("json")));
    },
  );

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  app.get(
    "/secrets:export",
    describe({
      summary: "Export every value in the environment",
      description:
        "A flat map of key to plaintext. **One** audit row for the export as a whole — an export is one decision by one person at one instant, and five hundred rows describing it would make the log worse rather than more complete.\n\nA single unreadable row FAILS THE WHOLE EXPORT. That is the loud choice and it is the right one: the alternative hands the operator a file that is silently missing a variable, which they discover in production.",
      tags: ["secrets"],
      operationId: "exportSecrets",
      responses: {
        200: {
          ...jsonResponse("Every key and its decrypted value.", ExportResponse),
          headers: NO_STORE_HEADERS,
        },
      },
      errors: {
        500: "`DECRYPT_FAILED` or `UNKNOWN_KID` — one row could not be opened, so the export is refused rather than silently short.",
      },
    }),
    validate("param", EnvironmentParams),
    async (c) => {
      const { project, env } = c.req.valid("param");
      return c.json(await exportSecrets(core(c), project, env));
    },
  );

  app.get(
    "/secrets/:key",
    describe({
      summary: "Reveal one value",
      description:
        'Fetches exactly the one row and audits it BEFORE returning. `reason` is what makes the log answer "did anyone take this" rather than merely "did anyone look at it": the UI sends `copy` for the copy button and `reveal` for the eye toggle, and `prk run` sends `run`.\n\nA decrypt failure fails the request. It is never downgraded to an empty string, an omitted key or a `null`, and the audit row is written before the throw so the record of the attempt survives the failure.\n\n**Two spellings.** `…/secrets/{key}` and `…/secrets/{key}:reveal` are the same operation; the suffix is accepted because a secret key is a POSIX name and therefore cannot contain a colon, so the parse is unambiguous.',
      tags: ["secrets"],
      operationId: "revealSecret",
      responses: {
        200: {
          ...jsonResponse("The key and its decrypted value.", RevealResponse),
          headers: NO_STORE_HEADERS,
        },
      },
      errors: {
        500: "`DECRYPT_FAILED` or `UNKNOWN_KID` — the stored bytes were not sealed against the identity they are being read under. Treat it as tampering until proven otherwise.",
      },
    }),
    validate("param", RevealParams),
    validate("query", RevealQuery),
    async (c) => {
      const { project, env, key } = c.req.valid("param");
      const { reason } = c.req.valid("query");

      const value = await revealSecret(core(c), project, env, key, reason);

      return c.json({ key, value });
    },
  );
}

/**
 * Refuse a precondition this route cannot evaluate.
 *
 * Silence is the wrong answer here. `core` gives `renameSecret` and
 * `rollbackSecret` no revision guard, so an `If-Match` on either could only be
 * discarded -- and a caller who sent one believes their write is conditional.
 * Answering 200 to that is a lost update produced by a header whose entire
 * purpose is to prevent one, so it is a 400 that names the route that does
 * support it.
 */
function rejectPrecondition(header: string | undefined, alternative: string): void {
  if (header === undefined || header.trim() === "") return;

  throw new PrickError("BAD_REQUEST", "This operation does not support a revision precondition.", {
    hint: `Only \`${alternative}\` and \`secrets:import\` evaluate If-Match. Re-read the environment and retry, or perform the change through \`${alternative}\`.`,
  });
}
