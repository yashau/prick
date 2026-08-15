import { beforeEach, describe, expect, it } from "vitest";

import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;

beforeEach(async () => {
  api = await apiHarness();
});

describe("the router is reachable end to end", () => {
  it("serves a project list to a global reader", async () => {
    await seedProject(api.db, "acme");
    await api.grant({ subject: "reader@example.com", role: "reader", scopeType: "global" });

    const token = await api.userToken("reader@example.com");
    const { status, body: rows } = await api.json<{ slug: string }[]>("/api/v1/projects", {
      token,
    });

    expect(status).toBe(200);
    expect(rows.map((row) => row.slug)).toEqual(["acme"]);
  });

  it("serves the SAME environment through both mount paths", async () => {
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");
    await api.grant({ subject: "reader@example.com", role: "reader", scopeType: "global" });

    const token = await api.userToken("reader@example.com");

    const canonical = await api.json<{ slug: string; rev: number }>(
      "/api/v1/projects/acme/environments/prod",
      { token },
    );
    const alias = await api.json<{ slug: string; rev: number }>("/api/v1/p/acme/e/prod", { token });

    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(alias.body).toEqual(canonical.body);
  });

  it("writes and lists a secret through the alias path", async () => {
    const projectId = await seedProject(api.db, "acme");
    await seedEnvironment(api.db, projectId, "prod");
    await api.grant({ subject: "writer@example.com", role: "writer", scopeType: "global" });

    const token = await api.userToken("writer@example.com");

    const written = await api.json<{ rev: number; added: string[] }>(
      "/api/v1/p/acme/e/prod/secrets:batch",
      { method: "POST", token, ...body({ mode: "merge", set: { DATABASE_URL: "postgres://x" } }) },
    );

    expect(written.status).toBe(200);
    expect(written.body.added).toEqual(["DATABASE_URL"]);

    const listed = await api.json<{ key: string; unreadable: boolean }[]>(
      "/api/v1/projects/acme/environments/prod/secrets",
      { token },
    );

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ key: "DATABASE_URL", unreadable: false }),
    ]);

    // The listing never carries a value, whatever else it grows.
    expect(JSON.stringify(listed.body)).not.toContain("postgres://x");
  });
});
