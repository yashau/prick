/**
 * A fake of the Cloudflare Access service-token API, served through the same
 * `outboundService` as the Access origin in `origin.ts`.
 *
 * It runs in NODE, in the Vitest host, so its state crosses to the tests as JSON
 * over the intercepted fetch: `GET /cloudflare-control/<account>` returns what
 * the fake holds and every call it received, and `POST` arms a failure or seeds
 * a token made "in the dashboard". Each test uses its own account id, so state
 * never leaks between tests or files.
 *
 * The shapes follow the Cloudflare API reference. `create` and `rotate` answer
 * with `client_secret`; the create response carries no `expires_at`, as the
 * reference documents it, so the Worker cannot come to rely on one.
 *
 * This module is imported by `origin.ts` and by nothing under `src/`.
 */

/** The API token the fake accepts. Anything else is a 403, as Cloudflare answers. */
export const FAKE_CLOUDFLARE_TOKEN = "test-cloudflare-api-token";

export type FakeOperation = "create" | "list" | "rotate" | "refresh" | "delete";

export interface FakeToken {
  id: string;
  client_id: string;
  client_secret: string;
  name: string;
  duration: string;
  expires_at: string | null;
  created_at: string;
  previous_client_secret_expires_at: string | null;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

interface FakeAccount {
  tokens: Map<string, FakeToken>;
  failures: Map<FakeOperation, { status: number; remaining: number }>;
  calls: FakeCall[];
}

export interface FakeCloudflareState {
  tokens: FakeToken[];
  calls: FakeCall[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(result: unknown, extra: Record<string, unknown> = {}): Response {
  return json({ success: true, errors: [], messages: [], result, ...extra });
}

function failure(status: number, message: string): Response {
  return json(
    { success: false, errors: [{ code: 10_000 + status, message }], messages: [], result: null },
    status,
  );
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function expiry(duration: string, from: number): string | null {
  if (duration === "forever") return null;
  const hours = Number(duration.replace(/h$/, ""));
  return new Date(from + hours * 3_600_000).toISOString();
}

function view(token: FakeToken): Record<string, unknown> {
  return {
    id: token.id,
    client_id: token.client_id,
    name: token.name,
    duration: token.duration,
    enabled: true,
    expires_at: token.expires_at,
    created_at: token.created_at,
    updated_at: token.created_at,
    last_seen_at: null,
  };
}

function mint(name: string, duration: string): FakeToken {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    client_id: `${hex(16)}.access`,
    client_secret: `cfast_${hex(24)}`,
    name,
    duration,
    expires_at: expiry(duration, now),
    created_at: new Date(now).toISOString(),
    previous_client_secret_expires_at: null,
  };
}

export function createFakeCloudflare(): { fetch(request: Request, url: URL): Promise<Response> } {
  const accounts = new Map<string, FakeAccount>();

  const account = (id: string): FakeAccount => {
    let found = accounts.get(id);
    if (found === undefined) {
      found = { tokens: new Map(), failures: new Map(), calls: [] };
      accounts.set(id, found);
    }
    return found;
  };

  const armed = (state: FakeAccount, op: FakeOperation): Response | null => {
    const fault = state.failures.get(op);
    if (fault === undefined || fault.remaining <= 0) return null;
    fault.remaining -= 1;
    return failure(fault.status, `injected ${op} failure`);
  };

  return {
    async fetch(request: Request, url: URL): Promise<Response> {
      const segments = url.pathname.split("/").filter((segment) => segment !== "");

      // Control plane: /cloudflare-control/<account>
      if (segments[0] === "cloudflare-control" && segments[1] !== undefined) {
        const state = account(segments[1]);
        if (request.method === "GET") {
          const snapshot: FakeCloudflareState = {
            tokens: [...state.tokens.values()],
            calls: state.calls,
          };
          return json(snapshot);
        }

        const body = (await request.json()) as {
          fail?: { op: FakeOperation; status: number; times?: number };
          seed?: { name: string };
        };
        if (body.fail !== undefined) {
          state.failures.set(body.fail.op, {
            status: body.fail.status,
            remaining: body.fail.times ?? 1,
          });
          return json({ ok: true });
        }
        if (body.seed !== undefined) {
          const token = mint(body.seed.name, "8760h");
          state.tokens.set(token.id, token);
          return json(token);
        }
        return json({ error: "unknown_control" }, 400);
      }

      // API: /cloudflare/client/v4/accounts/<account>/access/service_tokens[/<id>[/<verb>]]
      const [root, , , accountsSegment, accountId, access, collection, id, verb] = segments;
      if (
        root !== "cloudflare" ||
        accountsSegment !== "accounts" ||
        accountId === undefined ||
        access !== "access" ||
        collection !== "service_tokens"
      ) {
        return failure(404, "no such route in the fake");
      }

      const state = account(accountId);
      const text =
        request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      const body: unknown = text === "" ? undefined : JSON.parse(text);
      state.calls.push({
        method: request.method,
        path: `/${segments.slice(7).join("/")}${url.search}`,
        body,
      });

      if (request.headers.get("Authorization") !== `Bearer ${FAKE_CLOUDFLARE_TOKEN}`) {
        return failure(403, "Authentication error");
      }

      if (id === undefined && request.method === "POST") {
        const injected = armed(state, "create");
        if (injected !== null) return injected;
        const input = body as { name: string; duration?: string };
        const token = mint(input.name, input.duration ?? "8760h");
        state.tokens.set(token.id, token);
        const { expires_at: _omitted, ...rest } = view(token);
        return envelope({ ...rest, client_secret: token.client_secret });
      }

      if (id === undefined && request.method === "GET") {
        const injected = armed(state, "list");
        if (injected !== null) return injected;
        const all = [...state.tokens.values()].map(view);
        return envelope(all, {
          result_info: {
            page: 1,
            per_page: 1000,
            count: all.length,
            total_count: all.length,
            total_pages: 1,
          },
        });
      }

      if (id === undefined) return failure(405, "method not allowed");

      const token = state.tokens.get(id);

      if (verb === "rotate" && request.method === "POST") {
        const injected = armed(state, "rotate");
        if (injected !== null) return injected;
        if (token === undefined) return failure(404, "service token not found");
        token.client_secret = `cfast_${hex(24)}`;
        token.previous_client_secret_expires_at =
          (body as { previous_client_secret_expires_at?: string } | undefined)
            ?.previous_client_secret_expires_at ?? null;
        return envelope({ ...view(token), client_secret: token.client_secret });
      }

      if (verb === "refresh" && request.method === "POST") {
        const injected = armed(state, "refresh");
        if (injected !== null) return injected;
        if (token === undefined) return failure(404, "service token not found");
        token.expires_at = expiry(token.duration, Date.now() + 3_600_000);
        return envelope(view(token));
      }

      if (verb === undefined && request.method === "DELETE") {
        const injected = armed(state, "delete");
        if (injected !== null) return injected;
        if (token === undefined) return failure(404, "service token not found");
        state.tokens.delete(id);
        return envelope(view(token));
      }

      return failure(405, "method not allowed");
    },
  };
}
