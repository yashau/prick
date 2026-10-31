import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AccessServiceTokens,
  CloudflareServiceToken,
  IssuedServiceToken,
} from "../../src/lib/server/cloudflare/access.js";
import { CloudflareApiError } from "../../src/lib/server/cloudflare/access.js";
import type { CoreContext } from "../../src/lib/server/core/context.js";
import { PrickError } from "../../src/lib/server/core/errors.js";
import {
  createServiceToken,
  rotateServiceToken,
} from "../../src/lib/server/core/service-tokens.js";
import type { Database } from "../../src/lib/server/db/client.js";
import {
  freshDatabase,
  requestContext,
  seedGlobalAdmin,
  testConfig,
  userActor,
} from "./fixtures.js";

/**
 * The partial-failure paths, which the transport cannot reach: a Cloudflare call
 * that succeeds followed by a D1 write that does not.
 *
 * The write is made to fail with a trigger rather than a mock, so the batch that
 * fails is the real one. The rule under test is the module's ordering claim:
 * every crash point leaves access narrower than intended, and a secret is never
 * handed out for a change prick could not record.
 */

const SECRET = "cfast_sentinel-secret-never-to-be-seen-again";

class FakeApi implements AccessServiceTokens {
  readonly tokens = new Map<string, CloudflareServiceToken>();
  removeFails = false;

  async create(input: { name: string; duration: string }): Promise<IssuedServiceToken> {
    const token: CloudflareServiceToken = {
      id: crypto.randomUUID(),
      clientId: `${crypto.randomUUID().replaceAll("-", "")}.access`,
      name: input.name,
      duration: input.duration,
      enabled: true,
      expiresAt: null,
      lastSeenAt: null,
      leakReportedAt: null,
    };
    this.tokens.set(token.id, token);
    return { ...token, clientSecret: SECRET };
  }

  async rotate(id: string): Promise<IssuedServiceToken> {
    const token = this.tokens.get(id);
    if (token === undefined) throw new CloudflareApiError("not_found", "gone", 404, []);
    return { ...token, clientSecret: SECRET };
  }

  async refresh(id: string): Promise<CloudflareServiceToken> {
    const token = this.tokens.get(id);
    if (token === undefined) throw new CloudflareApiError("not_found", "gone", 404, []);
    return token;
  }

  async get(id: string): Promise<CloudflareServiceToken> {
    const token = this.tokens.get(id);
    if (token === undefined) throw new CloudflareApiError("not_found", "gone", 404, []);
    return token;
  }

  async enable(id: string): Promise<CloudflareServiceToken> {
    const token = await this.get(id);
    token.enabled = true;
    return token;
  }

  async remove(id: string): Promise<"deleted" | "absent"> {
    if (this.removeFails) throw new CloudflareApiError("unavailable", "down", 503, []);
    return this.tokens.delete(id) ? "deleted" : "absent";
  }

  async list(): Promise<CloudflareServiceToken[]> {
    return [...this.tokens.values()];
  }
}

let db: Database;
let fake: FakeApi;
let ctx: CoreContext;

beforeEach(async () => {
  db = await freshDatabase();
  fake = new FakeApi();
  const identityId = await seedGlobalAdmin(db, "owner@example.com");
  ctx = requestContext(
    db,
    { ...userActor("owner@example.com"), identityId },
    {
      config: testConfig({
        cloudflare: { state: "enabled", accountId: "a".repeat(32), baseUrl: "https://unused.test" },
      }),
      serviceTokenApi: fake,
    },
  );
});

afterEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_service_tokens");
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_rotate_audit");
});

async function auditText(): Promise<string> {
  const rows = await env.DB.prepare("SELECT action, outcome, detail FROM audit_log").all();
  return JSON.stringify(rows.results);
}

describe("create, when the transaction fails after Cloudflare issued the token", () => {
  it("deletes the token again, records the failure, and never returns the secret", async () => {
    await env.DB.exec(
      "CREATE TRIGGER fail_service_tokens BEFORE INSERT ON service_tokens BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );

    const error = await createServiceToken(ctx, { name: "ci", duration: "8760h" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PrickError);
    expect((error as PrickError).code).toBe("INTERNAL");
    expect((error as PrickError).hint).toContain("deleted from Cloudflare again");
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(fake.tokens.size).toBe(0);

    const identities = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE kind = 'service'",
    ).first<{ n: number }>();
    expect(identities?.n).toBe(0);

    const audit = await auditText();
    expect(audit).toContain('"outcome":"error"');
    expect(audit).toContain("compensated");
    expect(audit).not.toContain(SECRET);
  });

  it("names the orphan for reconcile when the compensating delete fails too", async () => {
    await env.DB.exec(
      "CREATE TRIGGER fail_service_tokens BEFORE INSERT ON service_tokens BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    fake.removeFails = true;

    const error = (await createServiceToken(ctx, { name: "ci", duration: "8760h" }).catch(
      (caught: unknown) => caught,
    )) as PrickError;

    expect(error.hint).toContain("reconcile");
    expect(fake.tokens.size).toBe(1);
    const [left] = [...fake.tokens.values()];
    expect(error.hint).toContain(left?.name);
  });
});

describe("rotate, when its audit row cannot be written", () => {
  it("discards the new secret rather than handing out an unrecorded rotation", async () => {
    const issued = await createServiceToken(ctx, { name: "ci", duration: "8760h" });

    await env.DB.exec(
      "CREATE TRIGGER fail_rotate_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'service_token.rotate' BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );

    const error = (await rotateServiceToken(ctx, issued.token.id, { grace_seconds: 0 }).catch(
      (caught: unknown) => caught,
    )) as PrickError;

    expect(error).toBeInstanceOf(PrickError);
    expect(error.code).toBe("INTERNAL");
    expect(error.hint).toContain("Rotate again");
    expect(JSON.stringify(error)).not.toContain(SECRET);

    const row = await env.DB.prepare("SELECT rotated_at FROM service_tokens WHERE id = ?")
      .bind(issued.token.id)
      .first<{ rotated_at: number | null }>();
    expect(row?.rotated_at).toBeNull();
  });
});

describe("a context without the API", () => {
  it("answers 503 rather than reaching for Cloudflare", async () => {
    const { serviceTokenApi: _dropped, ...withoutApi } = ctx;

    const error = (await createServiceToken(withoutApi, { name: "ci", duration: "8760h" }).catch(
      (caught: unknown) => caught,
    )) as PrickError;

    expect(error.code).toBe("SERVICE_TOKENS_UNCONFIGURED");
  });
});
