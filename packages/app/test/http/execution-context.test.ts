import type { ExecutionContext } from "hono";
import { describe, expect, it } from "vitest";

import {
  currentExecutionContext,
  withExecutionContext,
} from "../../src/lib/server/execution-context.js";

/** A context the runtime could have handed the Worker, told apart by identity. */
function runtimeContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} };
}

describe("withExecutionContext", () => {
  it("hands the wrapped handler's callees the runtime's own context", async () => {
    const ctx = runtimeContext();
    let seen: ExecutionContext | undefined;

    const worker = withExecutionContext({
      async fetch() {
        await Promise.resolve();
        seen = currentExecutionContext();
        return new Response("ok");
      },
    });

    await worker.fetch(new Request("https://prick.test/"), {}, ctx);

    expect(seen).toBe(ctx);
  });

  it("keeps concurrent requests' contexts apart", async () => {
    const first = runtimeContext();
    const second = runtimeContext();
    const seen = new Map<string, ExecutionContext>();

    const worker = withExecutionContext({
      async fetch(request: Request) {
        const delay = request.url.endsWith("/first") ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.set(new URL(request.url).pathname, currentExecutionContext());
        return new Response("ok");
      },
    });

    await Promise.all([
      worker.fetch(new Request("https://prick.test/first"), {}, first),
      worker.fetch(new Request("https://prick.test/second"), {}, second),
    ]);

    expect(seen.get("/first")).toBe(first);
    expect(seen.get("/second")).toBe(second);
  });

  it("answers outside a wrapped request with a context that carries no access", () => {
    const ctx = currentExecutionContext() as ExecutionContext & { access?: unknown };

    expect(ctx.access).toBeUndefined();
  });
});
