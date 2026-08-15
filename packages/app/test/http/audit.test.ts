import { beforeEach, describe, expect, it } from "vitest";

import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let owner: string;

beforeEach(async () => {
  api = await apiHarness();
  const projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
  owner = await api.ownerToken();
});

async function write(set: Record<string, string>): Promise<void> {
  const response = await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
    method: "POST",
    token: owner,
    ...body({ mode: "merge", set }),
  });
  expect(response.status).toBe(200);
}

describe("the audit log", () => {
  it("records a write with its diff and never its values", async () => {
    await write({ DATABASE_URL: "postgres://u:p@h/db" });

    const page = await api.json<{
      entries: { action: string; detail: { added?: string[] } }[];
    }>("/api/v1/audit?action=secret.write", { token: owner });

    expect(page.status).toBe(200);
    expect(page.body.entries[0]?.detail.added).toEqual(["DATABASE_URL"]);

    // The detail union has no member with a field that could hold a value, and
    // this is the assertion that the union is doing its job on the wire.
    expect(JSON.stringify(page.body)).not.toContain("postgres://u:p@h/db");
  });

  it("pages on the cursor rather than an offset", async () => {
    /*
     * The log is append-only and grows under the reader, so every insert between
     * two OFFSET pages shifts the window by one and makes the reader silently
     * skip a row. A paginator that loses audit entries only while something is
     * actively happening is worse than one that fails outright.
     */
    for (let index = 0; index < 5; index += 1) await write({ [`KEY_${String(index)}`]: "v" });

    const first = await api.json<{ entries: { id: string }[]; cursor: string | null }>(
      "/api/v1/audit?limit=2",
      { token: owner },
    );

    expect(first.body.entries).toHaveLength(2);
    expect(first.body.cursor).not.toBeNull();

    const second = await api.json<{ entries: { id: string }[]; cursor: string | null }>(
      `/api/v1/audit?limit=2&cursor=${first.body.cursor ?? ""}`,
      { token: owner },
    );

    const ids = new Set(first.body.entries.map((entry) => entry.id));
    for (const entry of second.body.entries) expect(ids.has(entry.id)).toBe(false);
  });

  it("returns an EMPTY PAGE for an unknown project filter, not a 404", async () => {
    // The alternative distinguishes "no such project" from "no events", which is
    // the same existence oracle the NOT_FOUND rule closes everywhere else.
    const page = await api.json<{ entries: unknown[]; cursor: string | null }>(
      "/api/v1/audit?project=does-not-exist",
      { token: owner },
    );

    expect(page.status).toBe(200);
    expect(page.body).toEqual({ entries: [], cursor: null });
  });

  it("filters by actor, action and outcome", async () => {
    await write({ A: "1" });

    const denied = await api.serviceToken("denied.access");
    await api.fetch("/api/v1/p/acme/e/prod/secrets", { token: denied });

    const page = await api.json<{ entries: { outcome: string; actorSubject: string }[] }>(
      "/api/v1/audit?outcome=denied",
      { token: owner },
    );

    expect(page.body.entries.length).toBeGreaterThan(0);
    for (const entry of page.body.entries) expect(entry.outcome).toBe("denied");
    expect(page.body.entries.map((entry) => entry.actorSubject)).toContain("denied.access");
  });

  it("records the reveal reason, so 'looked at' and 'took a copy' are distinguishable", async () => {
    await write({ A: "one" });

    await api.fetch("/api/v1/p/acme/e/prod/secrets/A?reason=reveal", { token: owner });
    await api.fetch("/api/v1/p/acme/e/prod/secrets/A?reason=copy", { token: owner });

    const page = await api.json<{ entries: { detail: { reason?: string } }[] }>(
      "/api/v1/audit?action=secret.reveal",
      { token: owner },
    );

    expect(page.body.entries.map((entry) => entry.detail.reason)).toEqual(["copy", "reveal"]);
  });

  it("records ONE row for an export, not one per key", async () => {
    // An export is one decision by one person at one instant. Five hundred rows
    // describing it would make the log worse rather than more complete.
    await write({ A: "1", B: "2", C: "3" });
    await api.fetch("/api/v1/p/acme/e/prod/secrets:export", { token: owner });

    const page = await api.json<{ entries: { detail: { count?: number } }[] }>(
      "/api/v1/audit?action=secret.export",
      { token: owner },
    );

    expect(page.body.entries).toHaveLength(1);
    expect(page.body.entries[0]?.detail.count).toBe(3);
  });
});
