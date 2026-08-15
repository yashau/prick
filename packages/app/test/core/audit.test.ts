import { AuditQuery } from "@prick/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { queryAudit, recordAudit } from "../../src/lib/server/core/audit.js";
import { createProject } from "../../src/lib/server/core/projects.js";
import { createEnvironment } from "../../src/lib/server/core/environments.js";
import { writeSecrets } from "../../src/lib/server/core/secrets.js";
import type { Keyring } from "../../src/lib/server/crypto/index.js";
import type { Database } from "../../src/lib/server/db/client.js";
import {
  freshDatabase,
  secretsContext,
  seedGlobalAdmin,
  testKeyring,
  userActor,
} from "./fixtures.js";

const ADMIN = "admin@example.com";

let db: Database;
let keyring: Keyring;

beforeEach(async () => {
  db = await freshDatabase();
  keyring = await testKeyring();
  await seedGlobalAdmin(db, ADMIN);
});

function ctx() {
  return secretsContext(db, userActor(ADMIN), keyring);
}

/** The schema's defaults matter here -- `limit` is one of them. */
function query(overrides: Partial<AuditQuery> = {}): AuditQuery {
  return AuditQuery.parse(overrides);
}

describe("keyset pagination", () => {
  /**
   * Paginating on the UUIDv7 primary key rather than on OFFSET.
   *
   * The audit log is append-only and grows UNDER THE READER. With OFFSET, every
   * row inserted between two page fetches shifts the window by one and the
   * reader silently skips an entry -- so a paginator that loses audit rows
   * exactly while something is happening, which is the only time anyone is
   * reading it.
   *
   * This is also the whole reason ids are v7: `id < cursor ORDER BY id DESC` is
   * only meaningful because a v7 id embeds its timestamp in its high bits and
   * therefore sorts in creation order. With `crypto.randomUUID()` (v4) the same
   * query returns an arbitrary subset and looks like it worked.
   */
  async function seedEntries(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await recordAudit(
        // A fresh context per row so each gets its own request id and a
        // monotonically later uuidv7.
        secretsContext(db, userActor(ADMIN), keyring),
        {
          action: "secret.reveal",
          outcome: "success",
          targetKey: `KEY_${String(i)}`,
          detail: { kind: "secret.read", reason: "reveal", count: 1 },
        },
      );
    }
  }

  it("walks the whole log exactly once, newest first", async () => {
    await seedEntries(25);

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result = await queryAudit(
        ctx(),
        query({ limit: 10, ...(cursor === null ? {} : { cursor }) }),
      );

      seen.push(...result.entries.map((entry) => entry.targetKey ?? ""));
      cursor = result.cursor;
      if (cursor === null) break;
    }

    // Every row, once. No repeats and no gaps -- which is precisely what OFFSET
    // pagination cannot promise on an append-only table.
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe("KEY_24");
    expect(seen.at(-1)).toBe("KEY_0");
  });

  it("does not skip a row when the log grows mid-walk", async () => {
    await seedEntries(15);

    const first = await queryAudit(ctx(), query({ limit: 10 }));
    expect(first.entries).toHaveLength(10);
    expect(first.cursor).not.toBeNull();

    // Something happens between the two page fetches. Under OFFSET this pushes
    // a row across the page boundary and the reader never sees it.
    await seedEntries(3);

    const second = await queryAudit(ctx(), query({ limit: 10, cursor: first.cursor ?? undefined }));

    const combined = [
      ...first.entries.map((entry) => entry.targetKey),
      ...second.entries.map((entry) => entry.targetKey),
    ];

    expect(new Set(combined).size).toBe(combined.length);
    // The five original rows below the cursor are all still reachable.
    for (const key of ["KEY_0", "KEY_1", "KEY_2", "KEY_3", "KEY_4"]) {
      expect(combined).toContain(key);
    }
  });

  it("returns a null cursor at the end of the log", async () => {
    await seedEntries(3);

    const result = await queryAudit(ctx(), query({ limit: 10 }));

    expect(result.entries).toHaveLength(3);
    expect(result.cursor).toBeNull();
  });
});

describe("filters", () => {
  it("filters by action and outcome", async () => {
    await createProject(ctx(), { slug: "acme", name: "Acme" });
    await createEnvironment(ctx(), "acme", { slug: "prod", name: "Prod" });
    await writeSecrets(ctx(), "acme", "prod", { mode: "replace", set: { A: "1" } });

    const writes = await queryAudit(ctx(), query({ action: "secret.write" }));
    expect(writes.entries).toHaveLength(1);

    const denials = await queryAudit(ctx(), query({ outcome: "denied" }));
    expect(denials.entries).toHaveLength(0);
  });

  it("returns an EMPTY PAGE for a project filter naming something invisible", async () => {
    await createProject(ctx(), { slug: "acme", name: "Acme" });

    // Not a 404. Distinguishing "no such project" from "no events" would be the
    // same existence oracle the NOT_FOUND rule closes everywhere else.
    const result = await queryAudit(ctx(), query({ project: "no-such-project" }));

    expect(result.entries).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it("parses stored detail back into an object", async () => {
    await createProject(ctx(), { slug: "acme", name: "Acme" });

    const result = await queryAudit(ctx(), query({ action: "project.create" }));

    expect(result.entries[0]?.detail).toMatchObject({ kind: "resource", slug: "acme" });
  });
});
