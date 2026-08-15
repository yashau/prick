/**
 * The browser's typed view of `/api/v1`.
 *
 * WHY THIS FILE EXISTS AT ALL, given that SvelteKit server loads call
 * `src/lib/server/core/*` in-process: because the secrets subtree has
 * `ssr = false`, and therefore has no server load to call anything from. Values
 * reach the browser exclusively through `fetch` from here. Everything below
 * `(app)/p/[project]/[env]/` is a client of this module.
 *
 * IT IMPORTS NOTHING FROM `$lib/server`. Not a type, not a constant. The
 * import graph is the enforcement: a value-carrying server module that cannot
 * be reached from the browser bundle cannot leak into it. Shapes below MIRROR
 * `src/lib/server/core/*` deliberately rather than importing them.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE SEAM
 * ---------------------------------------------------------------------------
 * `/api/v1` does not exist yet -- another agent is building it. `PrickApi`
 * below is the interface both implementations satisfy:
 *
 *   `httpApi`     real `fetch` against `/api/v1` (written, unused today)
 *   `fixtureApi`  an in-memory dataset in `./fixtures.ts`
 *
 * `USE_FIXTURES` in `./fixtures.ts` picks one. Swapping to the real API is
 * that one boolean plus deleting `fixtures.ts`; there is no other place in the
 * UI that knows which backend it is talking to.
 */

import { ApiErrorBody, type IdentityKind, type Role, type ScopeType } from "@prick/shared";

import { ApiError } from "./errors.js";
import { fixtureApi, USE_FIXTURES } from "./fixtures.js";

export { ApiError, toApiError, type ApiErrorIssue } from "./errors.js";

export const API_BASE = "/api/v1";

// ---------------------------------------------------------------------------
// Wire shapes -- mirrors of `src/lib/server/core/*`
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  environmentCount: number;
  updatedAt: number;
}

export interface EnvironmentSummary {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Optimistic-concurrency token. Round-tripped as `expected_rev`. */
  rev: number;
  secretCount: number;
  updatedAt: number;
}

/**
 * A secret as it appears in a LIST. There is no value here and there must
 * never be one -- this shape is what the audit and history screens consume,
 * and it is the only secret shape any SSR-rendered screen may touch.
 */
export interface SecretListEntry {
  key: string;
  description: string | null;
  version: number;
  updatedAt: number;
  updatedBy: string;
  /**
   * The stored envelope failed to open: altered bytes, a failed AEAD tag, or a
   * `kid` the ring no longer holds.
   *
   * Rendered as a destructive inline alert in the row, never as a blank cell.
   * A tamper attempt is the loudest thing in the UI for the same reason it is
   * the loudest thing in the server: a silently-skipped row is how an
   * environment deploys without `DATABASE_URL`.
   */
  unreadable: boolean;
}

export interface VersionEntry {
  version: number;
  op: string;
  createdAt: number;
  createdBy: string;
  kid: string | null;
  /** A tombstone: this version records the key's deletion. */
  deleted: boolean;
}

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
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

/**
 * A subject that authenticated and was then denied, and that holds no grants.
 *
 * A service token's `common_name` is an opaque hex string; nobody can map
 * `e367826f93b8d71185e03fe518aff3b4.access` to "staging deploy" by looking at
 * it. Surfacing denials turns provisioning CI into: point it at prick, watch
 * it 403, click Grant.
 */
export interface UnknownIdentity {
  kind: IdentityKind;
  subject: string;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
}

export interface AuditEntryView {
  id: string;
  ts: number;
  requestId: string | null;
  actorKind: string;
  actorSubject: string;
  action: string;
  outcome: "success" | "denied" | "error";
  projectId: string | null;
  environmentId: string | null;
  /** Denormalised for display. Slugs, never ids, in the UI. */
  projectSlug: string | null;
  environmentSlug: string | null;
  targetKey: string | null;
  detail: unknown;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass back as `cursor` for the next page. `null` at the end of the log. */
  cursor: string | null;
}

export interface KeyringStatus {
  activeKid: string;
  entries: {
    kid: string;
    status: "active" | "retiring" | "retired";
    rowsRemaining: number;
    lastRekeyAt: number | null;
  }[];
  /** Only true at zero rows on every non-active kid. See the settings screen. */
  safeToRemoveOldKey: boolean;
}

/**
 * The result of an import, dry run or not.
 *
 * KEY NAMES AND COUNTS ONLY. The diff never carries a value in either
 * direction -- not the incoming one, not the one being replaced.
 */
export interface ImportPreview {
  dryRun: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
  warnings: { line: number; message: string }[];
  rev: number;
}

export interface WriteResult {
  rev: number;
}

export type RevealReason = "reveal" | "copy" | "export" | "run";

export interface AuditFilter {
  project?: string;
  environment?: string;
  actor?: string;
  action?: string;
  outcome?: "success" | "denied" | "error";
  since?: number;
  until?: number;
  cursor?: string;
  limit?: number;
}

export interface BatchInput {
  mode?: "merge" | "replace";
  set?: Record<string, string>;
  delete?: string[];
  expected_rev?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// The interface both backends satisfy
// ---------------------------------------------------------------------------

export interface PrickApi {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(project: string): Promise<ProjectSummary>;
  createProject(input: {
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<ProjectSummary>;
  updateProject(
    project: string,
    input: { name?: string; description?: string | null },
  ): Promise<ProjectSummary>;
  deleteProject(project: string): Promise<void>;

  listEnvironments(project: string): Promise<EnvironmentSummary[]>;
  getEnvironment(project: string, environment: string): Promise<EnvironmentSummary>;
  createEnvironment(
    project: string,
    input: { slug: string; name: string; description?: string | null },
  ): Promise<EnvironmentSummary>;
  deleteEnvironment(project: string, environment: string): Promise<void>;

  listSecrets(project: string, environment: string): Promise<SecretListEntry[]>;
  /**
   * ONE value, audited before it returns.
   *
   * Called on reveal AND on every copy -- copy never reads the value out of
   * `reveal.svelte.ts`, precisely so that taking a value is a distinct audit
   * row from looking at one.
   */
  revealSecret(
    project: string,
    environment: string,
    key: string,
    reason: RevealReason,
  ): Promise<string>;
  writeSecrets(project: string, environment: string, input: BatchInput): Promise<WriteResult>;
  renameSecret(
    project: string,
    environment: string,
    from: string,
    to: string,
  ): Promise<WriteResult>;
  importSecrets(
    project: string,
    environment: string,
    input: {
      format: "env" | "json";
      content: string;
      mode: "merge" | "replace";
      dry_run: boolean;
      expected_rev?: number;
      reason?: string;
    },
  ): Promise<ImportPreview>;
  /** The whole environment, decrypted. Audited as one `secret.export` row. */
  exportSecrets(project: string, environment: string): Promise<Record<string, string>>;

  listVersions(project: string, environment: string, key: string): Promise<VersionEntry[]>;
  rollbackSecret(
    project: string,
    environment: string,
    input: { key: string; to_version: number; reason?: string },
  ): Promise<{ rev: number; version: number }>;

  listIdentities(): Promise<IdentityRecord[]>;
  updateIdentity(
    id: string,
    input: { display_name?: string | null; disabled?: boolean },
  ): Promise<IdentityRecord>;
  listGrants(): Promise<GrantRecord[]>;
  createGrant(input: {
    identity_id: string;
    role: Role;
    scope_type: ScopeType;
    project?: string;
    environment?: string;
    expires_at?: number | null;
  }): Promise<GrantRecord>;
  revokeGrant(id: string): Promise<void>;
  listUnknownIdentities(): Promise<UnknownIdentity[]>;

  queryAudit(filter: AuditFilter): Promise<AuditPage>;

  getKeyringStatus(): Promise<KeyringStatus>;
  rekeyPage(limit: number): Promise<{ rekeyed: number; remaining: number }>;
}

// ---------------------------------------------------------------------------
// The HTTP implementation
// ---------------------------------------------------------------------------

/**
 * Every path segment is percent-encoded.
 *
 * Secret keys are POSIX names and project slugs are `[a-z0-9-]`, so nothing
 * legal needs escaping today -- which is exactly why forgetting the encode
 * would go unnoticed until a key that shouldn't exist reached the router.
 */
function seg(value: string): string {
  return encodeURIComponent(value);
}

async function request<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const { query, ...rest } = init;

  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = new Headers(rest.headers);
  headers.set("accept", "application/json");
  if (rest.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(url, {
    ...rest,
    headers,
    // No `credentials: 'include'`: this is same-origin, the Access cookie is
    // sent by default, and asking for cross-origin credentials on an API that
    // deliberately emits no CORS headers would only ever be misleading.
    credentials: "same-origin",
  });

  if (response.status === 204) return undefined as T;

  const requestId = response.headers.get("x-request-id");

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    const parsed = ApiErrorBody.safeParse(body);
    if (parsed.success) {
      throw new ApiError({
        code: parsed.data.code,
        message: parsed.data.message,
        status: response.status,
        requestId: parsed.data.request_id ?? requestId,
        hint: parsed.data.hint ?? null,
        issues: parsed.data.issues ?? [],
      });
    }

    throw new ApiError({
      code: "INTERNAL",
      message: `The server returned ${response.status} with an unrecognised body.`,
      status: response.status,
      requestId,
    });
  }

  return (await response.json()) as T;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

const envPath = (project: string, environment: string) =>
  `/projects/${seg(project)}/environments/${seg(environment)}`;

export const httpApi: PrickApi = {
  listProjects: () => request("/projects"),
  getProject: (project) => request(`/projects/${seg(project)}`),
  createProject: (input) => request("/projects", { method: "POST", ...json(input) }),
  updateProject: (project, input) =>
    request(`/projects/${seg(project)}`, { method: "PATCH", ...json(input) }),
  deleteProject: (project) => request(`/projects/${seg(project)}`, { method: "DELETE" }),

  listEnvironments: (project) => request(`/projects/${seg(project)}/environments`),
  getEnvironment: (project, environment) => request(envPath(project, environment)),
  createEnvironment: (project, input) =>
    request(`/projects/${seg(project)}/environments`, { method: "POST", ...json(input) }),
  deleteEnvironment: (project, environment) =>
    request(envPath(project, environment), { method: "DELETE" }),

  listSecrets: (project, environment) => request(`${envPath(project, environment)}/secrets`),
  revealSecret: async (project, environment, key, reason) => {
    const body = await request<{ key: string; value: string; version: number }>(
      `${envPath(project, environment)}/secrets/${seg(key)}:reveal`,
      { query: { reason } },
    );
    return body.value;
  },
  writeSecrets: (project, environment, input) =>
    request(`${envPath(project, environment)}/secrets:batch`, { method: "POST", ...json(input) }),
  renameSecret: (project, environment, from, to) =>
    request(`${envPath(project, environment)}/secrets:rename`, {
      method: "POST",
      ...json({ from, to }),
    }),
  importSecrets: (project, environment, input) =>
    request(`${envPath(project, environment)}/secrets:import`, { method: "POST", ...json(input) }),
  exportSecrets: (project, environment) =>
    request(`${envPath(project, environment)}/secrets:export`),

  listVersions: (project, environment, key) =>
    request(`${envPath(project, environment)}/secrets/${seg(key)}/versions`),
  rollbackSecret: (project, environment, input) =>
    request(`${envPath(project, environment)}/secrets:rollback`, {
      method: "POST",
      ...json(input),
    }),

  listIdentities: () => request("/identities"),
  updateIdentity: (id, input) =>
    request(`/identities/${seg(id)}`, { method: "PATCH", ...json(input) }),
  listGrants: () => request("/grants"),
  createGrant: (input) => request("/grants", { method: "POST", ...json(input) }),
  revokeGrant: (id) => request(`/grants/${seg(id)}`, { method: "DELETE" }),
  listUnknownIdentities: () => request("/access/unknown-identities"),

  queryAudit: (filter) =>
    request("/audit", {
      query: {
        project: filter.project,
        environment: filter.environment,
        actor: filter.actor,
        action: filter.action,
        outcome: filter.outcome,
        since: filter.since,
        until: filter.until,
        cursor: filter.cursor,
        limit: filter.limit,
      },
    }),

  getKeyringStatus: () => request("/keyring"),
  rekeyPage: (limit) => request("/admin/rekey", { method: "POST", ...json({ limit }) }),
};

/**
 * The one line the whole UI talks to.
 *
 * Flip `USE_FIXTURES` and every screen is on the real API; nothing else in
 * `src/routes` or `src/lib/components` references `httpApi` or `fixtureApi`.
 */
export const api: PrickApi = USE_FIXTURES ? fixtureApi : httpApi;
