import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { describe } from "node:test";

import { PrickApiClient } from "../src/api.ts";
import { createMcpServer } from "../src/server.ts";
import { capturingLogger, jsonResponse, stubConfig, stubFetch, type StubCall } from "./helpers.ts";

/**
 * These tests drive the server through a real MCP client over an in-memory
 * transport, so `tools/list` is the actual protocol response rather than an
 * inspection of internal state. The gate on `secrets_get` is a claim about what
 * a model can SEE, and the only honest way to check it is to look at what the
 * protocol hands back.
 */
async function connect(
  handler: (call: StubCall) => Response,
  configOverrides: Record<string, unknown> = {},
) {
  const config = stubConfig(configOverrides);
  const captured = capturingLogger();
  const stub = stubFetch(handler);

  const server = createMcpServer({
    config,
    logger: captured.logger,
    client: new PrickApiClient(config, captured.logger, stub.fetch),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server, calls: stub.calls, logs: () => captured.text() };
}

const EMPTY = () => jsonResponse({ secrets: [] });

describe("tools/list gating", () => {
  test("secrets_get is ABSENT by default", async () => {
    const { client, server } = await connect(EMPTY);

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "environments_list",
      "projects_list",
      "secrets_delete",
      "secrets_diff",
      "secrets_list",
      "secrets_set",
    ]);
    assert.ok(!names.includes("secrets_get"));

    await client.close();
    await server.close();
  });

  test("secrets_get is PRESENT once reveal is opted into", async () => {
    const { client, server } = await connect(EMPTY, { allowReveal: true });

    const tools = (await client.listTools()).tools;
    const reveal = tools.find((tool) => tool.name === "secrets_get");

    assert.ok(reveal !== undefined, "secrets_get should be advertised when reveal is enabled");
    assert.equal(tools.length, 7);

    await client.close();
    await server.close();
  });

  test("every tool description states the confidentiality rule where a value is in play", async () => {
    const { client, server } = await connect(EMPTY, { allowReveal: true });

    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));

    for (const name of ["secrets_list", "secrets_set"]) {
      assert.match(byName.get(name) ?? "", /never echo|not be repeated|confidential/i, name);
    }

    assert.match(byName.get("secrets_get") ?? "", /LIVE CREDENTIAL/);
    assert.match(byName.get("secrets_get") ?? "", /disabled by default/);
    assert.match(byName.get("secrets_diff") ?? "", /No value is read from the server/);
    assert.match(byName.get("secrets_list") ?? "", /NEVER returns a value/);

    await client.close();
    await server.close();
  });

  test("annotations mark the destructive tool and only the destructive tool", async () => {
    const { client, server } = await connect(EMPTY, { allowReveal: true });

    const destructive = (await client.listTools()).tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);

    assert.deepEqual(destructive, ["secrets_delete"]);

    await client.close();
    await server.close();
  });
});

describe("tool calls over the protocol", () => {
  test("secrets_list returns names, and drops a value the server should not have sent", async () => {
    const { client, server } = await connect(() =>
      jsonResponse({
        secrets: [{ key: "DATABASE_URL", value: "pg://LEAK", version: 3, updatedAt: 7 }],
      }),
    );

    const result = await client.callTool({
      name: "secrets_list",
      arguments: { project: "app", environment: "prod" },
    });

    const rendered = JSON.stringify(result);
    assert.ok(rendered.includes("DATABASE_URL"));
    assert.ok(!rendered.includes("pg://LEAK"), "a value crossed the transport");

    await client.close();
    await server.close();
  });

  test("a failed call comes back as a structured isError result, not a protocol error", async () => {
    const { client, server } = await connect(() =>
      jsonResponse({ code: "NOT_FOUND", message: "No such project." }, 404),
    );

    const result = await client.callTool({
      name: "secrets_list",
      arguments: { project: "nope", environment: "prod" },
    });

    assert.equal(result.isError, true);

    const content = result.content as { type: string; text: string }[];
    const envelope = JSON.parse(content[0]?.text ?? "{}") as {
      ok: boolean;
      error: { code: string; api_code?: string; status?: number; hint?: string };
    };

    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.api_code, "NOT_FOUND");
    assert.equal(envelope.error.status, 404);
    // Useful, not just safe: the model has to be told what to do next.
    assert.match(envelope.error.hint ?? "", /projects_list/);

    await client.close();
    await server.close();
  });

  test("bad arguments are rejected without echoing them", async () => {
    const { client, server } = await connect(EMPTY);

    const result = await client.callTool({
      name: "secrets_set",
      arguments: {
        project: "app",
        environment: "prod",
        key: "9INVALID",
        value: "pg://SHOULD-NOT-APPEAR",
      },
    });

    assert.equal(result.isError, true);
    assert.ok(
      !JSON.stringify(result).includes("pg://SHOULD-NOT-APPEAR"),
      "argument validation echoed the value",
    );

    await client.close();
    await server.close();
  });
});

describe("stdout discipline", () => {
  test("no module in src/ writes to stdout", async () => {
    // stdout is the transport. This is the mechanical half of that rule; the
    // other half is the console redirect in main.ts, which covers dependencies.
    const dir = new URL("../src/", import.meta.url);
    const files = await readdir(dir);

    for (const file of files.filter((name) => name.endsWith(".ts"))) {
      const source = await readFile(new URL(file, dir), "utf8");

      assert.ok(
        !/console\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\s*\(/.test(source),
        `${file} calls console.*; use the logger, which writes to stderr`,
      );
      assert.ok(
        !/process\s*\.\s*stdout/.test(source),
        `${file} touches process.stdout, which is the MCP transport`,
      );
    }
  });
});
