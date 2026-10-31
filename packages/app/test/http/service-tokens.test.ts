import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { seedEnvironment, seedGrant, seedIdentity, seedProject } from "../auth/fixtures.js";
import {
  FAKE_CLOUDFLARE_TOKEN,
  type FakeCloudflareState,
  type FakeOperation,
  type FakeToken,
} from "../auth/harness/cloudflare.js";
import { HARNESS_ORIGIN } from "../auth/harness/protocol.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

/**
 * Service tokens through the transport, against a fake Cloudflare API.
 *
 * The fake (`test/auth/harness/cloudflare.ts`) runs behind the same intercepted
 * fetch as the Access origin, so the Worker's real HTTP client, its response
 * parsing and its error mapping all run unmodified. Each test gets its own
 * Cloudflare account id, which is the fake's unit of isolation.
 */

const BASE = `${HARNESS_ORIGIN}/cloudflare/client/v4`;

function newAccount(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function configured(account: string, token = FAKE_CLOUDFLARE_TOKEN): Record<string, string> {
  return { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, CF_API_BASE_URL: BASE };
}

async function cloudflare(account: string): Promise<FakeCloudflareState> {
  const response = await fetch(`${HARNESS_ORIGIN}/cloudflare-control/${account}`);
  return (await response.json()) as FakeCloudflareState;
}

async function failNext(account: string, op: FakeOperation, status: number): Promise<void> {
  await fetch(`${HARNESS_ORIGIN}/cloudflare-control/${account}`, {
    method: "POST",
    body: JSON.stringify({ fail: { op, status } }),
  });
}

async function seedCloudflareToken(account: string, name: string): Promise<FakeToken> {
  const response = await fetch(`${HARNESS_ORIGIN}/cloudflare-control/${account}`, {
    method: "POST",
    body: JSON.stringify({ seed: { name } }),
  });
  return (await response.json()) as FakeToken;
}

/** Delete a token "in the dashboard", behind prick's back. */
async function deleteInDashboard(account: string, id: string): Promise<void> {
  await fetch(`${BASE}/accounts/${account}/access/service_tokens/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${FAKE_CLOUDFLARE_TOKEN}` },
  });
}

async function instanceId(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM instance").first<{ id: string }>();
  if (row === null) throw new Error("no instance row");
  return row.id;
}

async function auditText(): Promise<string> {
  const rows = await env.DB.prepare("SELECT action, detail FROM audit_log").all();
  return JSON.stringify(rows.results);
}

interface Issued {
  token: {
    id: string;
    identityId: string;
    clientId: string;
    cloudflareId: string;
    cloudflareName: string;
  };
  grant: { id: string; scopeType: string; projectSlug: string | null } | null;
  clientId: string;
  clientSecret: string;
}

let account: string;
let api: ApiHarness;
let owner: string;

beforeEach(async () => {
  account = newAccount();
  api = await apiHarness({ bindings: configured(account) });
  owner = await api.ownerToken();
});

async function create(input: Record<string, unknown> = { name: "staging deploy" }) {
  return api.json<Issued>("/api/v1/service-tokens", {
    method: "POST",
    token: owner,
    ...body(input),
  });
}

describe("GET /capabilities", () => {
  it("tells a global admin the feature is enabled, with the deployment's limits and instance", async () => {
    const {
      status,
      body: caps,
      headers,
    } = await api.json<{
      api: number;
      instance: string;
      limits: { envMaxSecrets: number };
      features: { serviceTokens: Record<string, unknown> };
    }>("/api/v1/capabilities", { token: owner });

    expect(status).toBe(200);
    expect(caps.api).toBe(1);
    expect(caps.instance).toBe(headers.get("Prick-Instance"));
    expect(caps.limits.envMaxSecrets).toBe(500);
    expect(caps.features.serviceTokens).toEqual({
      state: "enabled",
      allowed: true,
      reason: null,
      hint: null,
    });
  });

  it("tells a global admin why it is unavailable, naming what to set", async () => {
    const bare = await apiHarness();
    const { body: caps } = await bare.json<{
      features: { serviceTokens: Record<string, unknown> };
    }>("/api/v1/capabilities", { token: await bare.ownerToken() });

    expect(caps.features.serviceTokens).toMatchObject({
      state: "unavailable",
      allowed: false,
      reason: "unconfigured",
    });
    expect(caps.features.serviceTokens["hint"]).toContain("CF_API_TOKEN");
  });

  it("tells anyone else only that they cannot use it, whatever the configuration", async () => {
    await api.grant({ subject: "reader@example.com", role: "reader", scopeType: "global" });

    const { body: caps } = await api.json<{ features: { serviceTokens: Record<string, unknown> } }>(
      "/api/v1/capabilities",
      { token: await api.userToken("reader@example.com") },
    );

    expect(caps.features.serviceTokens).toEqual({
      state: "unavailable",
      allowed: false,
      reason: null,
      hint: null,
    });
  });

  it("requires authentication", async () => {
    const response = await api.fetch("/api/v1/capabilities", { token: null });
    expect(response.status).toBe(401);
  });
});

describe("who may manage service tokens", () => {
  it("refuses everyone below global admin, and audits the refusal", async () => {
    const projectId = await seedProject(api.db, "api");
    await api.grant({
      subject: "padmin@example.com",
      role: "admin",
      scopeType: "project",
      projectId,
    });
    await api.grant({ subject: "writer@example.com", role: "writer", scopeType: "global" });

    for (const subject of ["padmin@example.com", "writer@example.com"]) {
      const token = await api.userToken(subject);
      const list = await api.fetch("/api/v1/service-tokens", { token });
      const made = await api.fetch("/api/v1/service-tokens", {
        method: "POST",
        token,
        ...body({ name: "nope" }),
      });

      expect(list.status).toBe(403);
      expect(made.status).toBe(403);
    }

    expect((await cloudflare(account)).calls).toEqual([]);
    expect(await auditText()).toContain("access.denied");
  });

  it("answers a non-admin with the ordinary refusal even when the feature is unconfigured", async () => {
    const bare = await apiHarness();
    await bare.grant({ subject: "writer@example.com", role: "writer", scopeType: "global" });

    const response = await bare.json<{ code: string }>("/api/v1/service-tokens", {
      token: await bare.userToken("writer@example.com"),
    });

    expect(response.status).toBe(403);
  });

  it("answers a global admin with 503 and a hint when the Worker has no CF_API_TOKEN", async () => {
    const bare = await apiHarness();
    const response = await bare.json<{ code: string; hint: string }>("/api/v1/service-tokens", {
      method: "POST",
      token: await bare.ownerToken(),
      ...body({ name: "x" }),
    });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_TOKENS_UNCONFIGURED");
    expect(response.body.hint).toContain("CF_API_TOKEN");
  });

  it("names the missing half when only the token is set", async () => {
    const half = await apiHarness({ bindings: { CF_API_TOKEN: FAKE_CLOUDFLARE_TOKEN } });
    const response = await half.json<{ code: string; hint: string }>("/api/v1/service-tokens", {
      token: await half.ownerToken(),
    });

    expect(response.status).toBe(503);
    expect(response.body.hint).toContain("CF_ACCOUNT_ID");
  });

  it("names the permission when Cloudflare refuses the API token", async () => {
    const wrong = await apiHarness({ bindings: configured(account, "not-the-token") });
    const response = await wrong.json<{ code: string; hint: string }>("/api/v1/service-tokens", {
      method: "POST",
      token: await wrong.ownerToken(),
      ...body({ name: "x" }),
    });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("SERVICE_TOKENS_UNCONFIGURED");
    expect(response.body.hint).toContain("Access: Service Tokens");
  });
});

describe("POST /service-tokens", () => {
  it("creates the token, its identity and its grant, and returns the secret once with no-store", async () => {
    const projectId = await seedProject(api.db, "api");
    await seedEnvironment(api.db, projectId, "production");

    const response = await api.fetch("/api/v1/service-tokens", {
      method: "POST",
      token: owner,
      ...body({
        name: "staging deploy",
        duration: "720h",
        grant: {
          scope_type: "environment",
          project: "api",
          environment: "production",
          role: "reader",
        },
      }),
    });
    const issued = (await response.json()) as Issued;

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toContain("no-store");

    const fake = await cloudflare(account);
    expect(fake.tokens).toHaveLength(1);
    expect(issued.clientId).toBe(fake.tokens[0]?.client_id);
    expect(issued.clientSecret).toBe(fake.tokens[0]?.client_secret);
    expect(issued.token.cloudflareName).toBe(`prick:${await instanceId()}:${issued.token.id}`);
    expect(fake.calls[0]?.body).toEqual({ name: issued.token.cloudflareName, duration: "720h" });
    expect(issued.grant).toMatchObject({ scopeType: "environment", projectSlug: "api" });

    const identity = await env.DB.prepare(
      "SELECT kind, subject, display_name FROM identities WHERE id = ?",
    )
      .bind(issued.token.identityId)
      .first();
    expect(identity).toEqual({
      kind: "service",
      subject: issued.clientId,
      display_name: "staging deploy",
    });

    const audit = await auditText();
    expect(audit).toContain("service_token.create");
    expect(audit).toContain("grant.create");
    expect(audit).not.toContain(issued.clientSecret);
  });

  it("is authorized on its very first request, with no refusal to introduce it", async () => {
    const projectId = await seedProject(api.db, "api");
    await seedEnvironment(api.db, projectId, "production");

    const { body: issued } = await create({
      name: "ci",
      grant: { scope_type: "project", project: "api", role: "reader" },
    });

    const machine = await api.serviceToken(issued.clientId);
    const projects = await api.json<{ slug: string }[]>("/api/v1/projects", { token: machine });

    expect(projects.status).toBe(200);
    expect(projects.body.map((project) => project.slug)).toEqual(["api"]);
    expect(await auditText()).not.toContain("access.denied");
  });

  it("creates an ungranted token when no grant is given", async () => {
    const { status, body: issued } = await create();
    expect(status).toBe(201);
    expect(issued.grant).toBeNull();
  });

  it("refuses an unknown project before asking Cloudflare for anything", async () => {
    const { status } = await create({
      name: "ci",
      grant: { scope_type: "project", project: "nope", role: "reader" },
    });

    expect(status).toBe(404);
    expect((await cloudflare(account)).calls).toEqual([]);
  });

  it("rejects a duration that is not whole hours or forever", async () => {
    const { status } = await create({ name: "ci", duration: "90m" });
    expect(status).toBe(422);
  });

  it("reports a Cloudflare outage as UPSTREAM_FAILED and records nothing", async () => {
    await failNext(account, "create", 500);
    const { status, body: error } = await api.json<{ code: string }>("/api/v1/service-tokens", {
      method: "POST",
      token: owner,
      ...body({ name: "ci" }),
    });

    expect(status).toBe(502);
    expect(error.code).toBe("UPSTREAM_FAILED");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM service_tokens").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });
});

describe("GET /service-tokens", () => {
  it("lists managed tokens with Cloudflare's live view", async () => {
    const { body: issued } = await create();
    const { status, body: list } = await api.json<{
      cloudflare: string;
      tokens: {
        id: string;
        status: string;
        name: string;
        cloudflare: { expiresAt: number } | null;
      }[];
    }>("/api/v1/service-tokens", { token: owner });

    expect(status).toBe(200);
    expect(list.cloudflare).toBe("ok");
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]).toMatchObject({
      id: issued.token.id,
      status: "active",
      name: "staging deploy",
    });
    expect(list.tokens[0]?.cloudflare?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("still lists the records when Cloudflare cannot be asked, and says so", async () => {
    await create();
    await failNext(account, "list", 503);

    const { body: list } = await api.json<{
      cloudflare: string;
      tokens: { status: string; cloudflare: unknown }[];
    }>("/api/v1/service-tokens", { token: owner });

    expect(list.cloudflare).toBe("unavailable");
    expect(list.tokens[0]).toMatchObject({ status: "active", cloudflare: null });
  });

  it("marks a token deleted in the dashboard as missing", async () => {
    const { body: issued } = await create();
    await deleteInDashboard(account, issued.token.cloudflareId);

    const { body: list } = await api.json<{ tokens: { status: string }[] }>(
      "/api/v1/service-tokens",
      {
        token: owner,
      },
    );
    expect(list.tokens[0]?.status).toBe("missing");
  });
});

describe("POST /service-tokens/{id}/rotate", () => {
  it("issues a new secret for the same client id and identity, cutting the old one immediately by default", async () => {
    const { body: issued } = await create();

    const response = await api.fetch(`/api/v1/service-tokens/${issued.token.id}/rotate`, {
      method: "POST",
      token: owner,
      ...body({}),
    });
    const rotated = (await response.json()) as {
      clientId: string;
      clientSecret: string;
      previousSecretExpiresAt: number | null;
      token: { identityId: string; rotatedAt: number };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(rotated.clientId).toBe(issued.clientId);
    expect(rotated.token.identityId).toBe(issued.token.identityId);
    expect(rotated.clientSecret).not.toBe(issued.clientSecret);
    expect(rotated.previousSecretExpiresAt).toBeNull();

    const fake = await cloudflare(account);
    expect(fake.tokens[0]?.client_secret).toBe(rotated.clientSecret);
    expect(fake.calls.at(-1)?.body).toEqual({});
    expect(await auditText()).not.toContain(rotated.clientSecret);
  });

  it("keeps the previous secret for the grace period it is asked for", async () => {
    const { body: issued } = await create();
    const before = Date.now();

    const { body: rotated } = await api.json<{ previousSecretExpiresAt: number }>(
      `/api/v1/service-tokens/${issued.token.id}/rotate`,
      { method: "POST", token: owner, ...body({ grace_seconds: 3600 }) },
    );

    expect(rotated.previousSecretExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    const sent = (await cloudflare(account)).calls.at(-1)?.body as {
      previous_client_secret_expires_at: string;
    };
    expect(Date.parse(sent.previous_client_secret_expires_at)).toBe(
      rotated.previousSecretExpiresAt,
    );
  });

  it("answers 404 for a token it does not manage", async () => {
    const { status } = await api.json(`/api/v1/service-tokens/${crypto.randomUUID()}/rotate`, {
      method: "POST",
      token: owner,
      ...body({}),
    });
    expect(status).toBe(404);
  });
});

describe("POST /service-tokens/{id}/refresh", () => {
  it("extends the expiry and records it", async () => {
    const { body: issued } = await create();
    const { status, body: refreshed } = await api.json<{ cloudflare: { expiresAt: number } }>(
      `/api/v1/service-tokens/${issued.token.id}/refresh`,
      { method: "POST", token: owner },
    );

    expect(status).toBe(200);
    expect(refreshed.cloudflare.expiresAt).toBeGreaterThan(Date.now());
    expect(await auditText()).toContain("service_token.refresh");
  });
});

describe("DELETE /service-tokens/{id}", () => {
  it("disables the identity, retires the record and deletes the token in Cloudflare", async () => {
    const projectId = await seedProject(api.db, "api");
    const { body: issued } = await create({
      name: "ci",
      grant: { scope_type: "project", project: "api", role: "reader" },
    });
    expect(projectId).toBeTruthy();

    const response = await api.fetch(`/api/v1/service-tokens/${issued.token.id}`, {
      method: "DELETE",
      token: owner,
    });
    expect(response.status).toBe(204);

    expect((await cloudflare(account)).tokens).toEqual([]);
    const identity = await env.DB.prepare("SELECT disabled FROM identities WHERE id = ?")
      .bind(issued.token.identityId)
      .first<{ disabled: number }>();
    expect(identity?.disabled).toBe(1);

    const machine = await api.serviceToken(issued.clientId);
    const projects = await api.json<unknown[]>("/api/v1/projects", { token: machine });
    expect(projects.body).toEqual([]);

    const again = await api.fetch(`/api/v1/service-tokens/${issued.token.id}`, {
      method: "DELETE",
      token: owner,
    });
    expect(again.status).toBe(404);
  });

  it("is in force before the Cloudflare delete, and reconcile finishes a delete that failed", async () => {
    const { body: issued } = await create();
    await failNext(account, "delete", 500);

    const failed = await api.json<{ code: string; hint: string }>(
      `/api/v1/service-tokens/${issued.token.id}`,
      {
        method: "DELETE",
        token: owner,
      },
    );
    expect(failed.status).toBe(502);
    expect(failed.body.hint).toContain("reconcile");

    const identity = await env.DB.prepare("SELECT disabled FROM identities WHERE id = ?")
      .bind(issued.token.identityId)
      .first<{ disabled: number }>();
    expect(identity?.disabled).toBe(1);

    const report = await api.json<{ entries: { kind: string; applied: boolean }[] }>(
      "/api/v1/service-tokens/reconcile",
      { method: "POST", token: owner, ...body({ apply: true }) },
    );
    expect(report.body.entries).toEqual([
      expect.objectContaining({ kind: "revoke_incomplete", applied: true }),
    ]);
    expect((await cloudflare(account)).tokens).toEqual([]);
  });

  it("refuses to revoke the last global administrator", async () => {
    const solo = await apiHarness({ bindings: configured(account), seedOwner: false });
    const seeded = await seedCloudflareToken(account, "admin robot");
    const identityId = await seedIdentity(solo.db, { kind: "service", subject: seeded.client_id });
    await seedGrant(solo.db, { identityId, role: "admin", scopeType: "global" });
    const robot = await solo.serviceToken(seeded.client_id);

    const adopted = await solo.json<{ id: string }>("/api/v1/service-tokens/adopt", {
      method: "POST",
      token: robot,
      ...body({ client_id: seeded.client_id }),
    });
    expect(adopted.status).toBe(201);

    const revoked = await solo.json<{ code: string }>(`/api/v1/service-tokens/${adopted.body.id}`, {
      method: "DELETE",
      token: robot,
    });
    expect(revoked.status).toBe(409);
    expect(revoked.body.code).toBe("LAST_ADMIN");
  });
});

describe("POST /service-tokens/adopt", () => {
  it("brings a dashboard-made token under management, keeping grants it already holds", async () => {
    const seeded = await seedCloudflareToken(account, "made by hand");
    const identityId = await seedIdentity(api.db, { kind: "service", subject: seeded.client_id });
    await seedGrant(api.db, { identityId, role: "reader", scopeType: "global" });

    const { status, body: adopted } = await api.json<{
      identityId: string;
      adopted: boolean;
      name: string;
    }>("/api/v1/service-tokens/adopt", {
      method: "POST",
      token: owner,
      ...body({ client_id: seeded.client_id, name: "legacy deploy" }),
    });

    expect(status).toBe(201);
    expect(adopted).toMatchObject({ identityId, adopted: true, name: "legacy deploy" });

    const grants = await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE identity_id = ?")
      .bind(identityId)
      .first<{ n: number }>();
    expect(grants?.n).toBe(1);

    const again = await api.json("/api/v1/service-tokens/adopt", {
      method: "POST",
      token: owner,
      ...body({ client_id: seeded.client_id }),
    });
    expect(again.status).toBe(409);
  });

  it("answers 404 for a client id Cloudflare does not know", async () => {
    const { status } = await api.json("/api/v1/service-tokens/adopt", {
      method: "POST",
      token: owner,
      ...body({ client_id: "0123456789abcdef.access" }),
    });
    expect(status).toBe(404);
  });
});

describe("POST /service-tokens/reconcile", () => {
  it("finds orphans and foreign tokens, ignores hand-made ones, and repairs only its own", async () => {
    const instance = await instanceId();
    const orphan = await seedCloudflareToken(account, `prick:${instance}:${crypto.randomUUID()}`);
    const foreign = await seedCloudflareToken(
      account,
      `prick:${"f".repeat(32)}:${crypto.randomUUID()}`,
    );
    await seedCloudflareToken(account, "deploy key made by hand");

    const dry = await api.json<{
      applied: boolean;
      entries: { kind: string; cloudflareId: string }[];
    }>("/api/v1/service-tokens/reconcile", { method: "POST", token: owner, ...body({}) });
    expect(dry.body.applied).toBe(false);
    expect(dry.body.entries.map((entry) => [entry.kind, entry.cloudflareId]).sort()).toEqual(
      [
        ["foreign", foreign.id],
        ["orphan", orphan.id],
      ].sort(),
    );

    await api.json("/api/v1/service-tokens/reconcile", {
      method: "POST",
      token: owner,
      ...body({ apply: true }),
    });

    const left = (await cloudflare(account)).tokens.map((token) => token.id);
    expect(left).not.toContain(orphan.id);
    expect(left).toContain(foreign.id);
    expect(left).toHaveLength(2);
  });

  it("retires a token deleted in the dashboard", async () => {
    const { body: issued } = await create();
    await deleteInDashboard(account, issued.token.cloudflareId);

    const report = await api.json<{ entries: { kind: string; applied: boolean }[] }>(
      "/api/v1/service-tokens/reconcile",
      { method: "POST", token: owner, ...body({ apply: true }) },
    );
    expect(report.body.entries).toEqual([
      expect.objectContaining({ kind: "missing", applied: true }),
    ]);

    const row = await env.DB.prepare("SELECT revoked_at FROM service_tokens WHERE id = ?")
      .bind(issued.token.id)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();
  });
});
