import type {
  AddGroupMemberBody,
  CreateGroupBody,
  CreateGroupGrantBody,
  IdentityKind,
  Role,
  UpdateGroupBody,
} from "@prick/shared";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";

import { resolveAuthorization } from "../auth/authorize.js";
import { assertNotLastAdminAfter } from "../auth/bootstrap.js";
import { uuidv7 } from "../db/ids.js";
import {
  environments,
  groupGrants,
  groupMembers,
  groups,
  identities,
  projects,
  type Group,
} from "../db/schema.js";
import { auditStatement } from "./audit.js";
import type { CoreContext, Scope } from "./context.js";
import { PrickError, notFound } from "./errors.js";
import { assertRole } from "./guards.js";
import { assertAnyAdmin, resolveGrantScope } from "./identities.js";
import { slugConflict } from "./projects.js";
import { runBatch } from "./sql.js";

/**
 * Groups: a named set of identities that can hold grants.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROPERTIES THAT MAKE THIS SAFE TO ADD
 * ---------------------------------------------------------------------------
 *
 *   ADDITIVE ONLY. Effective role is the MAX over the identity's own grants and
 *   those of every group it belongs to. There is no deny rule and there will not
 *   be one: a deny that silently overrides an explicit grant means the access
 *   graph can no longer be read by reading it, and the person who needs to read
 *   it is doing so during an incident.
 *
 *   FLAT. Groups hold identities, never groups. No cycle detection exists in
 *   this file because there are no cycles to detect.
 *
 *   MEMBERSHIP ALONE CONFERS NOTHING. A group with no grants is a list. That is
 *   enforced in SQL rather than here -- `loadSnapshot` reaches `group_grants`
 *   through an INNER join, so a memberless-of-grants group contributes no rows
 *   at all.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY DO WHAT, AND THE ONE ARGUMENT WORTH HAVING
 * ---------------------------------------------------------------------------
 * Creating, renaming, deleting a group and CHANGING ITS MEMBERSHIP all require
 * GLOBAL admin. Granting a group a role at a scope requires admin AT THAT SCOPE,
 * exactly like granting an identity one.
 *
 * The membership rule is the one that deserves the argument, because the
 * permissive reading -- "a project admin should be able to manage the groups
 * they grant into" -- is superficially reasonable and is a privilege escalation.
 * Concretely: `platform` holds admin on project `payments` and on project
 * `billing`. The admin of `billing` may grant to `platform` (their scope, their
 * decision). If they could also edit its membership, they could add THEMSELVES,
 * and walk out with admin on `payments` -- a project they have nothing to do
 * with -- without anybody granting them anything. The two capabilities are
 * individually reasonable and jointly a way to grant yourself access, which is
 * the definition of the confused deputy.
 *
 * Splitting them costs a project admin nothing they should have had: they decide
 * what a roster may do inside their project, and somebody with global authority
 * decides who is on it. Creation and deletion follow membership for the same
 * reason and one more -- deleting a group revokes its access in every project at
 * once, including projects the deleter cannot see.
 */

export interface GroupRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** How many identities are in it. Zero is normal and not an error. */
  memberCount: number;
  /** How many live grants it holds. Zero means it confers nothing. */
  grantCount: number;
  updatedAt: number;
}

export interface GroupMemberRecord {
  identityId: string;
  kind: IdentityKind;
  subject: string;
  displayName: string | null;
  /**
   * The member's kill switch, surfaced here on purpose.
   *
   * A disabled identity in a privileged group holds nothing -- `disabled`
   * outranks every grant at every scope. Showing the flag on the membership row
   * is what stops an operator reading a roster of five and believing five people
   * have access.
   */
  disabled: boolean;
  addedAt: number;
  addedBy: string;
}

export interface GroupGrantRecord {
  id: string;
  groupId: string;
  groupSlug: string;
  role: Role;
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

/** `expires_at IS NULL OR expires_at > now`. An expired grant is not a grant. */
function liveGroupGrant(now: number) {
  return or(isNull(groupGrants.expiresAt), gt(groupGrants.expiresAt, now));
}

function asRole(value: string): Role {
  return value === "admin" || value === "writer" ? value : "reader";
}

function asScopeType(value: string): "global" | "project" | "environment" {
  return value === "global" || value === "environment" ? value : "project";
}

// ---------------------------------------------------------------------------
// The groups themselves
// ---------------------------------------------------------------------------

/**
 * List groups. Visible to ANY admin, at any scope.
 *
 * The same rule as `listIdentities`, for the same reason: a project admin has to
 * be able to grant a role to a group within their project, and they cannot pick
 * one from a list they are not allowed to see. What a group's NAME discloses is
 * an organisational roster, which is a much weaker disclosure than the per-row
 * narrowing on `listGroupGrants` below is protecting -- who has access to what.
 */
export async function listGroups(ctx: CoreContext): Promise<GroupRecord[]> {
  await assertAnyAdmin(ctx);

  const rows = await ctx.db.select().from(groups).orderBy(groups.slug);
  if (rows.length === 0) return [];

  const memberRows = await ctx.db
    .select({ groupId: groupMembers.groupId, value: count() })
    .from(groupMembers)
    .groupBy(groupMembers.groupId);

  const grantRows = await ctx.db
    .select({ groupId: groupGrants.groupId, value: count() })
    .from(groupGrants)
    .where(liveGroupGrant(ctx.now))
    .groupBy(groupGrants.groupId);

  const members = new Map(memberRows.map((row) => [row.groupId, row.value]));
  const held = new Map(grantRows.map((row) => [row.groupId, row.value]));

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    memberCount: members.get(row.id) ?? 0,
    grantCount: held.get(row.id) ?? 0,
    updatedAt: row.updatedAt,
  }));
}

/** The raw row, or a 404. Does not check visibility; callers do that. */
async function findGroup(ctx: CoreContext, id: string): Promise<Group> {
  const rows = await ctx.db.select().from(groups).where(eq(groups.id, id)).limit(1);

  const group = rows[0];
  if (group === undefined) throw notFound("group");

  return group;
}

export async function getGroup(ctx: CoreContext, id: string): Promise<GroupRecord> {
  await assertAnyAdmin(ctx);

  const group = await findGroup(ctx, id);

  const memberRows = await ctx.db
    .select({ value: count() })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, id));

  const grantRows = await ctx.db
    .select({ value: count() })
    .from(groupGrants)
    .where(and(eq(groupGrants.groupId, id), liveGroupGrant(ctx.now)));

  return {
    id: group.id,
    slug: group.slug,
    name: group.name,
    description: group.description,
    memberCount: memberRows[0]?.value ?? 0,
    grantCount: grantRows[0]?.value ?? 0,
    updatedAt: group.updatedAt,
  };
}

/** Create a group. GLOBAL admin -- see the header. Confers nothing on anybody. */
export async function createGroup(ctx: CoreContext, input: CreateGroupBody): Promise<GroupRecord> {
  await assertRole(ctx, { type: "global" }, "admin");

  const id = uuidv7(ctx.now);

  const row = {
    id,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.actor.subject,
  };

  try {
    await runBatch(ctx.db, [
      ctx.db.insert(groups).values(row),
      auditStatement(ctx, {
        action: "group.create",
        outcome: "success",
        detail: { kind: "resource", slug: input.slug },
      }),
    ]);
  } catch (error) {
    throw slugConflict(error, "group", input.slug);
  }

  return {
    id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    memberCount: 0,
    grantCount: 0,
    updatedAt: row.updatedAt,
  };
}

export async function updateGroup(
  ctx: CoreContext,
  id: string,
  input: UpdateGroupBody,
): Promise<GroupRecord> {
  await assertRole(ctx, { type: "global" }, "admin");

  const group = await findGroup(ctx, id);

  const fields: string[] = [];
  const patch: { name?: string; description?: string | null; updatedAt: number } = {
    updatedAt: ctx.now,
  };

  if (input.name !== undefined) {
    patch.name = input.name;
    fields.push("name");
  }
  if (input.description !== undefined) {
    patch.description = input.description;
    fields.push("description");
  }

  await runBatch(ctx.db, [
    ctx.db.update(groups).set(patch).where(eq(groups.id, id)),
    auditStatement(ctx, {
      action: "group.update",
      outcome: "success",
      detail: { kind: "resource", slug: group.slug, fields },
    }),
  ]);

  return getGroup(ctx, id);
}

/**
 * Delete a group.
 *
 * ONE STATEMENT. `ON DELETE CASCADE` removes its memberships and its grants in
 * the same transaction; there is no hand-rolled cascade to get half-right.
 *
 * Guarded by the last-administrator check, and that guard is the reason it takes
 * an exclusion rather than a grant id: deleting the group that holds the only
 * global admin grant locks the installation out just as thoroughly as revoking
 * the last grant does, through a route whose name does not contain the word
 * "grant". There is no recovery credential in this design, so it is refused
 * rather than confirmed.
 */
export async function deleteGroup(ctx: CoreContext, id: string): Promise<void> {
  await assertRole(ctx, { type: "global" }, "admin");

  const group = await findGroup(ctx, id);

  await assertNotLastAdminAfter(ctx, { groupId: id });

  // Counted BEFORE the delete, for the audit row. Afterwards they are zero, and
  // "deleted a group" without "…which held 3 grants and 14 members" is not an
  // account anybody can act on.
  const memberRows = await ctx.db
    .select({ value: count() })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, id));

  const grantRows = await ctx.db
    .select({ value: count() })
    .from(groupGrants)
    .where(eq(groupGrants.groupId, id));

  await runBatch(ctx.db, [
    ctx.db.delete(groups).where(eq(groups.id, id)),
    auditStatement(ctx, {
      action: "group.delete",
      outcome: "success",
      detail: {
        kind: "resource",
        slug: group.slug,
        cascade: {
          members: memberRows[0]?.value ?? 0,
          grants: grantRows[0]?.value ?? 0,
        },
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export async function listGroupMembers(
  ctx: CoreContext,
  groupId: string,
): Promise<GroupMemberRecord[]> {
  await assertAnyAdmin(ctx);
  await findGroup(ctx, groupId);

  const rows = await ctx.db
    .select({
      identityId: identities.id,
      kind: identities.kind,
      subject: identities.subject,
      displayName: identities.displayName,
      disabled: identities.disabled,
      addedAt: groupMembers.addedAt,
      addedBy: groupMembers.addedBy,
    })
    .from(groupMembers)
    .innerJoin(identities, eq(identities.id, groupMembers.identityId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(identities.subject);

  return rows.map((row) => ({
    identityId: row.identityId,
    kind: row.kind === "service" ? ("service" as const) : ("user" as const),
    subject: row.subject,
    displayName: row.displayName,
    disabled: row.disabled,
    addedAt: row.addedAt,
    addedBy: row.addedBy,
  }));
}

/**
 * Add an identity to a group. GLOBAL admin.
 *
 * A duplicate is a CONFLICT rather than a no-op, for the same reason a duplicate
 * grant is: `group_members_group_identity_uniq` detects it, and an idempotent
 * "already there, never mind" would make a UI that double-submits
 * indistinguishable from one that is adding somebody twice by mistake.
 */
export async function addGroupMember(
  ctx: CoreContext,
  groupId: string,
  input: AddGroupMemberBody,
): Promise<GroupMemberRecord> {
  await assertRole(ctx, { type: "global" }, "admin");

  const group = await findGroup(ctx, groupId);

  const rows = await ctx.db
    .select()
    .from(identities)
    .where(eq(identities.id, input.identity_id))
    .limit(1);

  const identity = rows[0];
  if (identity === undefined) throw notFound("identity");

  try {
    await runBatch(ctx.db, [
      ctx.db.insert(groupMembers).values({
        groupId,
        identityId: identity.id,
        addedAt: ctx.now,
        addedBy: ctx.actor.subject,
      }),
      auditStatement(ctx, {
        action: "group.member.add",
        outcome: "success",
        detail: { kind: "group.member", group: group.slug, subject: identity.subject },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new PrickError("CONFLICT", "That identity is already in this group.", {
        hint: "Membership is a set. Nothing was changed.",
        cause: error,
      });
    }
    throw error;
  }

  return {
    identityId: identity.id,
    kind: identity.kind === "service" ? "service" : "user",
    subject: identity.subject,
    displayName: identity.displayName,
    disabled: identity.disabled,
    addedAt: ctx.now,
    addedBy: ctx.actor.subject,
  };
}

/**
 * Remove an identity from a group. GLOBAL admin.
 *
 * TAKES EFFECT ON THE NEXT REQUEST, with nothing to invalidate. The
 * authorization snapshot is cached per REQUEST, keyed on the context object, so
 * there is no cross-request cache for a revocation to be missing from -- the
 * request that follows this one re-runs the join and the role is gone. That
 * property is why the snapshot is a `WeakMap` on the context rather than
 * anything longer-lived, and it is asserted directly in the HTTP suite.
 */
export async function removeGroupMember(
  ctx: CoreContext,
  groupId: string,
  identityId: string,
): Promise<void> {
  await assertRole(ctx, { type: "global" }, "admin");

  const group = await findGroup(ctx, groupId);

  const rows = await ctx.db
    .select({ subject: identities.subject })
    .from(groupMembers)
    .innerJoin(identities, eq(identities.id, groupMembers.identityId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, identityId)))
    .limit(1);

  const member = rows[0];
  if (member === undefined) throw notFound("group member");

  await assertNotLastAdminAfter(ctx, { membership: { groupId, identityId } });

  await runBatch(ctx.db, [
    ctx.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.identityId, identityId))),
    auditStatement(ctx, {
      action: "group.member.remove",
      outcome: "success",
      detail: { kind: "group.member", group: group.slug, subject: member.subject },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Grants held by a group
// ---------------------------------------------------------------------------

/**
 * The grants one group holds.
 *
 * NARROWED PER ROW, exactly like `listGrants`. A project admin may see that the
 * `platform` group holds admin on THEIR project; they may not read the rest of
 * the organisation's access graph off a group they happen to be allowed to grant
 * to. Being allowed to open the screen is not being allowed to read every row on
 * it.
 */
export async function listGroupGrants(
  ctx: CoreContext,
  groupId: string,
): Promise<GroupGrantRecord[]> {
  await assertAnyAdmin(ctx);
  await findGroup(ctx, groupId);

  const snapshot = await resolveAuthorization(ctx);
  const globalAdmin = snapshot.bootstrap || snapshot.globalRole === "admin";

  const rows = await ctx.db
    .select({
      id: groupGrants.id,
      groupId: groupGrants.groupId,
      groupSlug: groups.slug,
      role: groupGrants.role,
      scopeType: groupGrants.scopeType,
      projectId: groupGrants.projectId,
      environmentId: groupGrants.environmentId,
      projectSlug: projects.slug,
      environmentSlug: environments.slug,
      expiresAt: groupGrants.expiresAt,
    })
    .from(groupGrants)
    .innerJoin(groups, eq(groups.id, groupGrants.groupId))
    .leftJoin(projects, eq(projects.id, groupGrants.projectId))
    .leftJoin(environments, eq(environments.id, groupGrants.environmentId))
    .where(and(eq(groupGrants.groupId, groupId), liveGroupGrant(ctx.now)));

  const out: GroupGrantRecord[] = [];

  for (const row of rows) {
    if (!globalAdmin) {
      const administers =
        (row.projectId !== null && snapshot.byProject.get(row.projectId) === "admin") ||
        (row.environmentId !== null && snapshot.byEnvironment.get(row.environmentId) === "admin");

      if (!administers) continue;
    }

    out.push({
      id: row.id,
      groupId: row.groupId,
      groupSlug: row.groupSlug,
      role: asRole(row.role),
      scopeType: asScopeType(row.scopeType),
      projectSlug: row.projectSlug,
      environmentSlug: row.environmentSlug,
      expiresAt: row.expiresAt,
    });
  }

  return out;
}

/**
 * Grant a role to a group. ADMIN AT THE SCOPE BEING GRANTED.
 *
 * The same rule and the same code path as granting an identity -- the scope is
 * resolved by the same `resolveGrantScope`, and checked by the same
 * `assertRole`. A project admin may grant within their project; only a global
 * admin may grant globally. There is no special case for groups, which is the
 * point: the special case is where privilege escalation lives.
 *
 * This is NOT an escalation route for the granting admin even when they are
 * themselves in the group, because the role they can confer on it is bounded by
 * the role they already hold at that scope. Adding somebody ELSE to the group is
 * the operation that would let them widen their own reach, and that one is
 * global-admin only.
 */
export async function createGroupGrant(
  ctx: CoreContext,
  groupId: string,
  input: CreateGroupGrantBody,
): Promise<GroupGrantRecord> {
  // Scope, then role, then the group -- the same order as `createGrant`, and the
  // order matters. Looking the group up first would answer "that group exists"
  // to a caller who is about to be refused, which is an existence oracle for
  // free. Resolving the scope first also means an unauthorized project slug is a
  // 404 from `requireProject` rather than a 403 from here.
  const resolved = await resolveGrantScope(ctx, input);

  await assertRole(ctx, resolved.scope, "admin");

  const group = await findGroup(ctx, groupId);

  const id = uuidv7(ctx.now);

  try {
    await runBatch(ctx.db, [
      ctx.db.insert(groupGrants).values({
        id,
        groupId,
        role: input.role,
        scopeType: input.scope_type,
        projectId: resolved.projectId,
        environmentId: resolved.environmentId,
        expiresAt: input.expires_at,
        createdAt: ctx.now,
        createdBy: ctx.actor.subject,
      }),
      auditStatement(ctx, {
        action: "group.grant.create",
        outcome: "success",
        projectId: resolved.projectId,
        environmentId: resolved.environmentId,
        detail: {
          kind: "group.grant",
          role: input.role,
          scopeType: input.scope_type,
          group: group.slug,
          expiresAt: input.expires_at,
        },
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new PrickError("CONFLICT", "That group already has a grant at this scope.", {
        hint: "Revoke the existing grant first. Grants are not upgraded in place, so that a re-submitted form cannot silently widen access.",
        cause: error,
      });
    }
    throw error;
  }

  return {
    id,
    groupId,
    groupSlug: group.slug,
    role: input.role,
    scopeType: input.scope_type,
    projectSlug: resolved.projectSlug,
    environmentSlug: resolved.environmentSlug,
    expiresAt: input.expires_at,
  };
}

/**
 * Revoke a grant from a group. ADMIN AT THAT GRANT'S SCOPE.
 *
 * Addressed as `(group, grant)` rather than by grant id alone so the route
 * cannot revoke a grant belonging to a different group because a UI passed the
 * wrong pair. A mismatch is a 404 -- there is no grant by that id IN THIS GROUP,
 * which is the true statement and also the one that leaks nothing.
 */
export async function revokeGroupGrant(
  ctx: CoreContext,
  groupId: string,
  grantId: string,
): Promise<void> {
  const group = await findGroup(ctx, groupId);

  const rows = await ctx.db
    .select()
    .from(groupGrants)
    .where(and(eq(groupGrants.id, grantId), eq(groupGrants.groupId, groupId)))
    .limit(1);

  const grant = rows[0];
  if (grant === undefined) throw notFound("grant");

  const scope: Scope =
    grant.scopeType === "global"
      ? { type: "global" }
      : grant.scopeType === "project" && grant.projectId !== null
        ? { type: "project", projectId: grant.projectId }
        : grant.environmentId !== null
          ? {
              type: "environment",
              environmentId: grant.environmentId,
              ...(grant.projectId === null ? {} : { projectId: grant.projectId }),
            }
          : { type: "global" };

  await assertRole(ctx, scope, "admin");
  await assertNotLastAdminAfter(ctx, { groupGrantId: grantId });

  await runBatch(ctx.db, [
    ctx.db.delete(groupGrants).where(eq(groupGrants.id, grantId)),
    auditStatement(ctx, {
      action: "group.grant.revoke",
      outcome: "success",
      projectId: grant.projectId,
      environmentId: grant.environmentId,
      detail: {
        kind: "group.grant",
        role: grant.role,
        scopeType: grant.scopeType,
        group: group.slug,
        expiresAt: grant.expiresAt,
      },
    }),
  ]);
}

/**
 * The groups an identity belongs to.
 *
 * Used by the effective-permissions view and by the identity screen. Not by
 * authorization -- that reads groups and their grants in the SAME statement as
 * the direct grants, and a second helper it could have called instead is how a
 * second round-trip gets added by accident.
 */
export async function listGroupsForIdentity(
  ctx: CoreContext,
  identityId: string,
): Promise<{ id: string; slug: string; name: string }[]> {
  const rows = await ctx.db
    .select({ id: groups.id, slug: groups.slug, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.identityId, identityId))
    .orderBy(groups.slug);

  return rows;
}
