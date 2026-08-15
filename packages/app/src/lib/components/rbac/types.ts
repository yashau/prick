/**
 * The shapes the RBAC screens render, mirrored from `src/lib/server/core/*`.
 *
 * WHY A MIRROR RATHER THAN AN IMPORT. A component may not reach into
 * `$lib/server` -- the import graph is the enforcement that a value-carrying
 * server module cannot be pulled into the browser bundle -- so the types a
 * component's props are written against have to live on the client side of that
 * line. `$lib/client/api.ts` does exactly this for every shape the fetch client
 * touches, and says so in its own header.
 *
 * These are NOT in `$lib/client/api.ts` for one reason worth stating: that file
 * is the browser's typed view of `/api/v1`, and every shape in it is reachable
 * by a `fetch`. The `/users` and `/groups` screens are server-rendered and fetch
 * nothing -- their loads call `core` in-process -- so putting their shapes there
 * would imply a client that does not exist.
 *
 * THE MIRROR IS CHECKED, and not by hand. Each of the three server loads that
 * feed these components annotates the value it returns with the type below, so
 * `mise run typecheck` fails the moment `core` changes shape underneath them.
 * See `routes/(app)/users/[id]/+page.server.ts` for the pattern.
 *
 * NOTHING HERE CARRIES A SECRET VALUE, and nothing here ever may. Subjects,
 * slugs, roles, group names and timestamps only -- which is the whole reason
 * these screens are allowed to be server-rendered at all.
 */

import type { IdentityKind, Role, ScopeType } from "@prick/shared";

/** Mirrors `core.IdentityRecord`. */
export interface IdentityView {
  id: string;
  kind: IdentityKind;
  subject: string;
  displayName: string | null;
  disabled: boolean;
  lastSeenAt: number | null;
}

/** Mirrors `core.GroupRef`. */
export interface GroupRefView {
  id: string;
  slug: string;
  name: string;
}

/** Mirrors `core.GroupRecord`. */
export interface GroupView {
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

/** Mirrors `core.GroupMemberRecord`. */
export interface GroupMemberView {
  identityId: string;
  kind: IdentityKind;
  subject: string;
  displayName: string | null;
  /**
   * Surfaced on the roster on purpose: `disabled` outranks every grant at every
   * scope, so a disabled member of a privileged group holds nothing. Without
   * the flag an operator reads a roster of five and believes five people have
   * access.
   */
  disabled: boolean;
  addedAt: number;
  addedBy: string;
}

/** Mirrors `core.GroupGrantRecord`. */
export interface GroupGrantView {
  id: string;
  groupId: string;
  groupSlug: string;
  role: Role;
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

/** Mirrors `core.PermissionSource`. */
export interface PermissionSourceView {
  via: "direct" | "group" | "bootstrap";
  grantId: string | null;
  role: Role;
  /** Where the GRANT sits, which may be broader than the scope it explains. */
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  group: GroupRefView | null;
  expiresAt: number | null;
  /** The source that set the effective role. Exactly one per entry, unless disabled. */
  decisive: boolean;
}

/** Mirrors `core.EffectiveScopeEntry`. */
export interface EffectiveScopeView {
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  /** The effective role here. `null` only for a disabled identity. */
  role: Role | null;
  sources: PermissionSourceView[];
}

/** Mirrors `core.EffectivePermissions`. */
export interface EffectivePermissionsView {
  identity: IdentityView;
  groups: GroupRefView[];
  bootstrap: boolean;
  scopes: EffectiveScopeView[];
}

// ---------------------------------------------------------------------------
// What the VIEWER may do, which is not the same question as what exists
// ---------------------------------------------------------------------------

/**
 * The scopes the current actor may create a grant at.
 *
 * ---------------------------------------------------------------------------
 * THIS IS PRESENTATION, NEVER ENFORCEMENT
 * ---------------------------------------------------------------------------
 * `core.createGrant` and `core.createGroupGrant` both resolve the scope and
 * then `assertRole(scope, "admin")`, and that is the decision. Nothing here can
 * widen it: a hand-posted form naming a project the actor does not administer
 * is refused by the server exactly as it was before this type existed.
 *
 * What it buys is the other half -- a control the actor cannot successfully use
 * is not offered. An admin of one project should not be shown a scope selector
 * containing "Everything in this install", pick it, and learn what their
 * authority actually is from a red toast.
 */
export interface AdminScopes {
  /** May grant at GLOBAL scope. True only for a global admin. */
  global: boolean;
  /** Every project the actor may grant somewhere inside. */
  projects: AdminProject[];
}

export interface AdminProject {
  slug: string;
  name: string;
  /**
   * May create a PROJECT-scoped grant here.
   *
   * False for an actor who administers only one environment inside it -- an
   * environment admin is not a project admin, and grants are never inherited
   * upwards. The project still appears, because it is the path to the
   * environment they may grant on.
   */
  grantable: boolean;
  /** The environments inside it a grant may be created on. Possibly empty. */
  environments: AdminEnvironment[];
}

export interface AdminEnvironment {
  slug: string;
  name: string;
}
