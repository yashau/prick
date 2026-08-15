/**
 * THE FIXTURE SEAM. This whole file is scaffolding and is meant to be deleted.
 *
 * `/api/v1` is being built by another agent right now. Rather than block the
 * UI on it, every screen is developed against this in-memory dataset, which
 * implements `PrickApi` exactly. Two consumers:
 *
 *   1. `api.ts` selects it over `httpApi` while `USE_FIXTURES` is true.
 *   2. The SSR-rendered screens' `+page.server.ts` loads import `fixtureApi`
 *      DIRECTLY, each at a marked call site. Those calls become in-process
 *      `core.*` calls -- NOT `event.fetch('/api/v1/...')`, which cannot forward
 *      `CF-Access-JWT-Assertion` and would re-solve authorization badly.
 *
 * Cutover is therefore: flip `USE_FIXTURES`, replace the marked server-load
 * call sites with `core.*`, delete this file. No component and no route
 * template changes.
 *
 * NOTE ON WHAT THIS FILE IS ALLOWED TO CONTAIN: secret VALUES, because it is a
 * fake database. It is the only file in `src/lib/client` that holds one, it is
 * obviously fake, and it disappears with the seam. Nothing here is imported by
 * a component.
 */

import type {
  AuditEntryView,
  AuditFilter,
  AuditPage,
  BatchInput,
  EnvironmentSummary,
  GrantRecord,
  IdentityRecord,
  ImportPreview,
  KeyringStatus,
  PrickApi,
  ProjectSummary,
  RevealReason,
  SecretListEntry,
  UnknownIdentity,
  VersionEntry,
  WriteResult,
} from "./api.js";
import { ApiError } from "./errors.js";

/**
 * The one switch. `false` puts every screen on `httpApi` and this module goes
 * unreferenced -- the bundler drops it, and the tree-shake is the proof that
 * nothing outside the seam reached into it.
 */
export const USE_FIXTURES = true;

/** Enough delay that the skeleton states are real rather than theoretical. */
const LATENCY_MS = 140;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fixed so that server render and client hydrate agree on every timestamp. */
const NOW = Date.UTC(2026, 7, 15, 9, 30, 0);

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function fail(code: string, message: string, status: number, hint?: string): never {
  throw new ApiError({
    code,
    message,
    status,
    hint,
    requestId: `req_${Math.random().toString(16).slice(2, 14)}`,
  });
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

interface FixtureSecret {
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

interface FixtureEnvironment extends EnvironmentSummary {
  secrets: FixtureSecret[];
}

interface FixtureProject extends Omit<ProjectSummary, "environmentCount"> {
  environments: FixtureEnvironment[];
}

function version(
  n: number,
  op: string,
  createdAt: number,
  createdBy: string,
  deleted = false,
): VersionEntry {
  return { version: n, op, createdAt, createdBy, kid: "9f2c41a7b0e35d18", deleted };
}

function secret(init: {
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

function environment(init: {
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

const projects: FixtureProject[] = [
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

const identities: IdentityRecord[] = [
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

const grants: GrantRecord[] = [
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

const unknownIdentities: UnknownIdentity[] = [
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

function auditRow(init: Partial<AuditEntryView> & { action: string }): AuditEntryView {
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
const auditLog: AuditEntryView[] = [
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

const keyring: KeyringStatus = {
  activeKid: "9f2c41a7b0e35d18",
  entries: [
    { kid: "9f2c41a7b0e35d18", status: "active", rowsRemaining: 0, lastRekeyAt: NOW - 2 * DAY },
    { kid: "3b8e07d4c1a95f62", status: "retiring", rowsRemaining: 34, lastRekeyAt: NOW - 6 * HOUR },
    { kid: "0000000000000000", status: "retired", rowsRemaining: 1, lastRekeyAt: null },
  ],
  safeToRemoveOldKey: false,
};

/**
 * Who the app thinks is looking at it.
 *
 * NOT part of `PrickApi`: the real value comes from the verified Access actor
 * on `event.locals`, which `hooks.server.ts` will attach in build order step
 * 10/11. This exists so the shell can render an avatar and the bootstrap
 * banner before that lands.
 *
 * `bootstrapAdmin` is true while the only thing making this actor an admin is
 * the `BOOTSTRAP_ADMINS` var rather than a `grants` row. The banner that flag
 * drives is a guard, not decoration -- an install left in that state has an
 * admin nobody can revoke through the UI.
 */
export interface Viewer {
  kind: "user" | "service";
  subject: string;
  displayName: string | null;
  role: "reader" | "writer" | "admin";
  bootstrapAdmin: boolean;
}

export const fixtureViewer: Viewer = {
  kind: "user",
  subject: "ada@example.com",
  displayName: "Ada Lovelace",
  role: "admin",
  bootstrapAdmin: true,
};

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
 * this disappears with the rest of the file.
 */
export function fixtureResolveIdentity(subject: string, kind: "user" | "service"): string {
  const existing = identities.find((identity) => identity.subject === subject);
  if (existing) return existing.id;

  const created: IdentityRecord = {
    id: `0192f3a1-7c40-7c8a-9d21-${Math.random().toString(16).slice(2, 14)}`,
    kind,
    subject,
    displayName: null,
    disabled: false,
    lastSeenAt: Date.now(),
  };
  identities.push(created);
  return created.id;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function findProject(slug: string): FixtureProject {
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

function findEnvironment(projectSlug: string, envSlug: string): FixtureEnvironment {
  const project = findProject(projectSlug);
  const found = project.environments.find((environment_) => environment_.slug === envSlug);
  if (!found) fail("NOT_FOUND", "No such environment.", 404);
  return found;
}

function summarise(project: FixtureProject): ProjectSummary {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    environmentCount: project.environments.length,
    updatedAt: project.updatedAt,
  };
}

function listing(environment_: FixtureEnvironment): SecretListEntry[] {
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

function bumpEnvironment(environment_: FixtureEnvironment): number {
  environment_.rev += 1;
  environment_.secretCount = environment_.secrets.length;
  environment_.updatedAt = Date.now();
  return environment_.rev;
}

/**
 * A deliberately small `.env` reader, for the import PREVIEW only.
 *
 * The real parser is `src/lib/server/core/dotenv.ts` and it is far stricter.
 * This one exists because the preview has to come from somewhere while the
 * API is being written, and it dies with the rest of this file.
 */
function parseEnvFixture(source: string): {
  entries: Record<string, string>;
  warnings: { line: number; message: string }[];
} {
  const entries: Record<string, string> = {};
  const warnings: { line: number; message: string }[] = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    const eq = line.indexOf("=");
    if (eq === -1) {
      warnings.push({ line: index + 1, message: "No '=' on this line; skipped." });
      return;
    }

    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let value = line.slice(eq + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push({ line: index + 1, message: `"${key}" is not a POSIX variable name.` });
      return;
    }

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  });

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// The implementation
// ---------------------------------------------------------------------------

export const fixtureApi: PrickApi = {
  listProjects: () => delay(projects.map(summarise)),

  getProject: (project) => delay(summarise(findProject(project))),

  createProject: (input) => {
    if (projects.some((project) => project.slug === input.slug)) {
      fail("CONFLICT", `A project with the slug "${input.slug}" already exists.`, 409);
    }
    const created: FixtureProject = {
      id: `0192f3a1-7c40-7c8a-9d21-${Math.random().toString(16).slice(2, 14)}`,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      updatedAt: Date.now(),
      environments: [],
    };
    projects.push(created);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.create",
        projectSlug: input.slug,
        detail: { kind: "resource", slug: input.slug },
      }),
    );
    return delay(summarise(created));
  },

  updateProject: (project, input) => {
    const found = findProject(project);
    if (input.name !== undefined) found.name = input.name;
    if (input.description !== undefined) found.description = input.description;
    found.updatedAt = Date.now();
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.update",
        projectSlug: project,
        detail: { kind: "resource", slug: project, fields: Object.keys(input) },
      }),
    );
    return delay(summarise(found));
  },

  deleteProject: (project) => {
    const index = projects.findIndex((entry) => entry.slug === project);
    if (index === -1) fail("NOT_FOUND", "No such project.", 404);
    const removed = projects.splice(index, 1)[0];
    if (!removed) fail("NOT_FOUND", "No such project.", 404);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.delete",
        projectSlug: project,
        detail: {
          kind: "resource",
          slug: project,
          cascade: { environments: removed.environments.length },
        },
      }),
    );
    return delay(undefined);
  },

  listEnvironments: (project) =>
    delay(
      findProject(project).environments.map(({ secrets: _secrets, ...rest }) => ({
        ...rest,
        secretCount: _secrets.length,
      })),
    ),

  getEnvironment: (project, environment_) => {
    const { secrets: _secrets, ...rest } = findEnvironment(project, environment_);
    return delay({ ...rest, secretCount: _secrets.length });
  },

  createEnvironment: (project, input) => {
    const found = findProject(project);
    if (found.environments.some((entry) => entry.slug === input.slug)) {
      fail("CONFLICT", `"${input.slug}" already exists in this project.`, 409);
    }
    const created = environment({
      id: `0192f3a1-7c40-7c8a-9d21-${Math.random().toString(16).slice(2, 14)}`,
      projectId: found.id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      rev: 0,
      ageDays: 0,
      secrets: [],
    });
    created.updatedAt = Date.now();
    found.environments.push(created);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "environment.create",
        projectSlug: project,
        environmentSlug: input.slug,
        detail: { kind: "resource", slug: input.slug },
      }),
    );
    const { secrets: _secrets, ...rest } = created;
    return delay({ ...rest, secretCount: 0 });
  },

  deleteEnvironment: (project, environment_) => {
    const found = findProject(project);
    const index = found.environments.findIndex((entry) => entry.slug === environment_);
    if (index === -1) fail("NOT_FOUND", "No such environment.", 404);
    found.environments.splice(index, 1);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "environment.delete",
        projectSlug: project,
        environmentSlug: environment_,
        detail: { kind: "resource", slug: environment_ },
      }),
    );
    return delay(undefined);
  },

  listSecrets: (project, environment_) => delay(listing(findEnvironment(project, environment_))),

  revealSecret: (project, environment_, key, reason: RevealReason) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);

    if (entry.unreadable) {
      auditLog.push(
        auditRow({
          ts: Date.now(),
          action: "secret.reveal",
          outcome: "error",
          projectSlug: project,
          environmentSlug: environment_,
          targetKey: key,
          detail: { kind: "secret.unreadable", keys: [key], kid: "0000000000000000" },
        }),
      );
      fail(
        "UNKNOWN_KID",
        `${key} is sealed under key id 0000000000000000, which this keyring does not hold.`,
        500,
        "MASTER_KEY_OLD may have been removed before the rekey finished. Restore it and re-run the rekey.",
      );
    }

    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.reveal",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: key,
        detail: { kind: "secret.read", reason, count: 1 },
      }),
    );
    return delay(entry.value);
  },

  writeSecrets: (project, environment_, input: BatchInput) => {
    const found = findEnvironment(project, environment_);

    if (input.expected_rev !== undefined && input.expected_rev !== found.rev) {
      fail(
        "PRECONDITION_FAILED",
        "This environment changed while you were editing it.",
        412,
        "Reload to pick up the current values, then re-apply your change.",
      );
    }

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [key, value] of Object.entries(input.set ?? {})) {
      const existing = found.secrets.find((entry) => entry.key === key);
      if (existing) {
        existing.value = value;
        existing.version += 1;
        existing.updatedAt = Date.now();
        existing.unreadable = false;
        existing.versions.unshift(
          version(existing.version, "update", Date.now(), "ada@example.com"),
        );
        changed.push(key);
      } else {
        const created = secret({ key, value, version: 1, ageDays: 0 });
        created.updatedAt = Date.now();
        found.secrets.push(created);
        added.push(key);
      }
    }

    const deleting = new Set(input.delete ?? []);
    if (input.mode === "replace") {
      const keeping = new Set(Object.keys(input.set ?? {}));
      for (const entry of found.secrets) if (!keeping.has(entry.key)) deleting.add(entry.key);
    }

    for (const key of deleting) {
      const index = found.secrets.findIndex((entry) => entry.key === key);
      if (index !== -1) {
        found.secrets.splice(index, 1);
        removed.push(key);
      }
    }

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.write",
        projectSlug: project,
        environmentSlug: environment_,
        detail: {
          kind: "secret.diff",
          mode: input.mode ?? "merge",
          added,
          changed,
          removed,
          reason: input.reason,
        },
      }),
    );
    return delay({ rev } satisfies WriteResult);
  },

  renameSecret: (project, environment_, from, to) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === from);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);
    if (found.secrets.some((candidate) => candidate.key === to)) {
      fail("CONFLICT", `"${to}" already exists in this environment.`, 409);
    }

    entry.key = to;
    entry.version += 1;
    entry.updatedAt = Date.now();
    entry.versions.unshift(version(entry.version, "rename", Date.now(), "ada@example.com"));

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.rename",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: to,
        detail: { kind: "secret.rename", from, to, version: entry.version },
      }),
    );
    return delay({ rev } satisfies WriteResult);
  },

  importSecrets: (project, environment_, input) => {
    const found = findEnvironment(project, environment_);

    let entries: Record<string, string>;
    let warnings: { line: number; message: string }[] = [];

    if (input.format === "json") {
      try {
        const parsed: unknown = JSON.parse(input.content);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          fail("VALIDATION_FAILED", "Expected a JSON object of key/value pairs.", 422);
        }
        entries = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        fail("VALIDATION_FAILED", "That is not valid JSON.", 422);
      }
    } else {
      const parsed = parseEnvFixture(input.content);
      entries = parsed.entries;
      warnings = parsed.warnings;
    }

    const existing = new Map(found.secrets.map((entry) => [entry.key, entry.value]));
    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const [key, value] of Object.entries(entries)) {
      if (!existing.has(key)) added.push(key);
      else if (existing.get(key) !== value) changed.push(key);
      else unchanged.push(key);
    }

    const removed =
      input.mode === "replace"
        ? [...existing.keys()].filter((key) => !(key in entries)).sort()
        : [];

    if (input.dry_run) {
      return delay({
        dryRun: true,
        added: added.sort(),
        changed: changed.sort(),
        removed,
        unchanged: unchanged.sort(),
        warnings,
        rev: found.rev,
      } satisfies ImportPreview);
    }

    for (const [key, value] of Object.entries(entries)) {
      const entry = found.secrets.find((candidate) => candidate.key === key);
      if (entry) {
        entry.value = value;
        entry.version += 1;
        entry.updatedAt = Date.now();
        entry.versions.unshift(version(entry.version, "import", Date.now(), "ada@example.com"));
      } else {
        const created = secret({ key, value, version: 1, ageDays: 0 });
        created.updatedAt = Date.now();
        found.secrets.push(created);
      }
    }

    for (const key of removed) {
      const index = found.secrets.findIndex((entry) => entry.key === key);
      if (index !== -1) found.secrets.splice(index, 1);
    }

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.import",
        projectSlug: project,
        environmentSlug: environment_,
        detail: {
          kind: "secret.diff",
          mode: input.mode,
          added,
          changed,
          removed,
          reason: input.reason,
        },
      }),
    );

    return delay({
      dryRun: false,
      added: added.sort(),
      changed: changed.sort(),
      removed,
      unchanged: unchanged.sort(),
      warnings,
      rev,
    } satisfies ImportPreview);
  },

  exportSecrets: (project, environment_) => {
    const found = findEnvironment(project, environment_);
    const unreadable = found.secrets.filter((entry) => entry.unreadable);

    if (unreadable.length > 0) {
      // The opposite of quietly writing a shorter file. An export that cannot
      // include every key fails; it never silently omits one.
      fail(
        "DECRYPT_FAILED",
        `${unreadable.length} value(s) in this environment cannot be decrypted, so the export would be incomplete.`,
        500,
        `Affected keys: ${unreadable.map((entry) => entry.key).join(", ")}.`,
      );
    }

    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.export",
        projectSlug: project,
        environmentSlug: environment_,
        detail: { kind: "secret.read", reason: "export", count: found.secrets.length },
      }),
    );

    return delay(Object.fromEntries(found.secrets.map((entry) => [entry.key, entry.value])));
  },

  listVersions: (project, environment_, key) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);
    return delay(entry.versions);
  },

  rollbackSecret: (project, environment_, input) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === input.key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);

    entry.version += 1;
    entry.updatedAt = Date.now();
    entry.versions.unshift(version(entry.version, "rollback", Date.now(), "ada@example.com"));

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.rollback",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: input.key,
        detail: {
          kind: "secret.version",
          key: input.key,
          from: input.to_version,
          to: entry.version,
          reason: input.reason,
        },
      }),
    );
    return delay({ rev, version: entry.version });
  },

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
      id: `0192f3a1-7c40-7c8a-9d21-${Math.random().toString(16).slice(2, 14)}`,
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
