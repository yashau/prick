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
import { explainIdentityPermissions } from "../../core/permissions.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import {
  EffectivePermissionsResponse,
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
    "/identities/:id/effective-permissions",
    describe({
      summary: 'Why this identity has what it has ("why does Bob have production?")',
      description:
        'The question an access review actually asks is not "what is Bob\'s role" but "why does Bob have production, and what do I remove to stop that". A response of `"admin"` answers the first and leaves the second exactly as hard — and with groups in the model it is genuinely hard, because the answer can be a grant on the environment, a grant on its project, a global grant, any of those held by a group Bob is in, or the `BOOTSTRAP_ADMINS` var, none of which are visible from Bob\'s own row.\n\nSo each entry carries its `sources`: the rows that confer it, each naming the group it came through when it came through one, with exactly one marked `decisive`. "Remove this" is something the response says rather than something the reader derives.\n\n**Which scopes appear.** Only those some grant *names* — never the cross product of every project and environment. A global admin is one entry saying so, not one entry per project.\n\n**Sources include covering grants.** An entry for an environment lists the global and project-scoped grants that reach it, because "the platform group has admin on the project" *is* the answer. Listing only exact-scope matches would produce an entry with a role and no explanation.\n\n**A disabled identity** reports `role: null` on every entry, with the sources still listed and nothing decisive. The kill switch outranks every grant, so the honest answer is "nothing — and here is what re-enabling would restore".\n\nVisible to any admin, narrowed to the scopes the caller administers. Sources inside a visible entry are **not** narrowed: a project admin who can see that Bob has admin on their project must be able to see that it comes from a global grant on a group, or the entry has a role and no explanation again.',
      tags: ["access"],
      operationId: "explainIdentityPermissions",
      responses: {
        200: jsonResponse(
          "Every scope this identity holds a role at, and what conferred it.",
          EffectivePermissionsResponse,
        ),
      },
    }),
    validate("param", IdParams),
    async (c) => c.json(await explainIdentityPermissions(core(c), c.req.valid("param").id)),
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
