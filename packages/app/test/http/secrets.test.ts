import { beforeEach, describe, expect, it } from "vitest";

import { environments, secrets } from "../../src/lib/server/db/schema.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let token: string;

beforeEach(async () => {
  api = await apiHarness();
  const projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
  token = await api.ownerToken();
});

const SECRETS = "/api/v1/p/acme/e/prod/secrets";

async function write(payload: unknown, init: RequestInit = {}): Promise<Response> {
  return api.fetch(`${SECRETS}:batch`, { method: "POST", token, ...body(payload), ...init });
}

// ---------------------------------------------------------------------------
// ETag / If-Match
// ---------------------------------------------------------------------------

describe("the secret collection carries its revision as an ETag", () => {
  it("answers a strong tag that is the environment's rev", async () => {
    const empty = await api.fetch(SECRETS, { token });
    expect(empty.headers.get("ETag")).toBe('"0"');

    await write({ mode: "merge", set: { A: "1" } });

    const afterOne = await api.fetch(SECRETS, { token });
    expect(afterOne.headers.get("ETag")).toBe('"1"');

    // Strong, not weak. `If-Match` on a weak tag is not permitted for a
    // conditional write, which is the only thing this tag exists for.
    expect(afterOne.headers.get("ETag")?.startsWith("W/")).toBe(false);
  });

  it("returns the post-write revision as the ETag of a write", async () => {
    const response = await write({ mode: "merge", set: { A: "1" } });

    expect(response.headers.get("ETag")).toBe('"1"');
    await expect(response.json()).resolves.toMatchObject({ rev: 1 });
  });

  it("round-trips: read the ETag, write with it, and the write is applied", async () => {
    await write({ mode: "merge", set: { A: "1" } });

    const listed = await api.fetch(SECRETS, { token });
    const etag = listed.headers.get("ETag") ?? "";

    const conditional = await write(
      { mode: "replace", set: { B: "2" } },
      { headers: { "If-Match": etag, "Content-Type": "application/json" } },
    );

    expect(conditional.status).toBe(200);
    await expect(conditional.json()).resolves.toMatchObject({
      added: ["B"],
      removed: ["A"],
      rev: 2,
    });
  });
});

describe("a stale If-Match is a 412 and the environment is untouched", () => {
  it("refuses the write and changes nothing", async () => {
    await write({ mode: "merge", set: { A: "1", B: "2" } });

    const before = await snapshot();

    /*
     * `"0"` is the revision the environment had before the seeding write, so
     * this is exactly the shape of a lost update: a client read the collection,
     * something else wrote, and the client is now trying to replace based on
     * what it saw.
     *
     * `UPDATE ... WHERE rev = ?` would NOT catch it -- D1 rolls a batch back on
     * an ERROR, not on zero rows changed, so a non-matching UPDATE is a
     * perfectly successful statement that happened to affect nothing and the
     * batch would sail past it. The guard is a deliberate constraint violation
     * instead, and its failure mode IS the rollback.
     */
    const response = await write(
      { mode: "replace", set: { C: "3" } },
      { headers: { "If-Match": '"0"', "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await snapshot()).toEqual(before);
  });

  it("does the same for expected_rev in the body", async () => {
    await write({ mode: "merge", set: { A: "1" } });
    const before = await snapshot();

    const response = await write({ mode: "replace", set: { C: "3" }, expected_rev: 0 });

    expect(response.status).toBe(412);
    expect(await snapshot()).toEqual(before);
  });

  it("accepts If-Match and expected_rev together when they agree", async () => {
    await write({ mode: "merge", set: { A: "1" } });

    const response = await write(
      { mode: "replace", set: { C: "3" }, expected_rev: 1 },
      { headers: { "If-Match": '"1"', "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(200);
  });

  it("refuses them when they disagree, rather than picking one", async () => {
    // A precedence rule means one of the two silently does nothing, and the
    // caller who sent both did so because they wanted the guard applied.
    const response = await write(
      { mode: "replace", set: { C: "3" }, expected_rev: 1 },
      { headers: { "If-Match": '"7"', "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("treats `*` as a guard on existence only", async () => {
    const response = await write(
      { mode: "merge", set: { A: "1" } },
      { headers: { "If-Match": "*", "Content-Type": "application/json" } },
    );

    expect(response.status).toBe(200);
  });

  it("refuses a malformed If-Match rather than writing unconditionally", async () => {
    // Silently falling back to an unconditional write is the failure this
    // header exists to prevent: the client believes it is writing safely.
    for (const header of ["3", 'W/"3", "4"', '"3", "4"', "banana"]) {
      const response = await write(
        { mode: "merge", set: { A: "1" } },
        { headers: { "If-Match": header, "Content-Type": "application/json" } },
      );

      expect(response.status, `If-Match: ${header}`).toBe(400);
    }
  });

  it("refuses a precondition on a route that cannot evaluate one", async () => {
    await write({ mode: "merge", set: { A: "1" } });

    const renamed = await api.fetch(`${SECRETS}:rename`, {
      method: "POST",
      token,
      headers: { "If-Match": '"1"', "Content-Type": "application/json" },
      ...body({ from: "A", to: "B" }),
    });

    expect(renamed.status).toBe(400);
    // And the rename did not happen.
    const rows = await api.db.select().from(secrets);
    expect(rows.map((row) => row.key)).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

describe("a write over ENV_MAX_SECRETS is a 413", () => {
  it("refuses before encrypting anything", async () => {
    // `ENV_MAX_SECRETS` is 500 in the test bindings. The cap exists because a
    // full replace must fit in ONE D1 batch -- splitting it across batches would
    // forfeit atomicity, so an oversized write is refused rather than made
    // non-atomic.
    const set: Record<string, string> = {};
    for (let index = 0; index < 501; index += 1) set[`KEY_${String(index)}`] = "v";

    const response = await write({ mode: "merge", set });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    // Nothing was written, and nothing was even sealed: the request-level check
    // runs before the plan is built.
    expect(await api.db.select().from(secrets)).toEqual([]);
  });

  it("accepts exactly the limit", async () => {
    const set: Record<string, string> = {};
    for (let index = 0; index < 500; index += 1) set[`KEY_${String(index)}`] = "v";

    const response = await write({ mode: "merge", set });

    expect(response.status).toBe(200);
    expect((await api.db.select().from(secrets)).length).toBe(500);
  });

  it("counts the RESULTING environment, not just the request", async () => {
    // Two merges of 300 keys each are individually under the cap and together
    // over it. The second is refused, because the limit is a property of the
    // environment rather than of a request.
    const first: Record<string, string> = {};
    for (let index = 0; index < 300; index += 1) first[`A_${String(index)}`] = "v";
    expect((await write({ mode: "merge", set: first })).status).toBe(200);

    const second: Record<string, string> = {};
    for (let index = 0; index < 300; index += 1) second[`B_${String(index)}`] = "v";

    const response = await write({ mode: "merge", set: second });
    expect(response.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Values, and the headers that keep them out of caches
// ---------------------------------------------------------------------------

describe("reveal and export are no-store", () => {
  beforeEach(async () => {
    await write({ mode: "merge", set: { DATABASE_URL: "postgres://u:p@h/db" } });
  });

  const EXPECTED: [string, string][] = [
    ["Cache-Control", "no-store, no-cache, must-revalidate, private"],
    ["Cloudflare-CDN-Cache-Control", "no-store"],
    // So a cached entry can never be served across identities.
    ["Vary", "Cf-Access-Jwt-Assertion"],
  ];

  for (const path of [`${SECRETS}/DATABASE_URL`, `${SECRETS}:export`]) {
    for (const [header, value] of EXPECTED) {
      it(`${path} sets ${header}`, async () => {
        const response = await api.fetch(path, { token });

        expect(response.status).toBe(200);
        expect(response.headers.get(header)).toBe(value);
      });
    }
  }

  it("does not set them on the metadata listing, which carries no values", async () => {
    const response = await api.fetch(SECRETS, { token });

    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
  });

  it("reveals the value, and audits the reason", async () => {
    const revealed = await api.json<{ key: string; value: string }>(
      `${SECRETS}/DATABASE_URL?reason=copy`,
      { token },
    );

    expect(revealed.status).toBe(200);
    expect(revealed.body).toEqual({ key: "DATABASE_URL", value: "postgres://u:p@h/db" });

    const audit = await api.json<{ entries: { action: string; detail: { reason?: string } }[] }>(
      "/api/v1/audit?action=secret.reveal",
      { token },
    );

    expect(audit.body.entries[0]?.detail.reason).toBe("copy");
  });

  it("accepts the `:reveal` custom-method spelling identically", async () => {
    // A secret key is a POSIX name and cannot contain a colon, so the suffix has
    // exactly one parse. Both spellings exist because the browser client and the
    // machine clients each guessed a different one.
    const suffixed = await api.json<{ key: string; value: string }>(
      `${SECRETS}/DATABASE_URL:reveal`,
      { token },
    );
    const plain = await api.json<{ key: string; value: string }>(`${SECRETS}/DATABASE_URL`, {
      token,
    });

    expect(suffixed.status).toBe(200);
    expect(suffixed.body).toEqual(plain.body);
    expect(suffixed.headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate, private",
    );
  });

  it("rejects a doubled suffix rather than being clever about it", async () => {
    const response = await api.fetch(`${SECRETS}/DATABASE_URL:reveal:reveal`, { token });

    expect(response.status).toBe(422);
  });

  it("exports a flat map of every value", async () => {
    await write({ mode: "merge", set: { SECOND: "two" } });

    const exported = await api.json<Record<string, string>>(`${SECRETS}:export`, { token });

    expect(exported.status).toBe(200);
    expect(exported.body).toEqual({ DATABASE_URL: "postgres://u:p@h/db", SECOND: "two" });
  });

  it("rejects an unknown reveal reason rather than defaulting", async () => {
    const response = await api.fetch(`${SECRETS}/DATABASE_URL?reason=exfiltrate`, { token });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("import", () => {
  it("computes a diff without writing when dry_run is set", async () => {
    await write({ mode: "merge", set: { KEEP: "1", REPLACE_ME: "2" } });
    const before = await snapshot();

    const preview = await api.json<{
      added: string[];
      changed: string[];
      removed: string[];
      applied: boolean;
    }>(`${SECRETS}:import`, {
      method: "POST",
      token,
      ...body({
        format: "env",
        content: "REPLACE_ME=new\nBRAND_NEW=3\n",
        mode: "replace",
        dry_run: true,
      }),
    });

    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      added: ["BRAND_NEW"],
      changed: ["REPLACE_ME"],
      removed: ["KEEP"],
      applied: false,
    });

    // The diff carries key names and change kinds ONLY -- never a value, in
    // either direction. "Old versus new" looks like a helpful diff and leaks two
    // secrets where the naive version leaks one.
    expect(JSON.stringify(preview.body)).not.toContain("new");

    expect(await snapshot()).toEqual(before);
  });

  it("applies the same plan when dry_run is false", async () => {
    await write({ mode: "merge", set: { KEEP: "1" } });

    const applied = await api.json<{ applied: boolean; added: string[] }>(`${SECRETS}:import`, {
      method: "POST",
      token,
      ...body({ format: "env", content: "BRAND_NEW=3\n", mode: "merge", dry_run: false }),
    });

    expect(applied.body).toMatchObject({ applied: true, added: ["BRAND_NEW"] });

    const rows = await api.db.select().from(secrets);
    expect(rows.map((row) => row.key).sort()).toEqual(["BRAND_NEW", "KEEP"]);
  });

  it("honours If-Match on the import route too", async () => {
    await write({ mode: "merge", set: { A: "1" } });

    const response = await api.fetch(`${SECRETS}:import`, {
      method: "POST",
      token,
      headers: { "If-Match": '"0"', "Content-Type": "application/json" },
      ...body({ format: "env", content: "B=2\n", mode: "replace", dry_run: false }),
    });

    expect(response.status).toBe(412);
  });

  it("refuses a JSON body that is not a flat string map, naming the key only", async () => {
    const response = await api.fetch(`${SECRETS}:import`, {
      method: "POST",
      token,
      ...body({
        format: "json",
        content: JSON.stringify({ GOOD: "x", BAD: { nested: "PLAINTEXT-abc" } }),
        mode: "merge",
        dry_run: true,
      }),
    });

    expect(response.status).toBe(422);

    const text = await response.text();
    expect(text).toContain("BAD");
    expect(text).not.toContain("PLAINTEXT-abc");
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("versions, rollback and rename", () => {
  it("lists history newest first, including tombstones", async () => {
    await write({ mode: "merge", set: { A: "one" } });
    await write({ mode: "merge", set: { A: "two" } });
    await write({ mode: "merge", delete: ["A"] });

    const history = await api.json<{ version: number; op: string; deleted: boolean }[]>(
      `${SECRETS}/A/versions`,
      { token },
    );

    expect(history.body.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.body[0]).toMatchObject({ op: "delete", deleted: true });
  });

  it("rolls forward rather than resurrecting the old envelope", async () => {
    await write({ mode: "merge", set: { A: "one" } });
    await write({ mode: "merge", set: { A: "two" } });

    const rolled = await api.json<{ rev: number; version: number }>(`${SECRETS}:rollback`, {
      method: "POST",
      token,
      ...body({ key: "A", to_version: 1 }),
    });

    expect(rolled.status).toBe(200);
    // Version 3, not 1: the old blob's AAD binds it to version 1, so writing
    // those bytes back as current would fail the next read's tag check.
    expect(rolled.body.version).toBe(3);

    const revealed = await api.json<{ value: string }>(`${SECRETS}/A`, { token });
    expect(revealed.body.value).toBe("one");
  });

  it("re-encrypts on rename, so the renamed key still decrypts", async () => {
    await write({ mode: "merge", set: { OLD_NAME: "value" } });

    const renamed = await api.json<{ rev: number }>(`${SECRETS}:rename`, {
      method: "POST",
      token,
      ...body({ from: "OLD_NAME", to: "NEW_NAME" }),
    });

    expect(renamed.status).toBe(200);

    const revealed = await api.json<{ value: string }>(`${SECRETS}/NEW_NAME`, { token });
    expect(revealed.body.value).toBe("value");

    expect((await api.fetch(`${SECRETS}/OLD_NAME`, { token })).status).toBe(404);
  });

  it("refuses to roll back to a tombstone", async () => {
    await write({ mode: "merge", set: { A: "one" } });
    await write({ mode: "merge", delete: ["A"] });
    await write({ mode: "merge", set: { A: "three" } });

    const response = await api.fetch(`${SECRETS}:rollback`, {
      method: "POST",
      token,
      ...body({ key: "A", to_version: 2 }),
    });

    expect(response.status).toBe(422);
  });
});

describe("a key named in both set and delete is refused", () => {
  it("names the keys and touches nothing", async () => {
    const response = await api.fetch(`${SECRETS}:batch`, {
      method: "POST",
      token,
      ...body({ mode: "merge", set: { A: "1" }, delete: ["A"] }),
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("A");
    expect(await api.db.select().from(secrets)).toEqual([]);
  });
});

/** Every fact the "unchanged" assertions compare, gathered in one place. */
async function snapshot(): Promise<{ rev: number; keys: Record<string, number> }> {
  const environmentRows = await api.db.select().from(environments);
  const secretRows = await api.db.select().from(secrets);

  const keys: Record<string, number> = {};
  for (const row of secretRows) keys[row.key] = row.currentVersion;

  return { rev: environmentRows[0]?.rev ?? -1, keys };
}
