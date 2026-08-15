import type { CreateGrantBody, IdentityKind, Role, UpdateIdentityBody } from "@prick/shared";

import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

export interface IdentityRecord {
  id: string;
  kind: IdentityKind;
  subject: string;
  displayName: string | null;
  disabled: boolean;
  lastSeenAt: number | null;
}

export interface GrantRecord {
  id: string;
  identityId: string;
  role: Role;
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

export function listIdentities(_ctx: CoreContext): Promise<IdentityRecord[]> {
  return notImplemented("listIdentities");
}

export function updateIdentity(
  _ctx: CoreContext,
  _id: string,
  _input: UpdateIdentityBody,
): Promise<IdentityRecord> {
  return notImplemented("updateIdentity");
}

export function listGrants(_ctx: CoreContext): Promise<GrantRecord[]> {
  return notImplemented("listGrants");
}

/**
 * TODO(build order step 11): create a grant.
 *
 * The partial unique indexes on `grants` do the de-duplication; a duplicate is
 * a CONFLICT, not an upsert. Silently upgrading an existing reader grant to
 * admin because someone re-submitted the form is precisely the change nobody
 * would notice.
 */
export function createGrant(_ctx: CoreContext, _input: CreateGrantBody): Promise<GrantRecord> {
  return notImplemented("createGrant");
}

/**
 * TODO(build order step 11): revoke a grant.
 *
 * Removing the last global admin grant while `BOOTSTRAP_ADMINS` is also empty
 * locks everyone out permanently -- there is no recovery credential by design.
 * Refuse with LAST_ADMIN (409).
 */
export function revokeGrant(_ctx: CoreContext, _grantId: string): Promise<void> {
  return notImplemented("revokeGrant");
}

/**
 * TODO(build order step 11): subjects that authenticated successfully and were
 * then DENIED, and that have no grants.
 *
 * This is the highest-value screen in the app and it exists because of one
 * fact: a service token's `common_name` is an opaque hex string like
 * `e367826f93b8d71185e03fe518aff3b4.access`, and no operator can map that to
 * "staging deploy" by looking at it. Because denials are audited, this list can
 * be read back out of the audit log, which turns provisioning CI into: point it
 * at prick, watch it 403, click Grant.
 */
export function listUnknownIdentities(_ctx: CoreContext): Promise<
  {
    kind: IdentityKind;
    subject: string;
    firstSeenAt: number;
    lastSeenAt: number;
    attempts: number;
  }[]
> {
  return notImplemented("listUnknownIdentities");
}
