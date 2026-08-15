import { applyD1Migrations, env } from "cloudflare:test";

import type { Actor, CoreContext, RuntimeConfig } from "../../src/lib/server/core/context.js";
import { createDatabase, type Database } from "../../src/lib/server/db/client.js";
import { uuidv7 } from "../../src/lib/server/db/ids.js";
import { environments, grants, identities, projects } from "../../src/lib/server/db/schema.js";
import { harnessMigrations } from "./harness/client.js";

/** A fixed instant. Grant expiry is compared against this, never a wall clock. */
export const NOW = 1_800_000_000_000;

/**
 * Rows are deleted in FK-dependency order.
 *
 * D1 enforces foreign keys, so `projects` cannot go first -- and truncating in
 * the wrong order fails in a way that looks like a test bug rather than a
 * schema one.
 */
const TABLES = [
  "audit_log",
  "grants",
  "secret_versions",
  "secrets",
  "environments",
  "projects",
  "identities",
  "keyring_state",
];

let migrated = false;

/** A migrated, empty database. Safe to call in every `beforeEach`. */
export async function freshDatabase(): Promise<Database> {
  if (!migrated) {
    await applyD1Migrations(env.DB, await harnessMigrations());
    migrated = true;
  }

  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));

  return createDatabase(env.DB);
}

/**
 * A D1 binding that counts the statements issued through it.
 *
 * This is how "authorization is resolved ONCE per request" stops being a
 * comment and becomes an assertion. A 200-secret write that performs 200
 * authorization queries still passes every functional test in this suite; only
 * counting catches it.
 */
export interface CountingD1 {
  binding: D1Database;
  statements(): number;
  reset(): void;
}

export function countingD1(inner: D1Database = env.DB): CountingD1 {
  let count = 0;

  const binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          count += 1;
          return target.prepare(query);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  return {
    binding,
    statements: () => count,
    reset: () => {
      count = 0;
    },
  };
}

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    accessTeam: "test-team",
    accessAud: "test-aud",
    /*
     * Written explicitly rather than left off.
     *
     * `RuntimeConfig.accessCertsUrl` is optional today only so this literal
     * keeps compiling; the end state is a required field. Naming it here, even
     * as `undefined`, means dropping the `?` in `core/context.ts` is a one-line
     * change over there and not a compile error over here.
     *
     * `undefined` is also the right DEFAULT: it exercises the production path
     * where the certs URL is derived from the team. Tests that need the mock
     * origin pass its URL explicitly, one certs URL per test.
     */
    accessCertsUrl: undefined,
    bootstrapAdmins: [],
    requireCtxAccess: false,
    secretMaxBytes: 65536,
    envMaxSecrets: 500,
    bodyMaxBytes: 1048576,
    ...overrides,
  };
}

export function userActor(subject: string): Actor {
  return { kind: "user", subject, identityId: null, bootstrap: false };
}

export function serviceActor(subject: string): Actor {
  return { kind: "service", subject, identityId: null, bootstrap: false };
}

/**
 * One request.
 *
 * A fresh object each time, because the authorization snapshot is cached
 * against this exact reference -- reusing one across "requests" would hide
 * every caching bug the cache exists to be tested for.
 */
export function requestContext(
  db: Database,
  actor: Actor,
  overrides: Partial<Omit<CoreContext, "db" | "actor">> = {},
): CoreContext {
  return {
    db,
    actor,
    requestId: `req-${crypto.randomUUID()}`,
    now: NOW,
    config: testConfig(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export async function seedIdentity(
  db: Database,
  input: { kind: "user" | "service"; subject: string; disabled?: boolean },
): Promise<string> {
  const id = uuidv7(NOW);

  await db.insert(identities).values({
    id,
    kind: input.kind,
    subject: input.subject,
    displayName: null,
    disabled: input.disabled ?? false,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
  });

  return id;
}

export async function seedProject(db: Database, slug: string): Promise<string> {
  const id = uuidv7(NOW);

  await db.insert(projects).values({
    id,
    slug,
    name: slug,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "seed",
  });

  return id;
}

export async function seedEnvironment(
  db: Database,
  projectId: string,
  slug: string,
): Promise<string> {
  const id = uuidv7(NOW);

  await db.insert(environments).values({
    id,
    projectId,
    slug,
    name: slug,
    description: null,
    rev: 0,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "seed",
  });

  return id;
}

export async function seedGrant(
  db: Database,
  input: {
    identityId: string;
    role: "reader" | "writer" | "admin";
    scopeType: "global" | "project" | "environment";
    projectId?: string | null;
    environmentId?: string | null;
    expiresAt?: number | null;
  },
): Promise<string> {
  const id = uuidv7(NOW);

  await db.insert(grants).values({
    id,
    identityId: input.identityId,
    role: input.role,
    scopeType: input.scopeType,
    projectId: input.projectId ?? null,
    environmentId: input.environmentId ?? null,
    expiresAt: input.expiresAt ?? null,
    createdAt: NOW,
    createdBy: "seed",
  });

  return id;
}
