import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { readInstanceId } from "../../src/lib/server/core/instance.js";
import { createDatabase } from "../../src/lib/server/db/client.js";
import { createApi } from "../../src/lib/server/http/app.js";
import { countingD1 } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

/**
 * The deployment's instance id, as the transport serves it.
 *
 * The row comes from the migration, not from a fixture: `freshDatabase()`
 * applies the committed migrations and leaves `instance` out of the tables it
 * truncates, so these tests read the very row `0004_instance_row.sql` inserted. That is
 * the point -- a migration that failed to insert it would fail here, not in a
 * user's first `prk login`.
 */

const HEADER = "Prick-Instance";
const ID_PATTERN = /^[0-9a-f]{32}$/;

let api: ApiHarness;

beforeEach(async () => {
  api = await apiHarness();
});

async function storedId(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM instance").first<{ id: string }>();
  if (row === null) throw new Error("the migration did not insert an instance row");
  return row.id;
}

describe("the instance row", () => {
  it("is inserted by the migration, exactly once, as 32 lowercase hex characters", async () => {
    const rows = await env.DB.prepare("SELECT id, created_at FROM instance").all<{
      id: string;
      created_at: number;
    }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.id).toMatch(ID_PATTERN);
    // Epoch MILLISECONDS, like every other timestamp in the schema.
    expect(rows.results[0]?.created_at).toBeGreaterThan(1_700_000_000_000);
  });

  it("is read once per D1 binding and then served without a query", async () => {
    const counting = countingD1();
    const db = createDatabase(counting.binding);

    const first = await readInstanceId(db);
    expect(counting.statements()).toBe(1);

    const second = await readInstanceId(createDatabase(counting.binding));
    expect(second).toBe(first);
    expect(counting.statements()).toBe(1);
  });
});

describe("GET /api/v1/whoami", () => {
  it("carries the instance id, matching the header", async () => {
    const token = await api.ownerToken();
    const whoami = await api.json<{ instance: string | null }>("/api/v1/whoami", { token });

    expect(whoami.status).toBe(200);
    expect(whoami.body.instance).toMatch(ID_PATTERN);
    expect(whoami.body.instance).toBe(await storedId());
    expect(whoami.headers.get(HEADER)).toBe(whoami.body.instance);
  });

  it("answers the same id on every request", async () => {
    const token = await api.ownerToken();
    const first = await api.json<{ instance: string | null }>("/api/v1/whoami", { token });
    const second = await api.json<{ instance: string | null }>("/api/v1/whoami", { token });

    expect(second.body.instance).toBe(first.body.instance);
    expect(second.headers.get(HEADER)).toBe(first.headers.get(HEADER));
  });
});

describe("the Prick-Instance header", () => {
  it("is on every authenticated success", async () => {
    const id = await storedId();
    const token = await api.ownerToken();

    for (const path of ["/api/v1/projects", "/api/v1/identities", "/api/v1/audit"]) {
      const response = await api.fetch(path, { token });

      expect(response.status, path).toBe(200);
      expect(response.headers.get(HEADER), path).toBe(id);
    }
  });

  it("is on an authenticated write", async () => {
    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/projects", {
      method: "POST",
      token,
      ...body({ slug: "acme", name: "Acme" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get(HEADER)).toBe(await storedId());
  });

  it("is on an authenticated error response", async () => {
    const id = await storedId();
    const token = await api.ownerToken();

    // A 404 from `core` (no such project) and a 422 from the validator: both
    // leave the handler by throwing, and both reach the client through
    // `onError`.
    const missing = await api.fetch("/api/v1/projects/nope", { token });
    expect(missing.status).toBe(404);
    expect(missing.headers.get(HEADER)).toBe(id);

    const invalid = await api.fetch("/api/v1/projects", {
      method: "POST",
      token,
      ...body({ slug: "Not A Slug" }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get(HEADER)).toBe(id);
  });

  it("is on a denial", async () => {
    await api.grant({ subject: "reader@example.com", role: "reader", scopeType: "global" });
    const token = await api.userToken("reader@example.com");

    const response = await api.fetch("/api/v1/projects", {
      method: "POST",
      token,
      ...body({ slug: "acme", name: "Acme" }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get(HEADER)).toBe(await storedId());
  });

  it("is absent from a 401", async () => {
    const response = await api.fetch("/api/v1/whoami", { token: null });

    expect(response.status).toBe(401);
    expect(response.headers.has(HEADER)).toBe(false);
  });

  it("is absent from every unauthenticated route", async () => {
    for (const path of ["/api/v1/health", "/api/v1/openapi.json", "/api/v1/docs"]) {
      const response = await api.fetch(path, { token: null });

      expect(response.status, path).toBe(200);
      expect(response.headers.has(HEADER), path).toBe(false);
    }
  });

  it("is absent from /health even with a valid credential", async () => {
    const response = await api.fetch("/api/v1/health", { token: await api.ownerToken() });

    expect(response.status).toBe(200);
    expect(response.headers.has(HEADER)).toBe(false);
    await expect(response.json()).resolves.toEqual({
      service: "prick",
      status: "ok",
      version: expect.any(String) as string,
    });
  });
});

describe("a database with no instance row", () => {
  it("omits the header and reports a null instance, and writes no row", async () => {
    const id = await storedId();

    /*
     * A FRESH binding object, so the per-binding cache holds nothing for it and
     * the request reads the (now empty) table. `env.DB` itself stays cached with
     * the real id for every other test in this file.
     */
    const counting = countingD1(env.DB);
    const app = createApi();
    const token = await api.ownerToken();

    await env.DB.prepare("DELETE FROM instance").run();

    try {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("https://prick.test/api/v1/whoami", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        api.bindings({ DB: counting.binding }),
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.has(HEADER)).toBe(false);
      await expect(response.json()).resolves.toMatchObject({ instance: null });

      // Reporting `null` is the whole of it: the application never mints a row.
      const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM instance").first<{
        n: number;
      }>();
      expect(after?.n).toBe(0);
    } finally {
      await env.DB.prepare("INSERT INTO instance (id, created_at) VALUES (?, ?)")
        .bind(id, Date.now())
        .run();
    }
  });
});
