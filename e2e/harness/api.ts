/**
 * A thin, typed client for `/api/v1`, used by `globalSetup` and by the specs.
 *
 * Deliberately built on `fetch` and NOT on Playwright's `APIRequestContext`,
 * for one reason: `globalSetup` needs the same client, and it runs before any
 * fixture exists. One client used by both means the setup path and the assertion
 * path cannot disagree about how a request is formed -- which matters most for
 * the one thing that is easy to get subtly wrong, the credential.
 *
 * The credential is the `Cf-Access-Jwt-Assertion` HEADER rather than the cookie,
 * because that is what the application treats as primary and what the CLI sends.
 * The cookie path is exercised by every browser spec, which carries it in
 * storage state.
 *
 * `raw()` exists because a good half of this suite is about responses that are
 * NOT 200 -- a 403 after a grant is revoked, a 500 on an undecryptable row, the
 * `Cache-Control` on a reveal. A client that threw on those would make the
 * interesting assertions unwritable.
 */

import { ASSERTION_HEADER } from "./constants";

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  hint?: string;
  requestId: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(failure: ApiFailure, path: string) {
    super(`${failure.code} (${String(failure.status)}) on ${path}: ${failure.message}`);
    this.name = "ApiError";
    this.status = failure.status;
    this.code = failure.code;
    this.requestId = failure.requestId;
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.#token = token;
  }

  /** The URL of an API path, for specs that need to name one. */
  url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  async raw(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const headers = new Headers(init.headers ?? {});
    headers.set(ASSERTION_HEADER, this.#token);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");

    const response = await fetch(this.url(path), {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();

    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }

    return { status: response.status, headers: response.headers, body, text };
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await this.raw(path, init);

    if (response.status >= 400) {
      const failure = response.body as Partial<ApiFailure> | undefined;
      throw new ApiError(
        {
          status: response.status,
          code: failure?.code ?? "UNKNOWN",
          message: failure?.message ?? response.text.slice(0, 200),
          requestId: response.headers.get("x-request-id"),
        },
        path,
      );
    }

    return response.body as T;
  }
}

// ---------------------------------------------------------------------------
// The shapes the specs assert on. Mirrors of the OpenAPI document, not imports:
// `@prick/shared` is a workspace package the e2e project deliberately does not
// depend on, so that a schema change that breaks the wire shows up here as a
// failing assertion rather than as a type that quietly moved with it.
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
  rev: number;
  secretCount: number;
  updatedAt: number;
}

export interface SecretListEntry {
  key: string;
  description: string | null;
  version: number;
  updatedAt: number;
  updatedBy: string;
  kid: string | null;
  unreadable: boolean;
}

/**
 * The import diff. Key names and change kinds only, never a value.
 *
 * NOTE, and it is a real one: this is the SERVER's shape. The browser client's
 * `ImportPreview` in `packages/app/src/lib/client/api.ts` declares
 * `dryRun`, `unchanged` and `rev` instead of `applied`, and the import dialog
 * renders `preview.unchanged.length`. Those fields exist in the in-memory
 * fixture and do not exist on the wire, so the dialog reads `undefined.length`
 * the moment `USE_FIXTURES` is flipped. Asserted below in
 * `tests/api-flow.spec.ts` so the mismatch is a documented fact rather than a
 * surprise during cutover.
 */
export interface ImportResult {
  added: string[];
  changed: string[];
  removed: string[];
  /** `false` for a dry run. There is no `dryRun` field on the wire. */
  applied: boolean;
  warnings: { line: number; key: string; message: string }[];
}

export interface WriteSecretsResult {
  /** The environment's revision AFTER the write. Send back as `If-Match`. */
  rev: number;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface AuditEntry {
  id: string;
  ts: number;
  requestId: string | null;
  actorKind: string;
  actorSubject: string;
  action: string;
  outcome: "success" | "denied" | "error";
  projectSlug: string | null;
  environmentSlug: string | null;
  targetKey: string | null;
  detail: unknown;
}

export interface AuditPage {
  entries: AuditEntry[];
  cursor: string | null;
}

export interface GrantRecord {
  id: string;
  identityId: string;
  role: "reader" | "writer" | "admin";
  scopeType: "global" | "project" | "environment";
  projectSlug: string | null;
  environmentSlug: string | null;
  expiresAt: number | null;
}

export interface IdentityRecord {
  id: string;
  kind: "user" | "service";
  subject: string;
  displayName: string | null;
  disabled: boolean;
  lastSeenAt: number | null;
}

export interface Whoami {
  kind: "user" | "service";
  subject: string;
  identityId: string | null;
  role: "reader" | "writer" | "admin" | null;
  bootstrap: boolean;
}

/** `…/projects/{p}/environments/{e}` -- the canonical spelling. */
export function environmentPath(project: string, environment: string): string {
  return `/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}`;
}
