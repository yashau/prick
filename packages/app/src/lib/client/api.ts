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
 * THE MIRROR IS CHECKED, in two places that are worth knowing about before
 * editing anything below. `src/lib/server/http/schemas.ts` asserts each
 * RESPONSE schema against the `core` return type it describes, so
 * `pnpm typecheck` fails the moment they diverge; `docs/openapi.json` is
 * generated from those schemas and committed. Both are therefore the authority
 * on the shapes here, and a field that appears below and in neither of them is
 * a field the server does not send.
 *
 * (There WAS a fixture seam here -- an in-memory backend selected by a
 * `USE_FIXTURES` flag while `/api/v1` was being built. It is gone: `httpApi`
 * is the only implementation, and the SSR-rendered screens call
 * `src/lib/server/core/*` in-process from their `+*.server.ts` loads rather
 * than coming back through this module.)
 */

import { ApiErrorBody, type IdentityKind, type Role, type ScopeType } from "@prick/shared";

import { ApiError } from "./errors.js";

export { ApiError, toApiError, type ApiErrorIssue } from "./errors.js";

export const API_BASE = "/api/v1";

// ---------------------------------------------------------------------------
// Wire shapes -- mirrors of `src/lib/server/core/*`
// ---------------------------------------------------------------------------

/**
 * Who the server decided is looking at it. Mirrors `GET /api/v1/whoami`.
 *
 * NOT fetched by the browser: the shell needs it on the first paint, so
 * `(app)/+layout.server.ts` builds it from `event.locals.ctx` -- the SAME
 * verified Access actor the API resolves -- and passes it down. The type lives
 * here rather than next to that load because a component renders it, and a
 * component may not import from `$lib/server`.
 *
 * `role` is the GLOBAL role and can be `null`: a project-scoped admin holds no
 * role at global scope and is still an admin of that project. Do not render it
 * as "no access".
 *
 * `bootstrap` is true while the only thing making this actor an admin is the
 * `BOOTSTRAP_ADMINS` var rather than a `grants` row. The banner it drives is a
 * guard, not decoration -- an install left in that state has an admin nobody
 * can revoke through the UI.
 *
 * There is deliberately no `displayName`. `/whoami` does not return one and
 * nothing in `core` will hand an actor its own identity row, so the shell shows
 * the subject.
 */
export interface Viewer {
  kind: IdentityKind;
  subject: string;
  identityId: string | null;
  role: Role | null;
  bootstrap: boolean;
}

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
  /** The master key id the current version is sealed under. Not a secret. */
  kid: string | null;
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
  /** The grantee's subject, joined server-side. Saves a lookup per row. */
  subject: string;
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

/**
 * One audit row, exactly as `core.queryAudit` emits it.
 *
 * IDS, NOT SLUGS. There is no `projectSlug` / `environmentSlug` here and there
 * must not be one invented: the log is append-only and historical, and a row
 * denormalising a slug would be recording a name that can be re-pointed at a
 * different id by a delete and a re-create. `scopeLabel()` in `./audit.ts`
 * resolves these ids for display against data the screen has already loaded,
 * and falls back to printing the id rather than guessing.
 *
 * `outcome` is a bare string for the same reason: the log outlives the union.
 * A row written by an older build with an outcome this one does not know about
 * must still render, and `OutcomeBadge` already treats an unrecognised value as
 * the destructive case.
 */
export interface AuditEntryView {
  id: string;
  ts: number;
  requestId: string | null;
  actorKind: string;
  actorSubject: string;
  action: string;
  outcome: string;
  projectId: string | null;
  environmentId: string | null;
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
 * KEY NAMES AND CHANGE KINDS ONLY. The diff never carries a value in either
 * direction -- not the incoming one, not the one being replaced. `changed`
 * means "this key already existed and is being rewritten"; it does NOT mean the
 * value differs, and it cannot, because telling those apart would require
 * decrypting every existing value to compare -- a silent full-environment
 * reveal performed by the screen whose purpose is to avoid one.
 *
 * `applied` is the dry-run flag, the right way round: `false` means nothing was
 * written. There is no `unchanged` list and no `rev` -- the server sends
 * neither, and the screen re-reads the environment after an apply rather than
 * trusting a revision that arrived with the diff.
 */
export interface ImportResult {
  added: string[];
  changed: string[];
  removed: string[];
  /** `false` for a dry run: the diff is what WOULD happen. */
  applied: boolean;
  /** A line the parser refused. `key` is empty when it could not find one. */
  warnings: { line: number; key: string; message: string }[];
}

/** The revision after a batch write, and the diff it produced. */
export interface WriteSecretsResult {
  rev: number;
  added: string[];
  changed: string[];
  removed: string[];
}

/** A rename reports the revision only -- there is no diff to report. */
export interface RenameResult {
  rev: number;
}

export interface RollbackResult {
  rev: number;
  /** The NEW version number. A rollback moves forward; it never resurrects. */
  version: number;
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
  writeSecrets(
    project: string,
    environment: string,
    input: BatchInput,
  ): Promise<WriteSecretsResult>;
  renameSecret(
    project: string,
    environment: string,
    from: string,
    to: string,
  ): Promise<RenameResult>;
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
  ): Promise<ImportResult>;
  /** The whole environment, decrypted. Audited as one `secret.export` row. */
  exportSecrets(project: string, environment: string): Promise<Record<string, string>>;

  listVersions(project: string, environment: string, key: string): Promise<VersionEntry[]>;
  rollbackSecret(
    project: string,
    environment: string,
    input: { key: string; to_version: number; reason?: string },
  ): Promise<RollbackResult>;

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
  /*
   * The `:reveal` suffix is a second spelling of `GET …/secrets/{key}`, served
   * by the same handler. It is used deliberately: a secret key is a POSIX name
   * and cannot contain a colon, so the parse is unambiguous, and a reveal is
   * then distinguishable from an ordinary read in a proxy log by its path
   * alone. The response carries `{key, value}` and no version -- obtaining one
   * would cost the server a second resolution and a third query for a number
   * nothing here asks for.
   */
  revealSecret: async (project, environment, key, reason) => {
    const body = await request<{ key: string; value: string }>(
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

  // `/admin/keyring`, not `/keyring`. Both rekey and status live under the
  // admin prefix; there is no route at the bare path and there never was.
  getKeyringStatus: () => request("/admin/keyring"),
  rekeyPage: (limit) => request("/admin/rekey", { method: "POST", ...json({ limit }) }),
};

/**
 * The one line the whole UI talks to.
 *
 * Kept as a named binding rather than collapsing every call site onto
 * `httpApi`, because it is the seam a test double would be injected at and
 * because "which backend is this screen on" should stay a one-line answer.
 */
export const api: PrickApi = httpApi;
