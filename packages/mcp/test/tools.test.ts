import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { PrickApiClient } from "../src/api.ts";
import { ToolError } from "../src/errors.ts";
import {
  environmentsList,
  projectsList,
  secretsDelete,
  secretsDiff,
  secretsGet,
  secretsList,
  secretsSet,
  type ToolContext,
} from "../src/tools.ts";
import { capturingLogger, jsonResponse, stubConfig, stubFetch, type StubCall } from "./helpers.ts";

function context(
  handler: (call: StubCall) => Response | Promise<Response>,
  configOverrides = {},
): { ctx: ToolContext; calls: StubCall[]; logs: () => string } {
  const config = stubConfig(configOverrides);
  const logger = capturingLogger();
  const stub = stubFetch(handler);

  return {
    ctx: {
      client: new PrickApiClient(config, logger.logger, stub.fetch),
      config,
      logger: logger.logger,
    },
    calls: stub.calls,
    logs: () => logger.text(),
  };
}

describe("projects_list", () => {
  test("returns slugs and metadata", async () => {
    const { ctx, calls } = context(() =>
      jsonResponse({ projects: [{ slug: "app", name: "App", environmentCount: 3, updatedAt: 1 }] }),
    );

    const result = await projectsList(ctx);

    assert.equal(result.count, 1);
    assert.deepEqual(result.projects, [
      { slug: "app", name: "App", description: null, environment_count: 3, updated_at: 1 },
    ]);
    assert.equal(calls[0]?.url, "https://secrets.example.com/api/v1/projects");
  });

  test("sends the Access service token headers and nothing resembling a cookie", async () => {
    const { ctx, calls } = context(() => jsonResponse([]));
    await projectsList(ctx);

    const headers = calls[0]?.headers ?? {};
    assert.equal(headers["CF-Access-Client-Id"], "test-client-id.access");
    assert.equal(headers["CF-Access-Client-Secret"], "test-client-secret");
    assert.ok(typeof headers["X-Request-Id"] === "string" && headers["X-Request-Id"].length > 0);
  });

  test("tolerates a bare array as well as a wrapper", async () => {
    const { ctx } = context(() => jsonResponse([{ slug: "app" }]));
    assert.equal((await projectsList(ctx)).count, 1);
  });
});

describe("environments_list", () => {
  test("percent-encodes the project in the path", async () => {
    const { ctx, calls } = context(() => jsonResponse({ environments: [] }));
    await environmentsList(ctx, { project: "my-app" });

    assert.equal(calls[0]?.url, "https://secrets.example.com/api/v1/projects/my-app/environments");
  });
});

describe("secrets_list", () => {
  test("returns names and metadata", async () => {
    const { ctx, calls } = context(() =>
      jsonResponse({
        secrets: [
          {
            key: "DATABASE_URL",
            version: 4,
            updatedAt: 100,
            updatedBy: "ci@example",
            description: null,
          },
          { key: "STRIPE_KEY", version: 1, updatedAt: 90, updatedBy: "a@example" },
        ],
      }),
    );

    const result = await secretsList(ctx, { project: "app", environment: "prod" });

    assert.deepEqual(
      result.secrets.map((entry) => entry.key),
      ["DATABASE_URL", "STRIPE_KEY"],
    );
    assert.equal(calls[0]?.url, "https://secrets.example.com/api/v1/p/app/e/prod/secrets");
  });

  test("DROPS a value field even if the server sends one", async () => {
    // The allow-list projection is the whole security property of this tool: it
    // must hold even when the other side is wrong. A `value` reaching the model
    // through the tool advertised as "never returns a value" would be the worst
    // possible failure in this package.
    const { ctx } = context(() =>
      jsonResponse({
        secrets: [
          {
            key: "DATABASE_URL",
            value: "postgres://hunter2@db/app",
            plaintext: "hunter2",
            version: 1,
          },
        ],
      }),
    );

    const result = await secretsList(ctx, { project: "app", environment: "prod" });
    const serialised = JSON.stringify(result);

    assert.ok(!serialised.includes("hunter2"), "secrets_list forwarded a value");
    assert.ok(!serialised.includes("postgres://"), "secrets_list forwarded a value");
    assert.ok(!Object.hasOwn(result.secrets[0] ?? {}, "value"));
  });

  test("surfaces unreadable rows loudly instead of dropping them", async () => {
    const { ctx, logs } = context(() =>
      jsonResponse({
        secrets: [
          { key: "OK", version: 1 },
          { key: "TAMPERED", unreadable: true },
        ],
      }),
    );

    const result = await secretsList(ctx, { project: "app", environment: "prod" });

    assert.deepEqual(result.unreadable, ["TAMPERED"]);
    assert.equal(result.count, 2, "an unreadable row must still be listed, not skipped");
    assert.match(logs(), /failed to decrypt/);
  });
});

describe("secrets_set", () => {
  test("sends a merge batch carrying exactly one key", async () => {
    const { ctx, calls } = context((call) => {
      assert.equal(call.method, "POST");
      return jsonResponse({ rev: 8, added: ["NEW_KEY"], changed: [], removed: [] });
    });

    const result = await secretsSet(ctx, {
      project: "app",
      environment: "prod",
      key: "NEW_KEY",
      value: "s3cr3t-value",
      reason: "generated during setup",
    });

    assert.equal(calls[0]?.url, "https://secrets.example.com/api/v1/p/app/e/prod/secrets:batch");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      mode: "merge",
      set: { NEW_KEY: "s3cr3t-value" },
      reason: "generated during setup",
    });

    assert.deepEqual(result, {
      project: "app",
      environment: "prod",
      key: "NEW_KEY",
      outcome: "created",
      rev: 8,
    });
  });

  test("the successful result says nothing about the value, not even its length", async () => {
    const { ctx } = context(() => jsonResponse({ rev: 1, added: [], changed: ["K"], removed: [] }));

    const result = await secretsSet(ctx, {
      project: "app",
      environment: "prod",
      key: "K",
      value: "a-very-distinctive-value",
    });

    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes("a-very-distinctive-value"));
    assert.ok(!serialised.includes("24"), "the value's length must not be reported either");
    assert.equal(result.outcome, "updated");
  });
});

describe("secrets_delete", () => {
  test("sends a merge batch with a delete list", async () => {
    const { ctx, calls } = context(() =>
      jsonResponse({ rev: 9, added: [], changed: [], removed: ["OLD_KEY"] }),
    );

    const result = await secretsDelete(ctx, {
      project: "app",
      environment: "prod",
      key: "OLD_KEY",
      reason: "superseded",
    });

    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      mode: "merge",
      delete: ["OLD_KEY"],
      reason: "superseded",
    });
    assert.equal(result.removed, true);
  });
});

describe("secrets_diff", () => {
  const LOCAL = ["DATABASE_URL=postgres://hunter2@db/app", "ONLY_LOCAL='sk_live_LEAKME'", ""].join(
    "\n",
  );

  test("compares key names and leaks no value from either side", async () => {
    const base = context(() =>
      jsonResponse({
        secrets: [
          { key: "DATABASE_URL", version: 2 },
          { key: "ONLY_REMOTE", version: 1 },
          { key: "BROKEN", unreadable: true },
        ],
      }),
    );

    const ctx: ToolContext = { ...base.ctx, readLocalFile: async () => LOCAL };

    const result = await secretsDiff(ctx, {
      project: "app",
      environment: "prod",
      env_file: "./.env",
    });

    assert.deepEqual(result.only_in_file, ["ONLY_LOCAL"]);
    assert.deepEqual(result.only_in_environment, ["ONLY_REMOTE", "BROKEN"]);
    assert.deepEqual(result.in_both, ["DATABASE_URL"]);
    assert.deepEqual(result.unreadable_in_environment, ["BROKEN"]);

    const serialised = JSON.stringify(result);
    for (const fragment of ["hunter2", "sk_live_LEAKME", "postgres://"]) {
      assert.ok(!serialised.includes(fragment), `secrets_diff leaked ${fragment}`);
    }
    assert.ok(!base.logs().includes("hunter2"));
  });

  test('says plainly that "in both" is not "values agree"', async () => {
    const base = context(() => jsonResponse({ secrets: [{ key: "DATABASE_URL" }] }));
    const ctx: ToolContext = { ...base.ctx, readLocalFile: async () => "DATABASE_URL=x\n" };

    const result = await secretsDiff(ctx, {
      project: "app",
      environment: "prod",
      env_file: ".env",
    });

    assert.match(result.note, /NOT that the two values agree/);
  });

  test("a missing file is a structured error carrying the path and nothing else", async () => {
    const { ctx } = context(() => jsonResponse({ secrets: [] }));

    await assert.rejects(
      () =>
        secretsDiff(ctx, {
          project: "app",
          environment: "prod",
          env_file: "definitely-not-here.env",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, "LOCAL_FILE");
        assert.ok(typeof error.detail.path === "string");
        assert.ok(error.detail.path.endsWith("definitely-not-here.env"));
        return true;
      },
    );
  });
});

describe("secrets_get", () => {
  test("refuses when reveal is disabled, and names no value in the refusal", async () => {
    const { ctx, calls } = context(() => jsonResponse({ value: "must-never-be-fetched" }));

    await assert.rejects(
      () => secretsGet(ctx, { project: "app", environment: "prod", key: "DATABASE_URL" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, "REVEAL_DISABLED");
        assert.equal(error.detail.key, "DATABASE_URL");
        assert.match(error.detail.hint ?? "", /PRICK_MCP_ALLOW_REVEAL/);
        return true;
      },
    );

    // The refusal happens before any request is made: a disabled reveal must not
    // even cause the value to be decrypted server-side and audited.
    assert.equal(calls.length, 0);
  });

  test("returns the bare value when enabled, and audits with a reason", async () => {
    const { ctx, calls, logs } = context(() => jsonResponse({ value: "pg://real-secret" }), {
      allowReveal: true,
    });

    const value = await secretsGet(ctx, {
      project: "app",
      environment: "prod",
      key: "DATABASE_URL",
      reason: "run",
    });

    assert.equal(value, "pg://real-secret");
    assert.match(calls[0]?.url ?? "", /\/secrets\/DATABASE_URL\?reason=run$/);

    // The reveal is logged. The value is not.
    assert.match(logs(), /secret value revealed/);
    assert.ok(!logs().includes("pg://real-secret"), "the revealed value reached the log");
  });
});
