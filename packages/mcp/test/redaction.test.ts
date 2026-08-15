import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { PrickApiClient } from "../src/api.ts";
import { toErrorEnvelope, VALUE_ECHO_PLACEHOLDER } from "../src/errors.ts";
import { secretsSet, type ToolContext } from "../src/tools.ts";
import { capturingLogger, jsonResponse, stubConfig, stubFetch, textResponse } from "./helpers.ts";

/**
 * THE test in this package.
 *
 * A secret value must not appear in the result of a failed tool call, nor in
 * anything written to the log, on ANY error path. The list below is every way a
 * write can fail that this server can distinguish, plus two that only exist
 * because the other side might misbehave.
 *
 * The sentinel is unlikely enough to appear by accident that a substring match
 * over the whole rendered envelope and the whole captured log is a meaningful
 * assertion rather than a coincidence waiting to happen.
 */
const SENTINEL = "pg://u:Zx9-QUITE-DISTINCTIVE-7fQ@db.internal:5432/app";

type Failure = () => Response | never;

const FAILURES: [name: string, produce: Failure][] = [
  [
    "the network is unreachable",
    () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED, sending ${SENTINEL}`);
    },
  ],
  [
    "the request times out",
    () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  ],
  [
    "401 with the API error envelope",
    () => jsonResponse({ code: "UNAUTHENTICATED", message: "No." }, 401),
  ],
  ["403 with no body at all", () => new Response(null, { status: 403 })],
  [
    "404 for a project that is not visible",
    () => jsonResponse({ code: "NOT_FOUND", message: "No such project." }, 404),
  ],
  [
    "412 precondition failed",
    () => jsonResponse({ code: "PRECONDITION_FAILED", message: "Changed." }, 412),
  ],
  [
    "413 payload too large",
    () => jsonResponse({ code: "PAYLOAD_TOO_LARGE", message: "Too big." }, 413),
  ],
  ["429 rate limited", () => jsonResponse({ code: "RATE_LIMITED", message: "Slow down." }, 429)],
  [
    "500 whose HTML body quotes the request",
    // A proxy or an unhandled framework error page. The body is HTML, so it is
    // described and never echoed.
    () => textResponse(`<html><body><pre>POST failed for ${SENTINEL}</pre></body></html>`, 500),
  ],
  [
    "a redirect to the Access login page",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
      }),
  ],
  ["a 200 whose body is not JSON", () => textResponse("<html>not the worker</html>", 200)],
  [
    "a 200 with a broken JSON body",
    () => new Response("{oh no", { status: 200, headers: { "content-type": "application/json" } }),
  ],
  [
    "a misbehaving server that echoes the submitted value in its error envelope",
    // The API contract forbids this. The contract is on the other side of a
    // network boundary, in a package still being written, so the tripwire in
    // `secretsSet` checks anyway.
    () => jsonResponse({ code: "VALIDATION_FAILED", message: `rejected value ${SENTINEL}` }, 422),
  ],
  [
    "a misbehaving server that echoes the value in the hint",
    () =>
      jsonResponse(
        { code: "BAD_REQUEST", message: "No.", hint: `try something other than ${SENTINEL}` },
        400,
      ),
  ],
];

describe("no error path can carry a secret value", () => {
  for (const [name, produce] of FAILURES) {
    test(name, async () => {
      const config = stubConfig();
      const captured = capturingLogger();
      const stub = stubFetch(() => produce());

      const ctx: ToolContext = {
        client: new PrickApiClient(config, captured.logger, stub.fetch),
        config,
        logger: captured.logger,
      };

      let thrown: unknown;

      try {
        await secretsSet(ctx, {
          project: "app",
          environment: "prod",
          key: "DATABASE_URL",
          value: SENTINEL,
          reason: "rotation",
        });
        assert.fail("the write should not have succeeded");
      } catch (error) {
        thrown = error;
      }

      const rendered = JSON.stringify(toErrorEnvelope(thrown), null, 2);

      assert.ok(!rendered.includes(SENTINEL), `the value reached the tool result:\n${rendered}`);
      assert.ok(
        !captured.text().includes(SENTINEL),
        `the value reached the log:\n${captured.text()}`,
      );

      // The error still has to be USEFUL. An envelope that says nothing is safe
      // and worthless; every one of these must name the key it concerned.
      const envelope = toErrorEnvelope(thrown);
      assert.equal(envelope.error.key, "DATABASE_URL");
      assert.equal(envelope.error.project, "app");
      assert.equal(envelope.error.environment, "prod");
      assert.ok(envelope.error.message.length > 0);
    });
  }

  test("an echoed value is replaced with a placeholder and reported at error level", async () => {
    const config = stubConfig();
    const captured = capturingLogger();
    const stub = stubFetch(() =>
      jsonResponse({ code: "VALIDATION_FAILED", message: `rejected ${SENTINEL}` }, 422),
    );

    const ctx: ToolContext = {
      client: new PrickApiClient(config, captured.logger, stub.fetch),
      config,
      logger: captured.logger,
    };

    await assert.rejects(
      () =>
        secretsSet(ctx, {
          project: "app",
          environment: "prod",
          key: "DATABASE_URL",
          value: SENTINEL,
        }),
      (error: unknown) => {
        assert.match(
          String((error as Error).message),
          new RegExp(escapeRegExp(VALUE_ECHO_PLACEHOLDER)),
        );
        return true;
      },
    );

    assert.match(captured.text(), /echoed a submitted secret value/);
  });

  test("the request body is never logged, even at debug level", async () => {
    const config = stubConfig({ logLevel: "debug" });
    const captured = capturingLogger();
    const stub = stubFetch(() => jsonResponse({ rev: 1, added: ["K"], changed: [], removed: [] }));

    const ctx: ToolContext = {
      client: new PrickApiClient(config, captured.logger, stub.fetch),
      config,
      logger: captured.logger,
    };

    await secretsSet(ctx, { project: "app", environment: "prod", key: "K", value: SENTINEL });

    assert.match(captured.text(), /api request/, "the request line should be logged");
    assert.ok(!captured.text().includes(SENTINEL), "the request body reached the log");
  });

  test("an unclassified throwable is reduced to a constant message", () => {
    const envelope = toErrorEnvelope(new Error(`something went wrong near ${SENTINEL}`));

    assert.ok(!JSON.stringify(envelope).includes(SENTINEL));
    assert.equal(envelope.error.code, "TRANSPORT");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
