import type { FetchLike } from "../src/api.ts";
import type { ServerConfig } from "../src/config.ts";
import { createLogger, type Logger } from "../src/logger.ts";

export function stubConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiBaseUrl: "https://secrets.example.com",
    accessClientId: "test-client-id.access",
    accessClientSecret: "test-client-secret",
    allowReveal: false,
    workspaceRoot: process.cwd(),
    requestTimeoutMs: 5_000,
    logLevel: "debug",
    ...overrides,
  };
}

export interface CapturedLogger {
  logger: Logger;
  lines: string[];
  /** Everything written, as one string, for substring assertions. */
  text(): string;
}

/**
 * A logger that keeps what it wrote.
 *
 * "No secret value ever reaches the log" is a property, and a property is only
 * tested if something holds the log.
 */
export function capturingLogger(): CapturedLogger {
  const lines: string[] = [];

  return {
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    lines,
    text: () => lines.join(""),
  };
}

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StubFetch {
  fetch: FetchLike;
  calls: StubCall[];
}

export function stubFetch(
  handler: (call: StubCall) => Response | Promise<Response> | never,
): StubFetch {
  const calls: StubCall[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[name] = value;
      }

      const call: StubCall = {
        url,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
      };
      calls.push(call);

      return await handler(call);
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}
