import { randomUUID } from "node:crypto";

import type { ServerConfig } from "./config.ts";
import { ToolError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { routes } from "./routes.ts";
import { USER_AGENT } from "./version.ts";

/**
 * The HTTP client for the Worker API.
 *
 * Authentication is a Cloudflare Access **service token**: two headers,
 * `CF-Access-Client-Id` and `CF-Access-Client-Secret`, which Access validates at
 * the edge before the request ever reaches the Worker. There is no login flow,
 * no token store and no refresh here -- that is the human CLI's problem, and
 * pulling it into a machine client is how a machine client ends up needing a
 * browser.
 *
 * Three properties this client holds that the code it replaces did not:
 *
 * 1. `res.ok` is checked BEFORE the body is parsed. Parsing first means a 502
 *    from a proxy surfaces as "Unexpected token < in JSON" and the operator
 *    spends an afternoon on the wrong problem.
 * 2. A non-2xx body is only quoted back when it parses as the API's own error
 *    envelope. Anything else -- an Access login page, an HTML error, a proxy
 *    banner -- is described, never echoed.
 * 3. Every path segment is percent-encoded, and every request carries an
 *    `X-Request-Id` that is logged, so a failure in a transcript can be joined
 *    to a row in the audit log.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SecretListEntry {
  key: string;
  description: string | null;
  version: number | null;
  updated_at: number | null;
  updated_by: string | null;
  /**
   * The stored envelope failed to decrypt or failed its AEAD tag.
   *
   * Surfaced, never dropped. A list that silently omits rows it could not read
   * turns a tamper attempt into a quietly shorter `.env`, which is how a
   * deployment goes out without `DATABASE_URL` and nobody finds out until the
   * outage.
   */
  unreadable: boolean;
}

export interface ProjectSummary {
  slug: string;
  name: string | null;
  description: string | null;
  environment_count: number | null;
  updated_at: number | null;
}

export interface EnvironmentSummary {
  slug: string;
  name: string | null;
  description: string | null;
  /** Optimistic-concurrency token, round-tripped as `expected_rev`. */
  rev: number | null;
  secret_count: number | null;
  updated_at: number | null;
}

export interface BatchResult {
  rev: number | null;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface RequestContext {
  project?: string;
  environment?: string;
  key?: string;
}

export class PrickApiClient {
  readonly #config: ServerConfig;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;

  constructor(config: ServerConfig, logger: Logger, fetchImpl?: FetchLike) {
    this.#config = config;
    this.#logger = logger;
    this.#fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const body = await this.#request("GET", routes.projects(), undefined, {});
    return unwrapCollection(body, "projects", {}).map(toProjectSummary);
  }

  async listEnvironments(project: string): Promise<EnvironmentSummary[]> {
    const context: RequestContext = { project };
    const body = await this.#request("GET", routes.environments(project), undefined, context);
    return unwrapCollection(body, "environments", context).map(toEnvironmentSummary);
  }

  async listSecrets(project: string, environment: string): Promise<SecretListEntry[]> {
    const context: RequestContext = { project, environment };
    const body = await this.#request(
      "GET",
      routes.secrets(project, environment),
      undefined,
      context,
    );
    return unwrapCollection(body, "secrets", context).map(toSecretListEntry);
  }

  /**
   * Set one key. A MERGE: every other key in the environment is untouched.
   *
   * `expected_rev` is deliberately not sent. A merge of a single key has no
   * read-modify-write to lose a race on, and sending a revision this process
   * read some seconds ago would turn a concurrent, unrelated write by a human in
   * the UI into a spurious 412.
   */
  async setSecret(
    project: string,
    environment: string,
    key: string,
    value: string,
    reason: string | undefined,
  ): Promise<BatchResult> {
    const context: RequestContext = { project, environment, key };

    const body = await this.#request(
      "POST",
      routes.secretsBatch(project, environment),
      { mode: "merge", set: { [key]: value }, ...(reason === undefined ? {} : { reason }) },
      context,
    );

    return toBatchResult(body);
  }

  async deleteSecret(
    project: string,
    environment: string,
    key: string,
    reason: string | undefined,
  ): Promise<BatchResult> {
    const context: RequestContext = { project, environment, key };

    const body = await this.#request(
      "POST",
      routes.secretsBatch(project, environment),
      { mode: "merge", delete: [key], ...(reason === undefined ? {} : { reason }) },
      context,
    );

    return toBatchResult(body);
  }

  /**
   * The one method in this file that returns plaintext.
   *
   * Its result is never logged, never included in an error, and never retained:
   * it is handed straight to the caller and forgotten. `reason` is recorded in
   * the server's audit log so an operator can tell "an assistant looked at this"
   * from "an assistant took a copy of this".
   */
  async revealSecret(
    project: string,
    environment: string,
    key: string,
    reason: string,
  ): Promise<string> {
    const context: RequestContext = { project, environment, key };
    const path = `${routes.secretReveal(project, environment, key)}?reason=${encodeURIComponent(reason)}`;

    const body = await this.#request("GET", path, undefined, context, "json-or-text");

    if (typeof body === "string") return body;

    if (typeof body === "object" && body !== null && "value" in body) {
      const value: unknown = (body as { value: unknown }).value;
      if (typeof value === "string") return value;
    }

    throw new ToolError(
      "API",
      "The reveal endpoint did not return a value in a shape this client understands.",
      {
        ...context,
        hint: "The server may be a newer version than this MCP package. Nothing was written; nothing is cached.",
      },
    );
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    context: RequestContext,
    accept: "json" | "json-or-text" = "json",
  ): Promise<unknown> {
    const requestId = randomUUID();
    const url = `${this.#config.apiBaseUrl}${path}`;

    const headers: Record<string, string> = {
      // Cloudflare Access service token. Validated at the edge; the Worker never
      // sees these two headers, only the signed JWT Access mints from them.
      "CF-Access-Client-Id": this.#config.accessClientId,
      "CF-Access-Client-Secret": this.#config.accessClientSecret,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-Request-Id": requestId,
    };

    if (body !== undefined) headers["Content-Type"] = "application/json";

    // The request LINE is logged. The request BODY is not, ever: on a write it
    // is a document whose entire purpose is to carry a secret value.
    this.#logger.debug("api request", {
      method,
      path,
      request_id: requestId,
      project: context.project,
      environment: context.environment,
      key: context.key,
    });

    let response: Response;

    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        redirect: "manual",
      });
    } catch (error) {
      throw this.#transportError(error, context, requestId);
    }

    const echoedId = response.headers.get("x-request-id") ?? requestId;

    // res.ok BEFORE res.json(). Not a style preference: the reverse order is a
    // named defect in the code this project replaces, and it is the direct cause
    // of "undescriptive error when the server is unreachable".
    if (!response.ok) {
      throw await this.#httpError(response, context, echoedId);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("json")) {
      // A 2xx that is not JSON is not a success this client accepts. The one
      // exception is the reveal endpoint, which may legitimately answer
      // text/plain. Everything else answering HTML with a 200 means the base URL
      // points at something that is not the API -- a marketing page, a proxy, an
      // Access interstitial -- and treating that as "the write succeeded, it
      // just had no fields" is how a secret silently fails to be stored.
      if (accept === "json-or-text" && contentType.includes("text/plain")) {
        return await response.text();
      }

      throw new ToolError("API", "The API answered with a body that is not JSON.", {
        ...context,
        status: response.status,
        request_id: echoedId,
        hint: `Check that ${this.#config.apiBaseUrl} is the origin of the Worker itself, not a proxy, a redirect or a landing page.`,
      });
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ToolError(
        "API",
        "The API returned a success status with a body that is not valid JSON.",
        {
          ...context,
          status: response.status,
          request_id: echoedId,
          hint: "Check that the base URL points at the Worker itself and not at a proxy or a redirect.",
        },
      );
    }
  }

  #transportError(error: unknown, context: RequestContext, requestId: string): ToolError {
    const name = error instanceof Error ? error.name : "";

    if (name === "TimeoutError" || name === "AbortError") {
      return new ToolError(
        "TRANSPORT",
        `The API did not respond within ${String(this.#config.requestTimeoutMs)} ms.`,
        {
          ...context,
          request_id: requestId,
          hint: "The write, if this was one, may or may not have been applied. Re-read the environment with secrets_list before retrying.",
        },
      );
    }

    // The message of a fetch rejection is not quoted. Node's undici embeds the
    // request URL and, on some failures, header material; it has no business in
    // a transcript.
    return new ToolError("TRANSPORT", "The API could not be reached.", {
      ...context,
      request_id: requestId,
      hint: `Check that ${this.#config.apiBaseUrl} is correct and reachable from this machine, and that the host resolves.`,
    });
  }

  async #httpError(
    response: Response,
    context: RequestContext,
    requestId: string,
  ): Promise<ToolError> {
    const envelope = await readErrorEnvelope(response);

    const detail = {
      ...context,
      status: response.status,
      request_id: envelope?.request_id ?? requestId,
      ...(envelope?.code === undefined ? {} : { api_code: envelope.code }),
    };

    // A redirect from an authenticated API call means Access is answering
    // instead of the Worker -- i.e. the service token was not accepted and the
    // edge is trying to send a browser to a login page.
    if (response.status >= 300 && response.status < 400) {
      return new ToolError(
        "API",
        "Cloudflare Access redirected the request to a login page instead of answering it.",
        {
          ...detail,
          hint: "The service token headers were not accepted. Check the Client ID and Secret, and that the token is attached to a policy on this Access application.",
        },
      );
    }

    const message = envelope?.message ?? `The API answered ${String(response.status)}.`;
    const hint = envelope?.hint ?? defaultHintFor(response.status);

    return new ToolError("API", message, { ...detail, ...(hint === undefined ? {} : { hint }) });
  }
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

interface ApiErrorEnvelope {
  code?: string;
  message?: string;
  hint?: string;
  request_id?: string;
}

/**
 * Read a non-2xx body, and return it ONLY if it is the API's own envelope.
 *
 * The alternative -- "include the response text, it helps" -- means an HTML
 * login page, a proxy's diagnostic banner, or an unhandled stack trace gets
 * pasted into a model's context. The envelope is a contract whose fields are
 * documented not to carry values; nothing else is.
 */
async function readErrorEnvelope(response: Response): Promise<ApiErrorEnvelope | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;

  let parsed: unknown;

  try {
    parsed = (await response.json()) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const envelope: ApiErrorEnvelope = {};

  if (typeof record["code"] === "string") envelope.code = record["code"];
  if (typeof record["message"] === "string") envelope.message = record["message"];
  if (typeof record["hint"] === "string") envelope.hint = record["hint"];
  if (typeof record["request_id"] === "string") envelope.request_id = record["request_id"];

  return envelope.code === undefined && envelope.message === undefined ? undefined : envelope;
}

function defaultHintFor(status: number): string | undefined {
  switch (status) {
    case 401:
      return "Cloudflare Access did not authenticate the service token. Check the Client ID and Secret.";
    case 403:
      return "The service token is authenticated but has no grant for this scope. An administrator can find it under the 'Seen but not granted' list and grant it.";
    case 404:
      return "The project or environment does not exist, or this identity cannot see it. Use projects_list and environments_list to check.";
    case 409:
      return "A concurrent write took the same version. Re-read with secrets_list and try again.";
    case 412:
      return "The environment changed since it was read. Nothing was written.";
    case 413:
      return "The value or the environment is larger than the server accepts.";
    case 429:
      return "Rate limited. Wait before retrying.";
    default:
      return status >= 500
        ? "This is a server-side failure. Nothing in the request was retained here."
        : undefined;
  }
}

/**
 * Pull a list out of whatever wrapper the endpoint used.
 *
 * Deliberately tolerant of a bare array, `{data: []}` and `{<name>: []}`. This
 * package targets a route set that is being written in parallel with it; being
 * relaxed about the envelope while being STRICT about the fields inside it (see
 * the projections below) puts the tolerance where a mistake is cheap and the
 * strictness where it is not.
 */
export function unwrapCollection(body: unknown, name: string, context: RequestContext): unknown[] {
  if (Array.isArray(body)) return body;

  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;

    for (const candidate of [name, "data", "items", "results"]) {
      const value = record[candidate];
      if (Array.isArray(value)) return value;
    }
  }

  throw new ToolError("API", `The API did not return a list of ${name}.`, {
    ...context,
    hint: "The server may be a newer version than this MCP package.",
  });
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in record && record[name] !== undefined) return record[name];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new ToolError("API", `The API returned a ${what} entry that is not an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * ALLOW-LIST PROJECTION, not a pass-through.
 *
 * Every one of these mappers names the fields it will forward and drops the
 * rest. For `toSecretListEntry` that is the whole security property of
 * `secrets_list`: if a future server build ever adds a `value` (or `plaintext`,
 * or `envelope`) field to the list response -- by accident, by a debug flag left
 * on, or because someone thought it would save a round-trip -- this function
 * does not forward it. "The list tool cannot leak a value" then holds because of
 * the shape of this code, not because of a promise made by a different package.
 */
export function toSecretListEntry(raw: unknown): SecretListEntry {
  const record = asRecord(raw, "secret");
  const key = asString(field(record, "key", "name"));

  if (key === null) {
    throw new ToolError("API", "The API returned a secret entry with no key name.");
  }

  return {
    key,
    description: asString(field(record, "description")),
    version: asNumber(field(record, "version")),
    updated_at: asNumber(field(record, "updated_at", "updatedAt")),
    updated_by: asString(field(record, "updated_by", "updatedBy")),
    unreadable: field(record, "unreadable") === true,
  };
}

export function toProjectSummary(raw: unknown): ProjectSummary {
  const record = asRecord(raw, "project");
  const slug = asString(field(record, "slug"));

  if (slug === null) {
    throw new ToolError("API", "The API returned a project entry with no slug.");
  }

  return {
    slug,
    name: asString(field(record, "name")),
    description: asString(field(record, "description")),
    environment_count: asNumber(field(record, "environment_count", "environmentCount")),
    updated_at: asNumber(field(record, "updated_at", "updatedAt")),
  };
}

export function toEnvironmentSummary(raw: unknown): EnvironmentSummary {
  const record = asRecord(raw, "environment");
  const slug = asString(field(record, "slug"));

  if (slug === null) {
    throw new ToolError("API", "The API returned an environment entry with no slug.");
  }

  return {
    slug,
    name: asString(field(record, "name")),
    description: asString(field(record, "description")),
    rev: asNumber(field(record, "rev")),
    secret_count: asNumber(field(record, "secret_count", "secretCount")),
    updated_at: asNumber(field(record, "updated_at", "updatedAt")),
  };
}

function asKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function toBatchResult(raw: unknown): BatchResult {
  if (typeof raw !== "object" || raw === null) {
    return { rev: null, added: [], changed: [], removed: [] };
  }

  const record = raw as Record<string, unknown>;

  return {
    rev: asNumber(field(record, "rev")),
    added: asKeyList(field(record, "added")),
    changed: asKeyList(field(record, "changed")),
    removed: asKeyList(field(record, "removed")),
  };
}
