/**
 * THE FIXTURE DATASET -- the fake database the other `fixture-*` modules read
 * and write. Part of the seam described in `./fixtures.ts`, and deleted with it.
 *
 * The data is ONE store rather than one store per domain, because the real
 * schema is one too: environments hang off projects, secrets hang off
 * environments, grants point at identities, and every mutation appends an audit
 * row. Splitting the arrays by domain would only move those references into
 * import cycles. So the shape of the split is: the store here, and one module
 * per slice of `PrickApi` that operates on it.
 *
 * WHAT THIS FILE IS ALLOWED TO CONTAIN: secret VALUES, because it is a fake
 * database. Nothing here is imported by a component.
 */

import type {
  AuditEntryView,
  EnvironmentSummary,
  GrantRecord,
  IdentityRecord,
  KeyringStatus,
  ProjectSummary,
  SecretListEntry,
  UnknownIdentity,
  VersionEntry,
} from "./api.js";
import { ApiError } from "./errors.js";

/** Enough delay that the skeleton states are real rather than theoretical. */
const LATENCY_MS = 140;

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Fixed so that server render and client hydrate agree on every timestamp. */
export const NOW = Date.UTC(2026, 7, 15, 9, 30, 0);

export function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

export function fail(code: string, message: string, status: number, hint?: string): never {
  throw new ApiError({
    code,
    message,
    status,
    hint,
    requestId: `req_${Math.random().toString(16).slice(2, 14)}`,
  });
}

/** The id shape the fixtures mint for anything created at runtime. */
export function fixtureId(): string {
  return `0192f3a1-7c40-7c8a-9d21-${Math.random().toString(16).slice(2, 14)}`;
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

export interface FixtureSecret {
  key: string;
  value: string;
  description: string | null;
  version: number;
  updatedAt: number;
  updatedBy: string;
  /** Simulates a row whose envelope will not open. */
  unreadable: boolean;
  versions: VersionEntry[];
}

export interface FixtureEnvironment extends EnvironmentSummary {
  secrets: FixtureSecret[];
}

export interface FixtureProject extends Omit<ProjectSummary, "environmentCount"> {
  environments: FixtureEnvironment[];
}

export function version(
  n: number,
  op: string,
  createdAt: number,
  createdBy: string,
  deleted = false,
): VersionEntry {
  return { version: n, op, createdAt, createdBy, kid: "9f2c41a7b0e35d18", deleted };
}

export function secret(init: {
  key: string;
  value: string;
  description?: string | null;
  version?: number;
  ageDays?: number;
  by?: string;
  unreadable?: boolean;
}): FixtureSecret {
  const version_ = init.version ?? 1;
  const updatedAt = NOW - (init.ageDays ?? 3) * DAY;
  const updatedBy = init.by ?? "ada@example.com";

  const versions: VersionEntry[] = [];
  for (let n = 1; n <= version_; n += 1) {
    versions.push(
      version(
        n,
        n === 1 ? "create" : "update",
        updatedAt - (version_ - n) * 6 * HOUR,
        n === 1 ? "ada@example.com" : updatedBy,
      ),
    );
  }

  return {
    key: init.key,
    value: init.value,
    description: init.description ?? null,
    version: version_,
    updatedAt,
    updatedBy,
    unreadable: init.unreadable ?? false,
    versions: versions.reverse(),
  };
}

export function environment(init: {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string | null;
  rev?: number;
  ageDays?: number;
  secrets: FixtureSecret[];
}): FixtureEnvironment {
  return {
    id: init.id,
    projectId: init.projectId,
    slug: init.slug,
    name: init.name,
    description: init.description ?? null,
    rev: init.rev ?? 12,
    secretCount: init.secrets.length,
    updatedAt: NOW - (init.ageDays ?? 1) * DAY,
    secrets: init.secrets,
  };
}

export const projects: FixtureProject[] = [
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c00",
    slug: "atlas",
    name: "Atlas",
    description: "Customer-facing web application and its API.",
    updatedAt: NOW - 2 * HOUR,
    environments: [
      environment({
        id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1e01",
        projectId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c00",
        slug: "production",
        name: "Production",
        description: "Serves live traffic. Changes here page someone.",
        rev: 41,
        ageDays: 0,
        secrets: [
          secret({
            key: "DATABASE_URL",
            value: "postgres://atlas:X7mQ2v9pLd@db.internal:5432/atlas?sslmode=require",
            description: "Primary Postgres cluster, read/write.",
            version: 7,
            ageDays: 0,
            by: "ada@example.com",
          }),
          secret({
            key: "STRIPE_SECRET_KEY",
            // Deliberately NOT shaped like a real Stripe key. The original
            // fixture used a plausible `sk_live_…` string and GitHub push
            // protection blocked the push -- correctly. A fixture that trips
            // every scanner in the ecosystem costs everyone downstream a
            // false positive, and teaches the reflex to click "allow", which
            // is the reflex that lets a real key through.
            value: "example-not-a-real-key-stripe-placeholder",
            description: "Live payments. Rotating this needs a webhook re-point.",
            version: 3,
            ageDays: 11,
            by: "grace@example.com",
          }),
          secret({
            key: "SESSION_SIGNING_KEY",
            value: "7d0f5a1c9e3b8642a5d7c0f1e2b39485c6d7e8f90a1b2c3d4e5f60718293a4b5c",
            version: 2,
            ageDays: 30,
          }),
          secret({
            key: "SMTP_PASSWORD",
            value: "hunter2-but-longer-and-actually-random-8fJd",
            description: "Transactional mail relay.",
            version: 1,
            ageDays: 62,
            by: "e367826f93b8d71185e03fe518aff3b4.access",
          }),
          secret({
            key: "LEGACY_API_TOKEN",
            value: "",
            description: "Imported from a v0 export. Never re-encrypted.",
            version: 4,
            ageDays: 190,
            unreadable: true,
          }),
        ],
      }),
      environment({
        id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1e02",
        projectId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c00",
        slug: "staging",
        name: "Staging",
        description: "Mirrors production. Safe to break.",
        rev: 18,
        ageDays: 1,
        secrets: [
          secret({
            key: "DATABASE_URL",
            value: "postgres://atlas:staging-only@db-staging.internal:5432/atlas",
            version: 4,
            ageDays: 1,
          }),
          secret({
            key: "STRIPE_SECRET_KEY",
            // Same reasoning as the live-key fixture above: no real-looking
            // vendor prefix, so no scanner anywhere has to make a judgement.
            value: "example-not-a-real-key-stripe-test-placeholder",
            version: 2,
            ageDays: 9,
          }),
          secret({ key: "FEATURE_FLAGS", value: "checkout_v2,dark_mode", version: 6, ageDays: 2 }),
        ],
      }),
      environment({
        id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1e03",
        projectId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c00",
        slug: "development",
        name: "Development",
        rev: 3,
        ageDays: 6,
        secrets: [
          secret({ key: "DATABASE_URL", value: "postgres://localhost:5432/atlas", ageDays: 6 }),
        ],
      }),
    ],
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c10",
    slug: "ledger",
    name: "Ledger",
    description: "Billing and invoicing service.",
    updatedAt: NOW - 5 * DAY,
    environments: [
      environment({
        id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1e11",
        projectId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c10",
        slug: "production",
        name: "Production",
        rev: 9,
        ageDays: 5,
        secrets: [
          secret({
            key: "LEDGER_DB_URL",
            value: "postgres://ledger:9dK2mQ@db.internal:5432/ledger",
            version: 2,
            ageDays: 5,
            by: "grace@example.com",
          }),
          secret({ key: "EXCHANGE_RATE_API_KEY", value: "erk_9f2c41a7b0e35d18", ageDays: 40 }),
        ],
      }),
    ],
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e1c20",
    slug: "beacon",
    name: "Beacon",
    description: "Status page. No environments provisioned yet.",
    updatedAt: NOW - 21 * DAY,
    environments: [],
  },
];

export const identities: IdentityRecord[] = [
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2001",
    kind: "user",
    subject: "ada@example.com",
    displayName: "Ada Lovelace",
    disabled: false,
    lastSeenAt: NOW - 20 * 60_000,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2002",
    kind: "user",
    subject: "grace@example.com",
    displayName: "Grace Hopper",
    disabled: false,
    lastSeenAt: NOW - 3 * HOUR,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2003",
    kind: "user",
    subject: "katherine@example.com",
    displayName: null,
    disabled: true,
    lastSeenAt: NOW - 40 * DAY,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2004",
    kind: "service",
    subject: "e367826f93b8d71185e03fe518aff3b4.access",
    displayName: "atlas deploy (CI)",
    disabled: false,
    lastSeenAt: NOW - 55 * 60_000,
  },
];

export const grants: GrantRecord[] = [
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e3001",
    identityId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2001",
    role: "admin",
    scopeType: "global",
    projectSlug: null,
    environmentSlug: null,
    expiresAt: null,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e3002",
    identityId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2002",
    role: "writer",
    scopeType: "project",
    projectSlug: "atlas",
    environmentSlug: null,
    expiresAt: null,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e3003",
    identityId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2004",
    role: "reader",
    scopeType: "environment",
    projectSlug: "atlas",
    environmentSlug: "production",
    expiresAt: NOW + 21 * DAY,
  },
  {
    id: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e3004",
    identityId: "0192f3a1-7c40-7c8a-9d21-6f0a5b3e2003",
    role: "reader",
    scopeType: "project",
    projectSlug: "ledger",
    environmentSlug: null,
    expiresAt: NOW - 2 * DAY,
  },
];

export const unknownIdentities: UnknownIdentity[] = [
  {
    kind: "service",
    subject: "b91d7c04e5f28a3619cd0e7f4a2b8c56.access",
    firstSeenAt: NOW - 4 * HOUR,
    lastSeenAt: NOW - 6 * 60_000,
    attempts: 17,
  },
  {
    kind: "service",
    subject: "4a1f60d8c37b92e5081ad6f3b4c7e920.access",
    firstSeenAt: NOW - 2 * DAY,
    lastSeenAt: NOW - 2 * DAY + 90_000,
    attempts: 3,
  },
  {
    kind: "user",
    subject: "contractor@example.com",
    firstSeenAt: NOW - 30 * 60_000,
    lastSeenAt: NOW - 25 * 60_000,
    attempts: 2,
  },
];

let auditSeq = 0;

export function auditRow(init: Partial<AuditEntryView> & { action: string }): AuditEntryView {
  auditSeq += 1;
  return {
    id: `0192f3a1-7c40-7c8a-9d21-6f0a5b3e4${String(auditSeq).padStart(3, "0")}`,
    ts: init.ts ?? NOW,
    requestId: init.requestId ?? `req_${auditSeq.toString(16).padStart(12, "0")}`,
    actorKind: init.actorKind ?? "user",
    actorSubject: init.actorSubject ?? "ada@example.com",
    action: init.action,
    outcome: init.outcome ?? "success",
    projectId: init.projectId ?? null,
    environmentId: init.environmentId ?? null,
    projectSlug: init.projectSlug ?? null,
    environmentSlug: init.environmentSlug ?? null,
    targetKey: init.targetKey ?? null,
    detail: init.detail ?? null,
  };
}

/** Newest last while building; `queryAudit` reverses. */
export const auditLog: AuditEntryView[] = [
  auditRow({
    ts: NOW - 9 * DAY,
    action: "project.create",
    projectSlug: "atlas",
    detail: { kind: "resource", slug: "atlas" },
  }),
  auditRow({
    ts: NOW - 9 * DAY + HOUR,
    action: "environment.create",
    projectSlug: "atlas",
    environmentSlug: "production",
    detail: { kind: "resource", slug: "production" },
  }),
  auditRow({
    ts: NOW - 6 * DAY,
    action: "secret.import",
    actorSubject: "grace@example.com",
    projectSlug: "atlas",
    environmentSlug: "production",
    detail: {
      kind: "secret.diff",
      mode: "merge",
      added: ["SMTP_PASSWORD", "SESSION_SIGNING_KEY"],
      changed: [],
      removed: [],
      reason: "initial import from 1Password export",
    },
  }),
  auditRow({
    ts: NOW - 3 * DAY,
    action: "grant.create",
    projectSlug: "atlas",
    detail: {
      kind: "grant",
      role: "reader",
      scopeType: "environment",
      subject: "e367826f93b8d71185e03fe518aff3b4.access",
      expiresAt: NOW + 21 * DAY,
    },
  }),
  auditRow({
    ts: NOW - 2 * DAY,
    action: "secret.rollback",
    actorSubject: "grace@example.com",
    projectSlug: "atlas",
    environmentSlug: "staging",
    targetKey: "FEATURE_FLAGS",
    detail: { kind: "secret.version", key: "FEATURE_FLAGS", from: 6, to: 4 },
  }),
  auditRow({
    ts: NOW - 26 * HOUR,
    action: "secret.list",
    outcome: "error",
    projectSlug: "atlas",
    environmentSlug: "production",
    detail: {
      kind: "secret.unreadable",
      keys: ["LEGACY_API_TOKEN"],
      kid: "0000000000000000",
    },
  }),
  auditRow({
    ts: NOW - 5 * HOUR,
    action: "access.denied",
    actorKind: "service",
    actorSubject: "b91d7c04e5f28a3619cd0e7f4a2b8c56.access",
    outcome: "denied",
    detail: { kind: "denial", scope: "environment", required: "reader", resource: "environment" },
  }),
  auditRow({
    ts: NOW - 55 * 60_000,
    action: "secret.export",
    actorKind: "service",
    actorSubject: "e367826f93b8d71185e03fe518aff3b4.access",
    projectSlug: "atlas",
    environmentSlug: "production",
    detail: { kind: "secret.read", reason: "run", count: 5 },
  }),
  auditRow({
    ts: NOW - 22 * 60_000,
    action: "secret.reveal",
    projectSlug: "atlas",
    environmentSlug: "production",
    targetKey: "DATABASE_URL",
    detail: { kind: "secret.read", reason: "copy", count: 1 },
  }),
];

export const keyring: KeyringStatus = {
  activeKid: "9f2c41a7b0e35d18",
  entries: [
    { kid: "9f2c41a7b0e35d18", status: "active", rowsRemaining: 0, lastRekeyAt: NOW - 2 * DAY },
    { kid: "3b8e07d4c1a95f62", status: "retiring", rowsRemaining: 34, lastRekeyAt: NOW - 6 * HOUR },
    { kid: "0000000000000000", status: "retired", rowsRemaining: 1, lastRekeyAt: null },
  ],
  safeToRemoveOldKey: false,
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findProject(slug: string): FixtureProject {
  const found = projects.find((project) => project.slug === slug);
  if (!found) {
    fail(
      "NOT_FOUND",
      "No such project.",
      404,
      "It may have been deleted, or you may not have a grant that covers it.",
    );
  }
  return found;
}

export function findEnvironment(projectSlug: string, envSlug: string): FixtureEnvironment {
  const project = findProject(projectSlug);
  const found = project.environments.find((environment_) => environment_.slug === envSlug);
  if (!found) fail("NOT_FOUND", "No such environment.", 404);
  return found;
}

export function summarise(project: FixtureProject): ProjectSummary {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    environmentCount: project.environments.length,
    updatedAt: project.updatedAt,
  };
}

export function listing(environment_: FixtureEnvironment): SecretListEntry[] {
  return environment_.secrets
    .map((entry) => ({
      key: entry.key,
      description: entry.description,
      version: entry.version,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
      unreadable: entry.unreadable,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function bumpEnvironment(environment_: FixtureEnvironment): number {
  environment_.rev += 1;
  environment_.secretCount = environment_.secrets.length;
  environment_.updatedAt = Date.now();
  return environment_.rev;
}
