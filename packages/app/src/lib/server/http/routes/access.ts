import { CreateGrantBody, UpdateIdentityBody } from "@prick/shared";
import { Hono } from "hono";
import { z } from "zod";

import {
  createGrant,
  listGrants,
  listIdentities,
  listUnknownIdentities,
  revokeGrant,
  updateIdentity,
} from "../../core/identities.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import {
  GrantRecordResponse,
  IdentityRecordResponse,
  IdParams,
  UnknownIdentityResponse,
} from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Identities, grants, and the screen that makes machine access usable.
 *
 * `GET /access/unknown-identities` is the highest-value route in this file and
 * it exists because of one fact: a service token's `common_name` is
 * `e367826f93b8d71185e03fe518aff3b4.access`, and nobody maps that to "staging
 * deploy" by looking at it. Access issues the tokens; there is no list to
 * browse, and this Worker sees one only when it arrives.
 *
 * Because every denial is audited, that list can be read back OUT of the audit
 * log -- which turns provisioning CI from "find the token id, copy it, create a
 * grant" into: point it at prick, watch it 403, click Grant.
 */
export function accessRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/identities",
    describe({
      summary: "List identities",
      description:
        "Visible to **any** admin, at any scope — not global admin only. A project admin has to grant access within their project, and cannot do that without seeing who there is to grant it to; restricting this to global admins would make delegated administration decorative.\n\nAn identity row exists for every subject that has ever authenticated, including ones that were then denied: the row is written on the authenticated request itself, which is what makes a denied service token grantable at all.",
      tags: ["access"],
      operationId: "listIdentities",
      responses: {
        200: jsonResponse("Identities, ordered by subject.", z.array(IdentityRecordResponse)),
      },
    }),
    async (c) => c.json(await listIdentities(core(c))),
  );

  app.patch(
    "/identities/:id",
    describe({
      summary: "Rename or disable an identity",
      description:
        "Requires **global** admin, because `disabled` is a kill switch that outranks every grant at every scope — including `BOOTSTRAP_ADMINS`. A project admin flipping it would be revoking access to projects they have nothing to do with.\n\n`display_name` is not cosmetic: an access list of opaque `common_name` hex strings is unreadable, which is how a stale token survives three audits.",
      tags: ["access"],
      operationId: "updateIdentity",
      requestBody: jsonBody("The fields to change.", UpdateIdentityBody),
      responses: { 200: jsonResponse("The updated identity.", IdentityRecordResponse) },
    }),
    validate("param", IdParams),
    validate("json", UpdateIdentityBody),
    async (c) =>
      c.json(await updateIdentity(core(c), c.req.valid("param").id, c.req.valid("json"))),
  );

  app.get(
    "/grants",
    describe({
      summary: "List grants",
      description:
        "Expired grants are excluded — an expired grant is not a grant. A scoped admin sees the grants that touch what they administer and not the rest of the organisation's access graph.",
      tags: ["access"],
      operationId: "listGrants",
      responses: { 200: jsonResponse("Live grants.", z.array(GrantRecordResponse)) },
    }),
    async (c) => c.json(await listGrants(core(c))),
  );

  app.post(
    "/grants",
    describe({
      summary: "Create a grant",
      description:
        'Requires **admin at the scope being granted**, resolved through the same check every other operation uses — a project admin may grant within their project, only a global admin may grant globally. That falls out of scope inheritance and needs no special case, which is the point: the special case is where privilege escalation lives.\n\nA duplicate is a `409`, not an upsert. Silently upgrading an existing reader grant to admin because somebody re-submitted a form is precisely the change nobody would notice.\n\nThe body is discriminated on `scope_type`, so scope fields are required exactly where they are meaningful and rejected where they are not; a flat object would accept `{scope_type: "global", project: "prod"}` and have to guess.',
      tags: ["access"],
      operationId: "createGrant",
      requestBody: jsonBody("The grant to create.", CreateGrantBody),
      responses: { 201: jsonResponse("The created grant.", GrantRecordResponse) },
      errors: { 409: "`CONFLICT` — that identity already holds a grant at this scope." },
    }),
    validate("json", CreateGrantBody),
    async (c) => c.json(await createGrant(core(c), c.req.valid("json")), 201),
  );

  app.delete(
    "/grants/:id",
    describe({
      summary: "Revoke a grant",
      description:
        'Refuses to remove the last global admin while `BOOTSTRAP_ADMINS` is empty. There is no recovery credential in this design — that is deliberate, and it means "are you sure?" is not a question a dialog can be trusted to ask. The only way back from an accidental lockout is editing a var and redeploying, so the operation is refused rather than confirmed.',
      tags: ["access"],
      operationId: "revokeGrant",
      responses: { 204: { description: "Revoked." } },
      errors: {
        409: "`LAST_ADMIN` — this is the last usable global administrator and `BOOTSTRAP_ADMINS` is empty.",
      },
    }),
    validate("param", IdParams),
    async (c) => {
      await revokeGrant(core(c), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  app.get(
    "/access/unknown-identities",
    describe({
      summary:
        'Subjects that authenticated, were denied, and hold no grant ("Seen but not granted")',
      description:
        "Read out of the audit log rather than from a table of pending requests, because there is nothing to pend: Access authenticates the caller at the edge and this Worker learns a subject exists at the moment it refuses it.\n\nSubjects that DO hold a live grant are excluded — they were denied something narrower than what they hold, which is ordinary authorization working rather than a missing introduction.\n\nThere is no id in these rows. Match `subject` against `GET /identities` to obtain the `identity_id` that `POST /grants` needs.",
      tags: ["access"],
      operationId: "listUnknownIdentities",
      responses: {
        200: jsonResponse(
          "Denied subjects, most recently seen first.",
          z.array(UnknownIdentityResponse),
        ),
      },
    }),
    async (c) => c.json(await listUnknownIdentities(core(c))),
  );

  return app;
}
