/**
 * The Cloudflare Access service-token API, and nothing else of Cloudflare's.
 *
 * This is the only module in the Worker that holds the Cloudflare API token, and
 * it holds it in a closure: the token is read from the `CF_API_TOKEN` secret by
 * `accessServiceTokensFromEnv` and handed to nothing but the `Authorization`
 * header of a request to the configured API base. It never appears in
 * `RuntimeConfig`, in a `CoreContext` field anyone can read, or in an error.
 *
 * ---------------------------------------------------------------------------
 * A RESPONSE BODY HERE MAY CARRY A CLIENT SECRET, SO NO BODY EVER LEAVES.
 * ---------------------------------------------------------------------------
 * `create` and `rotate` answer with `client_secret`, the one copy of it that will
 * ever exist. So every failure path below builds its message from Cloudflare's
 * numeric error codes and the HTTP status alone. Nothing logs, nothing echoes a
 * body, and a body that fails to parse is reported as "unparseable", never
 * quoted. `test/cloudflare/access.test.ts` drives a sentinel secret through every
 * error path to hold that line.
 *
 * Endpoints, from the Cloudflare API reference (Zero Trust → Access → Service
 * Tokens), all under `/accounts/{account_id}/access/service_tokens`:
 *
 *   POST   /                     create; the only response carrying the secret
 *   GET    /?page&per_page       list, paginated, at most 1000 per page
 *   POST   /{id}/rotate          new secret, same client id; the previous one
 *                                expires at `previous_client_secret_expires_at`
 *                                (defaults to now)
 *   POST   /{id}/refresh         extend the expiry by the token's duration
 *   GET    /{id}                 one token, with its expiry
 *   PUT    /{id}                 partial update; prick sends only `enabled`
 *   DELETE /{id}                 delete
 *
 * The create and rotate responses carry no `expires_at`, so a token's expiry is
 * read with `GET /{id}` afterwards rather than assumed.
 *
 * Every one needs the account permission "Access: Service Tokens Write"
 * (dashboard: Access: Service Tokens → Edit), and nothing more.
 */

import type { CloudflareConfig } from "../core/context.js";

/** Cloudflare's view of a service token, without its secret. */
export interface CloudflareServiceToken {
  id: string;
  clientId: string;
  name: string;
  duration: string | null;
  enabled: boolean;
  /** Epoch ms, or `null` for a token created with `forever`. */
  expiresAt: number | null;
  /** Epoch ms of the token's last authentication, when Cloudflare reports one. */
  lastSeenAt: number | null;
  /** Set when a secret scanner reported this token's secret as leaked. */
  leakReportedAt: number | null;
}

/** A token with the secret Cloudflare returns exactly once. */
export interface IssuedServiceToken extends CloudflareServiceToken {
  clientSecret: string;
}

/**
 * The operations prick performs. An interface so `core` can be driven by a fake
 * that fails on command, which is how every partial-failure path is tested.
 */
export interface AccessServiceTokens {
  create(input: { name: string; duration: string }): Promise<IssuedServiceToken>;
  rotate(id: string, previousSecretExpiresAt: number | null): Promise<IssuedServiceToken>;
  refresh(id: string): Promise<CloudflareServiceToken>;
  get(id: string): Promise<CloudflareServiceToken>;
  /**
   * Re-enable a token. Cloudflare disables a token whose secret was reported as
   * leaked, and accepts re-enabling only after the secret has been rotated.
   */
  enable(id: string): Promise<CloudflareServiceToken>;
  /** `"absent"` when Cloudflare no longer knows the id: already gone is gone. */
  remove(id: string): Promise<"deleted" | "absent">;
  list(): Promise<CloudflareServiceToken[]>;
}

/**
 * A Cloudflare API call that did not succeed.
 *
 * `kind` is the only thing a caller branches on:
 *
 *   refused       401/403 -- the API token is wrong, expired, or lacks the
 *                 permission. A configuration problem; retrying will not help.
 *   not_found     404.
 *   unavailable   network failure, 429 or 5xx. Transient.
 *   rejected      any other 4xx: Cloudflare refused the request itself.
 *   malformed     a 2xx whose body is not the documented shape.
 */
export class CloudflareApiError extends Error {
  readonly kind: "refused" | "not_found" | "unavailable" | "rejected" | "malformed";
  readonly status: number | null;
  readonly codes: readonly number[];

  constructor(
    kind: CloudflareApiError["kind"],
    message: string,
    status: number | null,
    codes: readonly number[],
  ) {
    super(message);
    this.name = "CloudflareApiError";
    this.kind = kind;
    this.status = status;
    this.codes = codes;
  }
}

/** Bound every call well inside a Worker's request budget. */
const TIMEOUT_MS = 10_000;

const PAGE_SIZE = 1000;
/** 50 pages of 1000 is far beyond any real account, and bounds a broken pager. */
const MAX_PAGES = 50;

export interface AccessServiceTokensOptions {
  apiToken: string;
  accountId: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function createAccessServiceTokens(
  options: AccessServiceTokensOptions,
): AccessServiceTokens {
  const { apiToken, accountId, baseUrl, fetchImpl = fetch } = options;
  const root = `${baseUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(accountId)}/access/service_tokens`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CloudflareApiError(
        "unavailable",
        `The Cloudflare API could not be reached (${method} service_tokens).`,
        null,
        [],
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    const codes = errorCodes(parsed);
    const status = response.status;
    const label = `${method} service_tokens answered ${String(status)}${codes.length > 0 ? ` (Cloudflare code ${codes.join(", ")})` : ""}`;

    if (status === 401 || status === 403) {
      throw new CloudflareApiError(
        "refused",
        `The Cloudflare API refused the request: ${label}.`,
        status,
        codes,
      );
    }
    if (status === 404) {
      throw new CloudflareApiError(
        "not_found",
        `Cloudflare has no such service token: ${label}.`,
        status,
        codes,
      );
    }
    if (status === 429 || status >= 500) {
      throw new CloudflareApiError(
        "unavailable",
        `The Cloudflare API is unavailable: ${label}.`,
        status,
        codes,
      );
    }
    if (status < 200 || status >= 300 || !isRecord(parsed) || parsed["success"] !== true) {
      throw new CloudflareApiError(
        "rejected",
        `The Cloudflare API rejected the request: ${label}.`,
        status,
        codes,
      );
    }

    return parsed;
  }

  return {
    async create({ name, duration }) {
      const body = await call("POST", "", { name, duration });
      return issued(body);
    },

    async rotate(id, previousSecretExpiresAt) {
      const body = await call(
        "POST",
        `/${encodeURIComponent(id)}/rotate`,
        previousSecretExpiresAt === null
          ? {}
          : { previous_client_secret_expires_at: new Date(previousSecretExpiresAt).toISOString() },
      );
      return issued(body);
    },

    async refresh(id) {
      const body = await call("POST", `/${encodeURIComponent(id)}/refresh`);
      return token(resultOf(body));
    },

    async get(id) {
      const body = await call("GET", `/${encodeURIComponent(id)}`);
      return token(resultOf(body));
    },

    async enable(id) {
      const body = await call("PUT", `/${encodeURIComponent(id)}`, { enabled: true });
      return token(resultOf(body));
    },

    async remove(id) {
      try {
        await call("DELETE", `/${encodeURIComponent(id)}`);
        return "deleted";
      } catch (error) {
        if (error instanceof CloudflareApiError && error.kind === "not_found") return "absent";
        throw error;
      }
    },

    async list() {
      const out: CloudflareServiceToken[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await call("GET", `?page=${String(page)}&per_page=${String(PAGE_SIZE)}`);
        if (!isRecord(body) || !Array.isArray(body["result"])) {
          throw malformed("GET service_tokens");
        }

        const entries = body["result"];
        for (const entry of entries) out.push(token(entry));

        // The page size Cloudflare actually used, which may be smaller than the
        // one asked for: a short page is the end only when it is shorter than
        // THAT. `total_pages` and `total_count`, when present, decide outright.
        const info = isRecord(body["result_info"]) ? body["result_info"] : undefined;
        const totalPages = numberField(info, "total_pages");
        const totalCount = numberField(info, "total_count");
        const perPage = numberField(info, "per_page") ?? PAGE_SIZE;

        const more =
          totalPages !== undefined
            ? page < totalPages
            : totalCount !== undefined
              ? out.length < totalCount
              : entries.length >= perPage;
        if (!more || entries.length === 0) return out;
      }

      throw malformed("GET service_tokens (pagination did not end)");
    },
  };
}

/**
 * The client, or `null` when the feature is not configured.
 *
 * `null` is a value every caller has to handle, so a Worker without the secret
 * cannot reach a Cloudflare call by accident -- `core` turns it into a 503 that
 * names the missing piece.
 */
export function accessServiceTokensFromConfig(
  config: CloudflareConfig,
  apiToken: string | undefined,
): AccessServiceTokens | null {
  if (config.state !== "enabled" || apiToken === undefined) return null;

  return createAccessServiceTokens({
    apiToken,
    accountId: config.accountId,
    baseUrl: config.baseUrl,
  });
}

// ---------------------------------------------------------------------------
// Response parsing. Field by field, so an unexpected shape is a typed failure
// rather than an `undefined` that travels.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodes(body: unknown): number[] {
  if (!isRecord(body) || !Array.isArray(body["errors"])) return [];
  return body["errors"]
    .map((entry) => (isRecord(entry) && typeof entry["code"] === "number" ? entry["code"] : null))
    .filter((code): code is number => code !== null);
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function malformed(what: string): CloudflareApiError {
  return new CloudflareApiError(
    "malformed",
    `The Cloudflare API answered ${what} with a body that is not the documented shape.`,
    null,
    [],
  );
}

function resultOf(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body["result"])) throw malformed("service_tokens");
  return body["result"];
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function token(value: unknown): CloudflareServiceToken {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["client_id"] !== "string"
  ) {
    throw malformed("service_tokens");
  }

  return {
    id: value["id"],
    clientId: value["client_id"],
    name: typeof value["name"] === "string" ? value["name"] : "",
    duration: typeof value["duration"] === "string" ? value["duration"] : null,
    enabled: value["enabled"] !== false,
    expiresAt: timestamp(value["expires_at"]),
    lastSeenAt: timestamp(value["last_seen_at"]),
    leakReportedAt: timestamp(value["leak_reported_at"]),
  };
}

function issued(body: unknown): IssuedServiceToken {
  const result = resultOf(body);
  const base = token(result);
  const secret = isRecord(result) ? result["client_secret"] : undefined;

  if (typeof secret !== "string" || secret === "")
    throw malformed("service_tokens (no client secret)");

  return { ...base, clientSecret: secret };
}
