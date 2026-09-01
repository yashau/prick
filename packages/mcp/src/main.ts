#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, helpText, loadConfig, parseArgs } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createMcpServer } from "./server.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

/**
 * The executable.
 *
 * Exit codes follow sysexits(3), because an MCP client shows the operator a
 * failed process and little else, and a distinguishable code is the one signal
 * that survives:
 *
 *   0   clean shutdown
 *   70  EX_SOFTWARE -- an unexpected internal failure
 *   78  EX_CONFIG   -- misconfigured; the message on stderr says which variable
 */
const EXIT_INTERNAL = 70;
const EXIT_CONFIG = 78;

/**
 * Make stdout unreachable through `console`.
 *
 * stdout is the MCP transport: newline-delimited JSON-RPC and nothing else. One
 * `console.log` -- ours, a dependency's, or a stack trace printed by something
 * helpful -- interleaves a non-JSON line into the frame stream and the client's
 * parser desynchronises. The symptom is "the server stopped responding", which
 * is nowhere near the cause.
 *
 * Nothing in this package calls `console`; the logger writes to stderr
 * directly. This exists for everything that is not this package.
 */
function redirectConsoleToStderr(): void {
  const write = (...args: unknown[]): void => {
    void process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`);
  };

  const target = console as unknown as Record<string, unknown>;
  for (const name of ["log", "info", "debug", "warn", "error", "trace", "dir", "table", "group"]) {
    target[name] = write;
  }
}

async function main(): Promise<void> {
  redirectConsoleToStderr();

  const argv = process.argv.slice(2);

  // --help and --version are answered before configuration is resolved, so that
  // an operator who has not set the environment up yet can still discover what
  // to set. Both go to stderr: stdout belongs to the transport even here, since
  // a client may have already attached to it.
  let early;
  try {
    early = parseArgs(argv);
  } catch (error) {
    return failConfig(error);
  }

  if (early.help) {
    process.stderr.write(`${helpText()}\n`);
    return;
  }

  if (early.version) {
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig(process.env, argv);
  } catch (error) {
    return failConfig(error);
  }

  const logger = createLogger({ level: config.logLevel });

  logger.info("starting", {
    version: SERVER_VERSION,
    api_base_url: config.apiBaseUrl,
    allow_reveal: config.allowReveal,
    // Logged so an operator can see what `secrets_diff` is confined to without
    // having to work out what the client set as the working directory.
    workspace_root: config.workspaceRoot,
    timeout_ms: config.requestTimeoutMs,
  });

  const server = createMcpServer({ config, logger });
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    void server.close().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await server.connect(transport);
  logger.info("connected on stdio");
}

function failConfig(error: unknown): never {
  if (error instanceof ConfigError) {
    process.stderr.write(`${SERVER_NAME}: ${error.message}\n\n${error.hint}\n`);
    process.exit(EXIT_CONFIG);
  }

  process.stderr.write(`${SERVER_NAME}: failed to start.\n`);
  process.exit(EXIT_INTERNAL);
}

main().catch((error: unknown) => {
  // The message of an unclassified throwable is not printed. By definition
  // nothing has established what it contains, and this process handles
  // credentials.
  process.stderr.write(
    `${SERVER_NAME}: an unexpected error occurred during startup. Run with --log-level debug for detail.\n`,
  );
  if (process.env["PRICK_MCP_LOG_LEVEL"] === "debug" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  process.exit(EXIT_INTERNAL);
});
