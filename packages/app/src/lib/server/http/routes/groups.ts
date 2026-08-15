import {
  AddGroupMemberBody,
  CreateGroupBody,
  CreateGroupGrantBody,
  UpdateGroupBody,
} from "@prick/shared";
import { Hono } from "hono";
import { z } from "zod";

import {
  addGroupMember,
  createGroup,
  createGroupGrant,
  deleteGroup,
  getGroup,
  listGroupGrants,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  revokeGroupGrant,
  updateGroup,
} from "../../core/groups.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import {
  GroupGrantParams,
  GroupGrantRecordResponse,
  GroupMemberParams,
  GroupMemberRecordResponse,
  GroupRecordResponse,
  IdParams,
} from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Groups: a roster that can hold grants.
 *
 * TWO DIFFERENT PERMISSION RULES LIVE ON THIS ROUTER, and the split is the whole
 * security argument for the feature:
 *
 *   THE GROUP ITSELF -- create, rename, delete, and every membership change --
 *   needs GLOBAL admin. Membership is the escalation surface. A project admin who
 *   could edit the roster of a group that also holds admin somewhere else could
 *   add themselves to it and walk out with access to a project they cannot
 *   even see. The two capabilities are individually reasonable and jointly a way
 *   to grant yourself access.
 *
 *   ITS GRANTS need admin AT THE SCOPE BEING GRANTED -- the same rule, resolved
 *   by the same code, as granting an identity. A project admin may decide what a
 *   roster may do inside their project. They cannot decide who is on it.
 *
 * The result is a clean division: somebody with global authority curates who is
 * in which group; each scope's admin decides what those groups may do there.
 */
export function groupRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/groups",
    describe({
      summary: "List groups",
      description:
        "Visible to **any** admin, at any scope — the same rule as `GET /identities`, and for the same reason: a project admin has to grant a role to a group within their project and cannot pick one from a list they may not see.\n\n`memberCount` and `grantCount` are both meaningful and independently zero. A group with members and no grants confers **nothing** — membership alone is never a permission.",
      tags: ["groups"],
      operationId: "listGroups",
      responses: {
        200: jsonResponse("Groups, ordered by slug.", z.array(GroupRecordResponse)),
      },
    }),
    async (c) => c.json(await listGroups(core(c))),
  );

  app.post(
    "/groups",
    describe({
      summary: "Create a group",
      description:
        "Requires **global** admin.\n\nCreating a group grants nobody anything: there is no role and no scope in the body, and the grant is a separate call requiring admin at the scope being granted. Folding the two together would make writing down “these five people work on payments” the same act as giving them access to it.\n\nGlobal rather than scoped, because a group is a global object whose membership is the escalation surface — see the note on `POST /groups/{id}/members`.",
      tags: ["groups"],
      operationId: "createGroup",
      requestBody: jsonBody("The group to create.", CreateGroupBody),
      responses: { 201: jsonResponse("The created group.", GroupRecordResponse) },
      errors: { 409: "`CONFLICT` — that slug is already in use." },
    }),
    validate("json", CreateGroupBody),
    async (c) => c.json(await createGroup(core(c), c.req.valid("json")), 201),
  );

  app.get(
    "/groups/:id",
    describe({
      summary: "Get a group",
      description: "Visible to any admin, at any scope.",
      tags: ["groups"],
      operationId: "getGroup",
      responses: { 200: jsonResponse("The group.", GroupRecordResponse) },
    }),
    validate("param", IdParams),
    async (c) => c.json(await getGroup(core(c), c.req.valid("param").id)),
  );

  app.patch(
    "/groups/:id",
    describe({
      summary: "Rename a group, or change its description",
      description:
        "Requires **global** admin.\n\n`slug` cannot be changed. It is how humans and scripts address the group, and a rename that silently repoints an identifier somebody else has written down is a change nobody notices until it matters. Delete and recreate instead — which is loud, and drops the grants with it.",
      tags: ["groups"],
      operationId: "updateGroup",
      requestBody: jsonBody("The fields to change.", UpdateGroupBody),
      responses: { 200: jsonResponse("The updated group.", GroupRecordResponse) },
    }),
    validate("param", IdParams),
    validate("json", UpdateGroupBody),
    async (c) => c.json(await updateGroup(core(c), c.req.valid("param").id, c.req.valid("json"))),
  );

  app.delete(
    "/groups/:id",
    describe({
      summary: "Delete a group",
      description:
        "Requires **global** admin, and refuses if it would remove the last administrator of the installation.\n\nThat guard is not decoration on this route: deleting the group that holds the only global admin grant locks the installation out exactly as thoroughly as revoking the last grant does, through an endpoint whose name does not contain the word “grant”. There is no recovery credential in this design, so it is refused rather than confirmed.\n\nMemberships and grants go with it, by `ON DELETE CASCADE`, in the same transaction.",
      tags: ["groups"],
      operationId: "deleteGroup",
      responses: { 204: { description: "Deleted." } },
      errors: {
        409: "`LAST_ADMIN` — this group holds the last usable global administrator and `BOOTSTRAP_ADMINS` is empty.",
      },
    }),
    validate("param", IdParams),
    async (c) => {
      await deleteGroup(core(c), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  app.get(
    "/groups/:id/members",
    describe({
      summary: "List a group's members",
      description:
        "Visible to any admin, at any scope.\n\nEach row carries the member's `disabled` flag, and it is not cosmetic: a disabled identity holds **nothing**, whatever the group has been granted, because the kill switch outranks every grant at every scope. Without the flag an operator reads a roster of five and believes five people have access.",
      tags: ["groups"],
      operationId: "listGroupMembers",
      responses: {
        200: jsonResponse("Members, ordered by subject.", z.array(GroupMemberRecordResponse)),
      },
    }),
    validate("param", IdParams),
    async (c) => c.json(await listGroupMembers(core(c), c.req.valid("param").id)),
  );

  app.post(
    "/groups/:id/members",
    describe({
      summary: "Add an identity to a group",
      description:
        'Requires **global** admin, and this is the rule the whole feature turns on.\n\nThe permissive alternative — "a project admin may manage the groups they grant into" — is a privilege escalation. Suppose `platform` holds admin on `payments` and on `billing`. The admin of `billing` may grant to `platform`: their scope, their decision. If they could also edit its membership they could add **themselves**, and walk out with admin on `payments`, a project they have nothing to do with, without anybody granting them anything.\n\nSo the capabilities are split: global authority curates who is on a roster, and each scope\'s admin decides what that roster may do there.\n\nA duplicate is a `409`, not a silent no-op.',
      tags: ["groups"],
      operationId: "addGroupMember",
      requestBody: jsonBody("The identity to add.", AddGroupMemberBody),
      responses: { 201: jsonResponse("The new membership.", GroupMemberRecordResponse) },
      errors: { 409: "`CONFLICT` — that identity is already in this group." },
    }),
    validate("param", IdParams),
    validate("json", AddGroupMemberBody),
    async (c) =>
      c.json(await addGroupMember(core(c), c.req.valid("param").id, c.req.valid("json")), 201),
  );

  app.delete(
    "/groups/:id/members/:identityId",
    describe({
      summary: "Remove an identity from a group",
      description:
        "Requires **global** admin.\n\nTakes effect on the **next request**, with nothing to invalidate: the authorization snapshot is cached per request, keyed on the request's own context object, so there is no longer-lived cache for a revocation to be missing from.\n\nRefuses if it would remove the last administrator of the installation.",
      tags: ["groups"],
      operationId: "removeGroupMember",
      responses: { 204: { description: "Removed." } },
      errors: {
        409: "`LAST_ADMIN` — this membership is the last usable global administrator and `BOOTSTRAP_ADMINS` is empty.",
      },
    }),
    validate("param", GroupMemberParams),
    async (c) => {
      const { id, identityId } = c.req.valid("param");
      await removeGroupMember(core(c), id, identityId);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // Grants held by the group
  // -------------------------------------------------------------------------

  app.get(
    "/groups/:id/grants",
    describe({
      summary: "List the grants a group holds",
      description:
        "Narrowed per row, exactly like `GET /grants`: a scoped admin sees the grants that touch what they administer and not the rest of the organisation's access graph. Being allowed to open the screen is not being allowed to read every row on it.\n\nExpired grants are excluded — an expired grant is not a grant.",
      tags: ["groups"],
      operationId: "listGroupGrants",
      responses: { 200: jsonResponse("Live grants.", z.array(GroupGrantRecordResponse)) },
    }),
    validate("param", IdParams),
    async (c) => c.json(await listGroupGrants(core(c), c.req.valid("param").id)),
  );

  app.post(
    "/groups/:id/grants",
    describe({
      summary: "Grant a role to a group",
      description:
        "Requires **admin at the scope being granted** — the same rule, the same scope resolution and the same check as `POST /grants`. A project admin may grant within their project; only a global admin may grant globally. There is no special case for groups, which is the point: the special case is where privilege escalation lives.\n\nThis is not an escalation route for the granting admin even when they are in the group themselves, because the role they can confer is bounded by the role they already hold at that scope. Adding somebody **else** to the group is the operation that would widen their reach, and that one is global-admin only.\n\nGrants are **purely additive**: effective role is the max over an identity's own grants and its groups', so a group can only raise a role, never lower one. There is no deny rule — removal is what revocation is for.\n\nA duplicate at the same scope is a `409`, not an upsert.",
      tags: ["groups"],
      operationId: "createGroupGrant",
      requestBody: jsonBody("The grant to create.", CreateGroupGrantBody),
      responses: { 201: jsonResponse("The created grant.", GroupGrantRecordResponse) },
      errors: { 409: "`CONFLICT` — that group already holds a grant at this scope." },
    }),
    validate("param", IdParams),
    validate("json", CreateGroupGrantBody),
    async (c) =>
      c.json(await createGroupGrant(core(c), c.req.valid("param").id, c.req.valid("json")), 201),
  );

  app.delete(
    "/groups/:id/grants/:grantId",
    describe({
      summary: "Revoke a grant from a group",
      description:
        "Requires **admin at that grant's scope**.\n\nAddressed through the group rather than by grant id alone, so a mismatched pair is a `404` — “no grant by that id in this group” — instead of revoking a grant belonging to a different group because a client paired the wrong two values.\n\nRefuses if it would remove the last administrator of the installation.",
      tags: ["groups"],
      operationId: "revokeGroupGrant",
      responses: { 204: { description: "Revoked." } },
      errors: {
        409: "`LAST_ADMIN` — this is the last usable global administrator and `BOOTSTRAP_ADMINS` is empty.",
      },
    }),
    validate("param", GroupGrantParams),
    async (c) => {
      const { id, grantId } = c.req.valid("param");
      await revokeGroupGrant(core(c), id, grantId);
      return c.body(null, 204);
    },
  );

  return app;
}
