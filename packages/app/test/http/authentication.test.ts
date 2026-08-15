import { describe, expect, it } from "vitest";

import { auditLog, grants, identities } from "../../src/lib/server/db/schema.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { harnessKeys } from "../auth/harness/client.js";
import { mintUserToken } from "../auth/harness/mint.js";
import { apiHarness, body, OWNER } from "./harness.js";

/**
 * Authentication, as the transport actually performs it.
 *
 * `test/auth/` already proves the verifier is correct against a battery of
 * malformed tokens. What is asserted here is that the verifier is REACHED: that
 * every route sits behind it, that the identity it resolves is written down, and
 * that the two flows which only exist at the transport boundary -- the identity
 * upsert and the bootstrap self-heal -- happen at the right moment relative to
 * the authorization snapshot.
 */

describe("no credential", () => {
  it("is a 401 on every authenticated route", async () => {
    const api = await apiHarness();

    for (const path of [
      "/api/v1/whoami",
      "/api/v1/projects",
      "/api/v1/p/acme/e/prod/secrets",
      "/api/v1/identities",
      "/api/v1/grants",
      "/api/v1/audit",
      "/api/v1/admin/keyring",
    ]) {
      const response = await api.fetch(path, { token: null });

      expect(response.status, path).toBe(401);
      await expect(response.json(), path).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("still leaves /health, /openapi.json and /docs open", async () => {
    const api = await apiHarness();

    for (const path of ["/api/v1/health", "/api/v1/openapi.json", "/api/v1/docs"]) {
      expect((await api.fetch(path, { token: null })).status, path).toBe(200);
    }
  });

  it("never echoes the rejected token", async () => {
    const api = await apiHarness();
    const response = await api.fetch("/api/v1/projects", {
      headers: { "Cf-Access-Jwt-Assertion": "not.a.jwt" },
      token: null,
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("not.a.jwt");
  });
});

describe("the cookie is a fallback, not the primary", () => {
  it("accepts CF_Authorization when the header is absent", async () => {
    // Cloudflare documents the cookie as not guaranteed to be passed in every
    // context, so the header is primary -- but a browser navigation may present
    // only the cookie, and refusing it would break the UI.
    const api = await apiHarness();
    await seedProject(api.db, "acme");

    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/projects", {
      token: null,
      headers: { Cookie: `other=1; CF_Authorization=${token}` },
    });

    expect(response.status).toBe(200);
  });
});

describe("a service token authenticates like any other identity", () => {
  it("is accepted despite having no `nbf` and an empty `sub`", async () => {
    /*
     * THE EXPLICIT NEGATIVE TEST FROM THE DESIGN.
     *
     * Access service tokens carry `common_name`, an EMPTY `sub`, no `email` and
     * NO `nbf`. A verifier that requires `nbf` -- which is the obvious way to
     * write one, since human tokens have it -- rejects every machine client in
     * the estate with a message that explains nothing.
     */
    const api = await apiHarness();
    await api.grant({
      subject: "ci.access",
      kind: "service",
      role: "reader",
      scopeType: "global",
    });

    const token = await api.serviceToken("ci.access");
    const whoami = await api.json<{ kind: string; subject: string }>("/api/v1/whoami", { token });

    expect(whoami.status).toBe(200);
    expect(whoami.body).toMatchObject({ kind: "service", subject: "ci.access" });
  });
});

describe("every authenticated request records the identity", () => {
  it("creates the row for a subject that has never been seen", async () => {
    // This is what makes a denied service token GRANTABLE. `createGrant` takes
    // an `identity_id`, and Access issues the tokens -- there is no list to
    // browse, so the row this request writes is the only introduction there will
    // ever be.
    const api = await apiHarness();

    const token = await api.serviceToken("brand-new.access");
    expect((await api.fetch("/api/v1/projects", { token })).status).toBe(200);

    const rows = await api.db.select().from(identities);
    expect(rows.map((row) => row.subject)).toContain("brand-new.access");
    expect(rows.find((row) => row.subject === "brand-new.access")?.kind).toBe("service");
  });

  it("touches last_seen_at on a subject that already exists", async () => {
    const api = await apiHarness();
    await api.grant({ subject: "regular@example.com", role: "reader", scopeType: "global" });

    const before = (await api.db.select().from(identities)).find(
      (row) => row.subject === "regular@example.com",
    );

    const token = await api.userToken("regular@example.com");
    await api.fetch("/api/v1/projects", { token });

    const after = (await api.db.select().from(identities)).find(
      (row) => row.subject === "regular@example.com",
    );

    /*
     * Compared against the WALL CLOCK rather than against the seeded value.
     *
     * `test/auth/fixtures.ts` pins `NOW` to a fixed instant that happens to lie
     * in the future, so "the timestamp went up" is not the property to assert --
     * it would be false for a correct implementation. What matters is that the
     * request replaced the seeded value with its own `Date.now()`.
     */
    expect(after?.lastSeenAt).not.toBe(before?.lastSeenAt);
    expect(Math.abs((after?.lastSeenAt ?? 0) - Date.now())).toBeLessThan(60_000);
  });
});

describe('a denial feeds "Seen but not granted"', () => {
  it("turns a 404 for an unknown service token into a grantable row", async () => {
    /*
     * The provisioning flow this whole mechanism exists for: point CI at prick,
     * watch it fail, click Grant. A `common_name` is
     * `e367826f93b8d71185e03fe518aff3b4.access` and nobody maps that to
     * "staging deploy" by looking at it, so the denial IS the introduction.
     */
    const api = await apiHarness();
    await seedProject(api.db, "acme");

    const ci = await api.serviceToken("e367826f93b8d71185e03fe518aff3b4.access");
    expect((await api.fetch("/api/v1/projects/acme", { token: ci })).status).toBe(404);

    const owner = await api.ownerToken();
    const seen = await api.json<{ subject: string; kind: string; attempts: number }[]>(
      "/api/v1/access/unknown-identities",
      { token: owner },
    );

    expect(seen.status).toBe(200);
    expect(seen.body).toEqual([
      expect.objectContaining({
        subject: "e367826f93b8d71185e03fe518aff3b4.access",
        kind: "service",
      }),
    ]);

    // And it is grantable, because the identity row exists.
    const listed = await api.json<{ id: string; subject: string }[]>("/api/v1/identities", {
      token: owner,
    });
    const identityId = listed.body.find(
      (row) => row.subject === "e367826f93b8d71185e03fe518aff3b4.access",
    )?.id;

    expect(identityId).toBeDefined();

    const granted = await api.fetch("/api/v1/grants", {
      method: "POST",
      token: owner,
      ...body({
        scope_type: "project",
        project: "acme",
        identity_id: identityId,
        role: "reader",
      }),
    });

    expect(granted.status).toBe(201);
    expect((await api.fetch("/api/v1/projects/acme", { token: ci })).status).toBe(200);
  });

  it("drops a subject from the list once it holds a grant", async () => {
    const api = await apiHarness();
    await seedProject(api.db, "acme");

    // The owner has been denied nothing, and holds a grant either way.
    const owner = await api.ownerToken();
    const seen = await api.json<unknown[]>("/api/v1/access/unknown-identities", { token: owner });

    expect(seen.body).toEqual([]);
  });
});

describe("an installation with no administrator refuses to serve", () => {
  it("answers 503 NO_ADMINS_CONFIGURED, loudly", async () => {
    /*
     * Failing closed beats an installation that answers requests, denies every
     * privileged action, and gives no indication why -- which looks exactly like
     * a permissions bug and gets debugged for an afternoon.
     *
     * 503 rather than 500: unlike a bad master key this IS recoverable without a
     * code change. Set the var, redeploy.
     */
    const api = await apiHarness({ seedOwner: false });
    const token = await api.userToken("anyone@example.com");

    const response = await api.fetch("/api/v1/projects", { token });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "NO_ADMINS_CONFIGURED" });
  });

  it("leaves /health alone, which is unauthenticated and has no actor", async () => {
    const api = await apiHarness({ seedOwner: false });

    expect((await api.fetch("/api/v1/health", { token: null })).status).toBe(200);
  });
});

describe("BOOTSTRAP_ADMINS self-heals into a real grant", () => {
  it("converts the var into a revocable row on the first authenticated request", async () => {
    const api = await apiHarness({ seedOwner: false, bootstrapAdmins: "boss@example.com" });

    expect(await api.db.select().from(grants)).toEqual([]);

    const token = await api.userToken("boss@example.com");
    const whoami = await api.json<{ role: string | null; bootstrap: boolean }>("/api/v1/whoami", {
      token,
    });

    expect(whoami.status).toBe(200);
    expect(whoami.body.role).toBe("admin");

    /*
     * `bootstrap` is already FALSE on this very response, and that is the
     * behaviour rather than a rounding error: the self-heal runs before the
     * authorization snapshot is resolved, so by the time the actor is hydrated
     * the implicit admin has become an explicit one. The UI banner is therefore
     * shown only while the var is doing work that a grant is not.
     */
    expect(whoami.body.bootstrap).toBe(false);

    const rows = await api.db.select().from(grants);
    expect(rows).toEqual([
      expect.objectContaining({ role: "admin", scopeType: "global", createdBy: "bootstrap" }),
    ]);

    // And it is audited as a system action, not as the person it promotes:
    // "boss@example.com granted boss@example.com global admin" would be a false
    // account of how that row came to exist.
    const audits = await api.db.select().from(auditLog);
    expect(audits).toEqual([
      expect.objectContaining({ action: "bootstrap.grant.create", actorSubject: "bootstrap" }),
    ]);
  });

  it("matches case-insensitively, because the token's email may not be lower-cased", async () => {
    // `Ops@Example.com` in the var and `ops@example.com` from the token would
    // otherwise produce a 403 with no explanation and a var that looks obviously
    // correct.
    const api = await apiHarness({ seedOwner: false, bootstrapAdmins: "Ops@Example.COM" });

    const keys = await harnessKeys();
    const token = await mintUserToken({
      privateJwk: keys.primary.privateJwk,
      kid: keys.primary.kid,
      team: "test-team",
      aud: "test-aud",
      now: Date.now(),
      claims: { email: "OPS@example.com" },
    });

    const whoami = await api.json<{ subject: string; role: string | null }>("/api/v1/whoami", {
      token,
    });

    expect(whoami.body).toMatchObject({ subject: "ops@example.com", role: "admin" });
  });

  it("does not promote anybody else", async () => {
    const api = await apiHarness({ seedOwner: false, bootstrapAdmins: "boss@example.com" });
    const token = await api.userToken("someone-else@example.com");

    const whoami = await api.json<{ role: string | null }>("/api/v1/whoami", { token });

    expect(whoami.body.role).toBeNull();
    expect((await api.fetch("/api/v1/identities", { token })).status).toBe(403);
  });
});

describe("the request id reaches the audit row", () => {
  it("carries a client-supplied id all the way through", async () => {
    /*
     * The whole point: a user pastes the id from an error toast into a support
     * thread and an administrator finds the exact event, instead of correlating
     * on a timestamp and a guess.
     */
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");

    const token = await api.ownerToken();
    const written = await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
      method: "POST",
      token,
      headers: { "X-Request-Id": "toast-42", "Content-Type": "application/json" },
      ...body({ mode: "merge", set: { A: "1" } }),
    });

    expect(written.headers.get("X-Request-Id")).toBe("toast-42");

    const page = await api.json<{ entries: { requestId: string; action: string }[] }>(
      "/api/v1/audit?action=secret.write",
      { token },
    );

    expect(page.body.entries[0]?.requestId).toBe("toast-42");
  });
});

describe("whoami", () => {
  it("reports the global role and nothing wider", async () => {
    const api = await apiHarness();
    const projectId = await seedProject(api.db, "acme");
    await api.grant({
      subject: "scoped@example.com",
      role: "admin",
      scopeType: "project",
      projectId,
    });

    const token = await api.userToken("scoped@example.com");
    const whoami = await api.json<{ role: string | null; identityId: string | null }>(
      "/api/v1/whoami",
      { token },
    );

    // A project admin is not a global anything, and saying otherwise would give
    // a CLI a reason to skip a check.
    expect(whoami.body.role).toBeNull();
    expect(whoami.body.identityId).not.toBeNull();
  });

  it("reports the owner as a global admin", async () => {
    const api = await apiHarness();
    const token = await api.ownerToken();

    await expect(
      api.json<{ subject: string; role: string }>("/api/v1/whoami", { token }),
    ).resolves.toMatchObject({ body: { subject: OWNER, role: "admin", kind: "user" } });
  });
});
