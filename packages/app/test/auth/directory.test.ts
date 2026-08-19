import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAccessDisplayName,
  syncAccessDisplayName,
} from "../../src/lib/server/auth/directory.js";
import type { Database } from "../../src/lib/server/db/client.js";
import { identities } from "../../src/lib/server/db/schema.js";
import {
  NOW,
  freshDatabase,
  requestContext,
  seedIdentity,
  serviceActor,
  userActor,
} from "./fixtures.js";

/**
 * THE NAME LOOKUP.
 *
 * Two properties matter more than the happy path, and both are about damage a
 * cosmetic field must not be able to do:
 *
 *   It cannot fail a request. Every error shape resolves to `null`.
 *   It cannot be asked twice for the same nothing. `display_name_synced_at`
 *   exists so an identity Access has no name for stops costing a subrequest.
 */

const SUBJECT = "jdoe@corp.example.com";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

/** A browser request: it carries the cookie `get-identity` authenticates with. */
function browserRequest(cookie = "CF_Authorization=token"): Request {
  return new Request("https://prick.example.com/", { headers: { cookie } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchAccessDisplayName", () => {
  it("asks the team domain, forwards ONLY the cookie, and returns the name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ name: "John Doe" }));

    const name = await fetchAccessDisplayName({
      team: "acme",
      request: new Request("https://prick.example.com/", {
        headers: { cookie: "CF_Authorization=token", authorization: "Bearer secret" },
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(name).toBe("John Doe");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://acme.cloudflareaccess.com/cdn-cgi/access/get-identity");

    // The inbound `authorization` header is this application's business, not
    // Access's. Piping the whole request through would have handed it over.
    const headers = init.headers as Record<string, string>;
    expect(headers["cookie"]).toBe("CF_Authorization=token");
    expect(headers).not.toHaveProperty("authorization");
  });

  it("does not call out at all without a cookie", async () => {
    const fetchImpl = vi.fn();

    const name = await fetchAccessDisplayName({
      team: "acme",
      request: new Request("https://prick.example.com/"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(name).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null for every failure rather than throwing", async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.resolve(jsonResponse({ name: "x" }, 403)),
      () => Promise.resolve(jsonResponse({ name: "x" }, 500)),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.reject(new Error("network is down")),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ];

    for (const impl of failures) {
      await expect(
        fetchAccessDisplayName({
          team: "acme",
          request: browserRequest(),
          fetchImpl: impl as unknown as typeof fetch,
        }),
      ).resolves.toBeNull();
    }
  });

  it("treats a missing, blank or non-string name as no name", async () => {
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 42 }, { name: null }, []]) {
      await expect(
        fetchAccessDisplayName({
          team: "acme",
          request: browserRequest(),
          fetchImpl: (() => Promise.resolve(jsonResponse(body))) as unknown as typeof fetch,
        }),
      ).resolves.toBeNull();
    }
  });

  it("bounds a hostile name rather than storing whatever arrives", async () => {
    const name = await fetchAccessDisplayName({
      team: "acme",
      request: browserRequest(),
      fetchImpl: (() =>
        Promise.resolve(jsonResponse({ name: "a".repeat(5000) }))) as unknown as typeof fetch,
    });

    expect(name).not.toBeNull();
    expect((name ?? "").length).toBeLessThanOrEqual(128);
  });
});

describe("syncAccessDisplayName", () => {
  async function rowFor(subject: string) {
    const rows = await db.select().from(identities).where(eq(identities.subject, subject));
    return rows[0];
  }

  it("stores the name and stamps the attempt", async () => {
    await seedIdentity(db, { kind: "user", subject: SUBJECT });
    const ctx = requestContext(db, userActor(SUBJECT));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ name: "John Doe" }));

    await syncAccessDisplayName(ctx, browserRequest());

    const row = await rowFor(SUBJECT);
    expect(row?.displayName).toBe("John Doe");
    expect(row?.displayNameSyncedAt).toBe(NOW);

    vi.restoreAllMocks();
  });

  it("stamps the attempt even when Access has no name, so it is not asked again", async () => {
    // THE POINT OF THE COLUMN. Without the stamp, `display_name IS NULL` is
    // indistinguishable from "never looked", and this identity would send a
    // subrequest on every authenticated request for the rest of its life.
    await seedIdentity(db, { kind: "user", subject: SUBJECT });

    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ email: SUBJECT }));

    await syncAccessDisplayName(requestContext(db, userActor(SUBJECT)), browserRequest());

    const row = await rowFor(SUBJECT);
    expect(row?.displayName).toBeNull();
    expect(row?.displayNameSyncedAt).toBe(NOW);

    // A second request inside the interval does not ask again.
    await syncAccessDisplayName(
      requestContext(db, userActor(SUBJECT), { now: NOW + 60_000 }),
      browserRequest(),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("asks again once the interval has passed", async () => {
    await seedIdentity(db, { kind: "user", subject: SUBJECT });

    const fetchImpl = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));

    await syncAccessDisplayName(requestContext(db, userActor(SUBJECT)), browserRequest());
    await syncAccessDisplayName(
      requestContext(db, userActor(SUBJECT), { now: NOW + 8 * 24 * 3_600_000 }),
      browserRequest(),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("NEVER overwrites a name an administrator set", async () => {
    const id = await seedIdentity(db, { kind: "user", subject: SUBJECT });
    await db.update(identities).set({ displayName: "Deploy bot" }).where(eq(identities.id, id));

    const fetchImpl = vi.spyOn(globalThis, "fetch");

    await syncAccessDisplayName(requestContext(db, userActor(SUBJECT)), browserRequest());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await rowFor(SUBJECT))?.displayName).toBe("Deploy bot");
    vi.restoreAllMocks();
  });

  it("does not look up a service token, whose subject IS its label", async () => {
    const subject = "e367826f93b8d71185e03fe518aff3b4.access";
    await seedIdentity(db, { kind: "service", subject });

    const fetchImpl = vi.spyOn(globalThis, "fetch");

    await syncAccessDisplayName(requestContext(db, serviceActor(subject)), browserRequest());

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does nothing for a subject with no identity row", async () => {
    const fetchImpl = vi.spyOn(globalThis, "fetch");

    await expect(
      syncAccessDisplayName(requestContext(db, userActor("nobody@example.com")), browserRequest()),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
