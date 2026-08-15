/**
 * The admin half of `PrickApi`, against the fixture store: who exists
 * (identities), what they may do (grants), what they did (the audit log), and
 * the state of the keyring.
 *
 * These are the `/access`, `/audit` and `/settings` screens. They are grouped
 * because they read the same three arrays and because none of them touches a
 * secret VALUE -- the one exception being `rekeyPage`, which clears the
 * `unreadable` flag and says why below.
 *
 * Part of the seam described in `./fixtures.ts`, and deleted with it.
 */

import type { AuditFilter, AuditPage, GrantRecord, IdentityRecord, PrickApi } from "./api.js";
import {
  auditLog,
  auditRow,
  delay,
  fail,
  fixtureId,
  grants,
  identities,
  keyring,
  projects,
  unknownIdentities,
} from "./fixture-store.js";

/**
 * Map a subject to an identity id, creating the row if it is new.
 *
 * NOT part of `PrickApi`, because on the real server it is not an operation at
 * all: `identities` is written on the first authenticated request, so anything
 * appearing in "seen but not granted" already has a row and an id. The grant
 * form posts a SUBJECT rather than an id for that flow -- a service token's
 * `common_name` is what the operator can see and copy -- and this resolves it.
 *
 * When `/api/v1` lands, the grant route resolves the subject server-side and
 * this disappears with the rest of the seam.
 */
export function fixtureResolveIdentity(subject: string, kind: "user" | "service"): string {
  const existing = identities.find((identity) => identity.subject === subject);
  if (existing) return existing.id;

  const created: IdentityRecord = {
    id: fixtureId(),
    kind,
    subject,
    displayName: null,
    disabled: false,
    lastSeenAt: Date.now(),
  };
  identities.push(created);
  return created.id;
}

type AdminApi = Pick<
  PrickApi,
  | "listIdentities"
  | "updateIdentity"
  | "listGrants"
  | "createGrant"
  | "revokeGrant"
  | "listUnknownIdentities"
  | "queryAudit"
  | "getKeyringStatus"
  | "rekeyPage"
>;

export const fixtureAdminApi: AdminApi = {
  listIdentities: () => delay(identities.map((entry) => ({ ...entry }))),

  updateIdentity: (id, input) => {
    const found = identities.find((entry) => entry.id === id);
    if (!found) fail("NOT_FOUND", "No such identity.", 404);
    if (input.display_name !== undefined) found.displayName = input.display_name;
    if (input.disabled !== undefined) found.disabled = input.disabled;
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "identity.update",
        detail: { kind: "identity", subject: found.subject, fields: Object.keys(input) },
      }),
    );
    return delay({ ...found });
  },

  listGrants: () => delay(grants.map((entry) => ({ ...entry }))),

  createGrant: (input) => {
    const identity = identities.find((entry) => entry.id === input.identity_id);
    if (!identity) fail("NOT_FOUND", "No such identity.", 404);

    const duplicate = grants.some(
      (entry) =>
        entry.identityId === input.identity_id &&
        entry.scopeType === input.scope_type &&
        entry.projectSlug === (input.project ?? null) &&
        entry.environmentSlug === (input.environment ?? null),
    );
    if (duplicate) {
      fail(
        "CONFLICT",
        "That identity already has a grant at this scope.",
        409,
        "Revoke the existing grant first; a duplicate is never silently upgraded.",
      );
    }

    const created: GrantRecord = {
      id: fixtureId(),
      identityId: input.identity_id,
      role: input.role,
      scopeType: input.scope_type,
      projectSlug: input.project ?? null,
      environmentSlug: input.environment ?? null,
      expiresAt: input.expires_at ?? null,
    };
    grants.push(created);

    const pending = unknownIdentities.findIndex((entry) => entry.subject === identity.subject);
    if (pending !== -1) unknownIdentities.splice(pending, 1);

    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "grant.create",
        projectSlug: created.projectSlug,
        environmentSlug: created.environmentSlug,
        detail: {
          kind: "grant",
          role: created.role,
          scopeType: created.scopeType,
          subject: identity.subject,
          expiresAt: created.expiresAt,
        },
      }),
    );
    return delay({ ...created });
  },

  revokeGrant: (id) => {
    const index = grants.findIndex((entry) => entry.id === id);
    if (index === -1) fail("NOT_FOUND", "No such grant.", 404);

    const target = grants[index];
    if (!target) fail("NOT_FOUND", "No such grant.", 404);
    const remainingAdmins = grants.filter(
      (entry) => entry.id !== id && entry.scopeType === "global" && entry.role === "admin",
    );
    if (target.scopeType === "global" && target.role === "admin" && remainingAdmins.length === 0) {
      fail(
        "LAST_ADMIN",
        "This is the last global admin grant.",
        409,
        "Removing it locks everyone out permanently -- there is no recovery credential by design. Grant admin to someone else first.",
      );
    }

    grants.splice(index, 1);
    const identity = identities.find((entry) => entry.id === target.identityId);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "grant.revoke",
        projectSlug: target.projectSlug,
        environmentSlug: target.environmentSlug,
        detail: {
          kind: "grant",
          role: target.role,
          scopeType: target.scopeType,
          subject: identity?.subject ?? "unknown",
          expiresAt: target.expiresAt,
        },
      }),
    );
    return delay(undefined);
  },

  listUnknownIdentities: () => delay(unknownIdentities.map((entry) => ({ ...entry }))),

  queryAudit: (filter: AuditFilter) => {
    const limit = filter.limit ?? 50;

    let rows = [...auditLog].sort((a, b) => b.ts - a.ts);

    if (filter.project) rows = rows.filter((row) => row.projectSlug === filter.project);
    if (filter.environment) rows = rows.filter((row) => row.environmentSlug === filter.environment);
    if (filter.action) rows = rows.filter((row) => row.action === filter.action);
    if (filter.outcome) rows = rows.filter((row) => row.outcome === filter.outcome);
    if (filter.since !== undefined) rows = rows.filter((row) => row.ts >= filter.since!);
    if (filter.until !== undefined) rows = rows.filter((row) => row.ts <= filter.until!);
    if (filter.actor) {
      const needle = filter.actor.toLowerCase();
      rows = rows.filter((row) => row.actorSubject.toLowerCase().includes(needle));
    }

    if (filter.cursor) {
      const at = rows.findIndex((row) => row.id === filter.cursor);
      if (at !== -1) rows = rows.slice(at + 1);
    }

    const page = rows.slice(0, limit);
    return delay({
      entries: page,
      cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    } satisfies AuditPage);
  },

  getKeyringStatus: () =>
    delay({
      ...keyring,
      entries: keyring.entries.map((entry) => ({ ...entry })),
      safeToRemoveOldKey: keyring.entries.every(
        (entry) => entry.status === "active" || entry.rowsRemaining === 0,
      ),
    }),

  rekeyPage: (limit) => {
    let budget = limit;
    for (const entry of keyring.entries) {
      if (entry.status === "active" || budget <= 0) continue;
      const taken = Math.min(entry.rowsRemaining, budget);
      entry.rowsRemaining -= taken;
      budget -= taken;
      if (taken > 0) entry.lastRekeyAt = Date.now();
    }

    const remaining = keyring.entries
      .filter((entry) => entry.status !== "active")
      .reduce((total, entry) => total + entry.rowsRemaining, 0);

    // A rekey that clears the last retired row also makes the previously
    // unreadable fixture row readable again -- which is the honest outcome:
    // the value was only ever unreachable because its key was missing.
    if (remaining === 0) {
      for (const project of projects) {
        for (const environment_ of project.environments) {
          for (const entry of environment_.secrets) entry.unreadable = false;
        }
      }
    }

    keyring.safeToRemoveOldKey = remaining === 0;
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "admin.rekey",
        detail: { kind: "resource", slug: "keyring" },
      }),
    );
    return delay({ rekeyed: limit - budget, remaining });
  },
};
