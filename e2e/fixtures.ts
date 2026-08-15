/**
 * The suite's fixtures: a role, and everything that follows from it.
 *
 * ---------------------------------------------------------------------------
 * ROLE AS A PARAMETER, NOT A LOGIN FLOW
 * ---------------------------------------------------------------------------
 * `globalSetup` mints one Access assertion per role and writes it to a storage
 * state file. A spec selects an identity with
 *
 *     test.use({ role: "writer" });
 *
 * and every `page`, `context` and `api` in that block is that identity, in both
 * credential shapes at once: the browser carries the `CF_Authorization` cookie
 * from storage state, and `api` sends the `Cf-Access-Jwt-Assertion` header the
 * way the CLI does.
 *
 * There is no login flow to repeat because there is nothing to log in to --
 * Access authenticates at the edge, and locally the harness is the edge. The
 * consequence is that role behaviour is a one-line `test.use` rather than a
 * fifteen-line `beforeEach` that every spec copies and one of them gets wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY `baseURL` IS A FIXTURE
 * ---------------------------------------------------------------------------
 * The Worker's port is chosen at setup, and a Playwright config is evaluated
 * before global setup runs -- so `use.baseURL` in the config would have to be a
 * fixed port, which two concurrent runs would fight over. Overriding the option
 * here reads the port that was actually taken.
 */

import { test as base, expect } from "@playwright/test";

import { ApiClient } from "./harness/api";
import type { Role } from "./harness/constants";
import { readHandoff } from "./harness/handoff";

export { expect };
export { ApiError, environmentPath } from "./harness/api";
export type {
  AuditEntry,
  AuditPage,
  EnvironmentSummary,
  GrantRecord,
  IdentityRecord,
  ImportResult,
  ProjectSummary,
  SecretListEntry,
  Whoami,
  WriteSecretsResult,
} from "./harness/api";

export interface PrickOptions {
  /** Which seeded identity this block runs as. `test.use({ role: "reader" })`. */
  role: Role;
}

export interface PrickFixtures {
  /** `/api/v1` as the block's role, credentialed by header. */
  api: ApiClient;
  /** `/api/v1` as the global admin, for arranging state a spec needs. */
  adminApi: ApiClient;
  /** `/api/v1` as any role, for the specs that compare two identities. */
  apiAs: (role: Role) => ApiClient;
  /** A slug no other test in this run will use. */
  uniqueSlug: (prefix: string) => string;
}

/*
 * `async ({}, use)` is Playwright's required shape for a fixture that depends on
 * no other fixture: the runner parses the first parameter's destructuring
 * pattern to work out the dependency graph, and refuses a function whose first
 * argument is not a destructuring pattern at all. The empty pattern is
 * therefore load-bearing rather than an oversight.
 */
/* eslint-disable no-empty-pattern */

export const test = base.extend<PrickOptions & PrickFixtures>({
  role: ["admin", { option: true }],

  baseURL: async ({}, use) => {
    await use(readHandoff().baseUrl);
  },

  storageState: async ({ role }, use) => {
    await use(readHandoff().storageState[role]);
  },

  api: async ({ role }, use) => {
    const handoff = readHandoff();
    await use(new ApiClient(handoff.baseUrl, handoff.tokens[role]));
  },

  adminApi: async ({}, use) => {
    const handoff = readHandoff();
    await use(new ApiClient(handoff.baseUrl, handoff.tokens.admin));
  },

  apiAs: async ({}, use) => {
    const handoff = readHandoff();
    await use((role: Role) => new ApiClient(handoff.baseUrl, handoff.tokens[role]));
  },

  /**
   * Unique slugs, because the suite is fully parallel against ONE D1.
   *
   * The seeded `atlas` project is read-only for that reason; anything that
   * writes makes its own project. The counter is per worker process and the
   * worker index is in the slug, so two workers cannot collide, and a slug in a
   * failure message says which test produced it.
   */
  uniqueSlug: async ({}, use, testInfo) => {
    let counter = 0;
    await use((prefix: string) => {
      counter += 1;
      return `${prefix}-w${String(testInfo.workerIndex)}-${String(counter)}-${Date.now().toString(36)}`;
    });
  },
});

/* eslint-enable no-empty-pattern */

/** The harness facts a spec occasionally has to branch on. */
export const harness = {
  get baseUrl(): string {
    return readHandoff().baseUrl;
  },
  get certsUrl(): string {
    return readHandoff().certsUrl;
  },
  /** The Playwright storage state file holding a role's `CF_Authorization`. */
  storageState(role: Role): string {
    return readHandoff().storageState[role];
  },
};
