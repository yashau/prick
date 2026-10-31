/**
 * A fake of the one corner of the Cloudflare API the Worker calls: Access
 * service tokens, under `/accounts/{account_id}/access/service_tokens`.
 *
 * The second Worker the harness boots has `CF_API_BASE_URL` pointed here, so
 * `createAccessServiceTokens` in the Worker runs unmodified -- the same request
 * shapes, the same `Authorization` header, the same response parsing -- against
 * a server that holds its tokens in memory for the length of one run.
 *
 * Response bodies follow Cloudflare's envelope: `{success, errors, messages,
 * result}`, and `result_info` on the list. A request with the wrong bearer token
 * or account id is refused with 403 the way Cloudflare refuses it, so a Worker
 * that sent the wrong credential would fail loudly here too.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL SURFACE
 * ---------------------------------------------------------------------------
 * Two routes under `/__e2e/`, for specs in other processes:
 *
 *   GET  /__e2e/issued   every client secret this fake has handed out, so a
 *                        spec can search a page for the exact string;
 *   POST /__e2e/outage   `{on: boolean}`: while on, every Cloudflare route
 *                        answers 503, which the Worker reports as Cloudflare
 *                        being unreachable.
 *
 * Plain HTTP on `127.0.0.1`: the Worker's outbound `fetch` reaches it without
 * the TLS trust the Access origin needs, and nothing secret crosses a socket
 * that leaves the machine.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCloudflareApi {
  /** The value `CF_API_BASE_URL` is set to. */
  baseUrl: string;
  close(): Promise<void>;
}

interface FakeToken {
  id: string;
  client_id: string;
  client_secret: string;
  name: string;
  duration: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A marker in every issued secret, so a match in a page is unambiguous. */
export const FAKE_SECRET_MARKER = "e2ecfsecret";

const HOUR_MS = 3_600_000;

function expiryFor(duration: string, from: number): string | null {
  if (duration === "forever") return null;
  const hours = Number(duration.replace(/h$/, ""));
  return Number.isFinite(hours) ? new Date(from + hours * HOUR_MS).toISOString() : null;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** The token as Cloudflare lists and gets it: everything but the secret. */
function publicView(token: FakeToken): Omit<FakeToken, "client_secret"> {
  const { client_secret: _secret, ...rest } = token;
  return rest;
}

/**
 * The token as Cloudflare answers a create or a rotate: the secret, and NO
 * `expires_at`. The real API leaves the expiry out of both responses, so a
 * Worker that wants it has to GET the token afterwards -- and this fake makes
 * it do exactly that, rather than handing it a field production never sends.
 */
function issuedView(token: FakeToken): Omit<FakeToken, "expires_at"> {
  const { expires_at: _expiry, ...rest } = token;
  return rest;
}

/** Fields a `PUT` may change. Identity, secret and timestamps are the API's own. */
const IMMUTABLE = new Set(["id", "client_id", "client_secret", "created_at", "updated_at"]);

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function ok(response: ServerResponse, result: unknown, extra: Record<string, unknown> = {}): void {
  send(response, 200, { success: true, errors: [], messages: [], result, ...extra });
}

function failure(response: ServerResponse, status: number, code: number, message: string): void {
  send(response, status, {
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startFakeCloudflareApi(options: {
  apiToken: string;
  accountId: string;
}): Promise<FakeCloudflareApi> {
  const tokens = new Map<string, FakeToken>();
  const issued: string[] = [];
  let outage = false;

  const root = `/accounts/${options.accountId}/access/service_tokens`;

  function issueSecret(): string {
    const secret = `${FAKE_SECRET_MARKER}${hex(24)}`;
    issued.push(secret);
    return secret;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    // --- Control surface, for specs ---------------------------------------
    if (url.pathname === "/__e2e/issued" && method === "GET") {
      send(response, 200, { secrets: issued });
      return;
    }
    if (url.pathname === "/__e2e/outage" && method === "POST") {
      outage = (await readJson(request))["on"] === true;
      send(response, 200, { outage });
      return;
    }

    // --- The Cloudflare API -----------------------------------------------
    if (!url.pathname.startsWith(root)) {
      failure(response, 404, 7003, "Could not route to this path.");
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.apiToken}`) {
      failure(response, 403, 10000, "Authentication error");
      return;
    }
    if (outage) {
      failure(response, 503, 10013, "Service unavailable");
      return;
    }

    const rest = url.pathname.slice(root.length);
    const now = Date.now();

    if (rest === "" && method === "GET") {
      const all = [...tokens.values()].map(publicView);
      ok(response, all, {
        result_info: {
          page: 1,
          per_page: 1000,
          count: all.length,
          total_count: all.length,
          total_pages: 1,
        },
      });
      return;
    }

    if (rest === "" && method === "POST") {
      const body = await readJson(request);
      const name = typeof body["name"] === "string" ? body["name"] : "";
      const duration = typeof body["duration"] === "string" ? body["duration"] : "8760h";
      const token: FakeToken = {
        id: randomUUID(),
        client_id: `${hex(16)}.access`,
        client_secret: issueSecret(),
        name,
        duration,
        expires_at: expiryFor(duration, now),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      };
      tokens.set(token.id, token);
      ok(response, issuedView(token));
      return;
    }

    const match = /^\/([^/]+)(\/rotate|\/refresh)?$/.exec(rest);
    const token = match ? tokens.get(decodeURIComponent(match[1] ?? "")) : undefined;

    if (!match || token === undefined) {
      failure(response, 404, 12130, "Access service token not found.");
      return;
    }

    if (match[2] === "/rotate" && method === "POST") {
      token.client_secret = issueSecret();
      token.updated_at = new Date(now).toISOString();
      ok(response, issuedView(token));
      return;
    }

    if (match[2] === "/refresh" && method === "POST") {
      token.expires_at = expiryFor(token.duration, now);
      token.updated_at = new Date(now).toISOString();
      ok(response, publicView(token));
      return;
    }

    if (match[2] === undefined && method === "GET") {
      ok(response, publicView(token));
      return;
    }

    // A partial update: only the fields the body names change.
    if (match[2] === undefined && method === "PUT") {
      const body = await readJson(request);
      const record = token as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(body)) {
        if (IMMUTABLE.has(field)) continue;
        if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
          record[field] = value;
        }
      }
      if (typeof body["duration"] === "string") {
        token.expires_at = expiryFor(token.duration, now);
      }
      token.updated_at = new Date(now).toISOString();
      ok(response, publicView(token));
      return;
    }

    if (match[2] === undefined && method === "DELETE") {
      tokens.delete(token.id);
      ok(response, { id: token.id });
      return;
    }

    failure(response, 405, 10405, "Method not allowed.");
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      failure(response, 500, 10001, "The fake Cloudflare API failed.");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
