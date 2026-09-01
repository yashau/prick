import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PrickApiClient, type FetchLike } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import { toErrorEnvelope } from "./errors.ts";
import type { Logger } from "./logger.ts";
import {
  ReasonInput,
  RevealReasonInput,
  SecretKeyInput,
  SecretValueInput,
  SlugInput,
} from "./schemas.ts";
import {
  environmentsList,
  projectsList,
  secretsDelete,
  secretsDiff,
  secretsGet,
  secretsList,
  secretsSet,
  type ToolContext,
} from "./tools.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";
import { z } from "zod";

/**
 * ---------------------------------------------------------------------------
 * THE SECURITY POSTURE, IN ONE PLACE
 * ---------------------------------------------------------------------------
 * An MCP server hands tool access to a language model. For a secrets manager
 * that is a genuine hazard, so the default posture here is WRITE-MOSTLY,
 * READ-RARELY:
 *
 *   secrets_list     names and metadata, never values. The tool an assistant
 *                    should reach for constantly. Always registered.
 *   secrets_set      writes a value. The common, safe case: an assistant that
 *                    just generated a credential, or that was handed one.
 *   secrets_delete   removes a key. Destructive, and annotated as such.
 *   secrets_diff     compares KEY NAMES against a local .env. Leaks nothing on
 *                    either side.
 *   secrets_get      returns PLAINTEXT. Off unless the operator opted in.
 *
 * The gate on `secrets_get` is REGISTRATION, not a check inside the handler.
 * A tool that is registered and then refuses is still a tool the model can see
 * in `tools/list`, and a model that can see it will reason about how to get it
 * allowed -- it will ask the user to enable it, or it will look for another
 * route to the same data. A tool that was never registered does not exist as far
 * as the model is concerned, and the question never arises.
 *
 * That is why `createMcpServer` branches on `config.allowReveal` around the
 * `registerTool` call rather than inside the callback.
 */

const CONFIDENTIALITY =
  "Secret VALUES are confidential: never echo one into the conversation, a summary, a commit " +
  "message, a code comment, a log line, or any file you write.";

const INSTRUCTIONS = [
  "This server manages secrets for a self-hosted secrets manager running on Cloudflare Workers and D1.",
  "",
  "Work from KEY NAMES. `secrets_list` returns names and metadata and never a value; `secrets_diff`",
  "compares names against a local .env and reads no value on either side. Between them they answer",
  'almost every real question -- "is it configured?", "what is my .env missing?", "which keys does',
  'production have that staging does not?" -- with nothing confidential in the answer.',
  "",
  "Writing is the safe direction. When you generate a credential or the user gives you one, put it",
  "straight into `secrets_set` and then forget it: confirm by naming the key, never by repeating the",
  "value.",
  "",
  CONFIDENTIALITY,
  "",
  "Every mutation is recorded in the server's audit log against this server's identity, so an operator",
  "can see exactly what was changed and when.",
].join("\n");

export interface CreateServerOptions {
  config: ServerConfig;
  logger: Logger;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to a real client built from `config`. */
  client?: PrickApiClient;
}

/**
 * Wrap a handler so that every failure becomes a structured, value-free result.
 *
 * `isError: true` rather than a thrown exception: a thrown exception becomes a
 * JSON-RPC protocol error, which the model does not see as a tool outcome it can
 * reason about. A structured error it can read is what turns "403" into "ask the
 * operator to grant this service token" instead of a retry loop.
 */
async function runTool<T>(
  name: string,
  logger: Logger,
  handler: () => Promise<T>,
  render: (value: T) => string,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: "text", text: render(await handler()) }] };
  } catch (error) {
    const envelope = toErrorEnvelope(error);

    // The envelope is what is logged, because the envelope is the thing that has
    // been constructed to contain no value. Logging `error` itself would put an
    // arbitrary throwable's message into the log.
    logger.warn("tool failed", {
      tool: name,
      code: envelope.error.code,
      status: envelope.error.status,
      api_code: envelope.error.api_code,
      request_id: envelope.error.request_id,
      project: envelope.error.project,
      environment: envelope.error.environment,
      key: envelope.error.key,
    });

    return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }], isError: true };
  }
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

export function createMcpServer(options: CreateServerOptions): McpServer {
  const { config, logger } = options;

  const client = options.client ?? new PrickApiClient(config, logger, options.fetchImpl);
  const ctx: ToolContext = { client, config, logger };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  server.registerTool(
    "projects_list",
    {
      title: "List projects",
      description: [
        "List every project this server's identity can see, with slugs, names and how many environments each has.",
        "",
        "Discovery metadata only: no secret value is read or returned. Start here when you do not already know the `project` slug the other tools need.",
      ].join("\n"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    () => runTool("projects_list", logger, () => projectsList(ctx), asJson),
  );

  server.registerTool(
    "environments_list",
    {
      title: "List environments",
      description: [
        "List the environments inside one project (dev, staging, production, ...), with the number of keys in each and the environment's current revision.",
        "",
        "No secret value is read or returned.",
      ].join("\n"),
      inputSchema: {
        project: SlugInput.describe("Project slug, as returned by projects_list."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => runTool("environments_list", logger, () => environmentsList(ctx, args), asJson),
  );

  // -------------------------------------------------------------------------
  // The tool to reach for constantly
  // -------------------------------------------------------------------------

  server.registerTool(
    "secrets_list",
    {
      title: "List secret keys (names only)",
      description: [
        "List the KEY NAMES and metadata of the secrets stored in one environment.",
        "",
        "This tool NEVER returns a value, and there is no argument that would make it. Use it freely and prefer it to anything that reveals plaintext: almost every real question is answered by names alone -- is DATABASE_URL set in production, which keys does staging have that dev does not, when was STRIPE_KEY last rotated and by whom.",
        "",
        "Entries flagged `unreadable: true` failed to decrypt on the server. That is either tampering or a master key that was retired too early. Report them to the operator; do not treat them as absent.",
        "",
        CONFIDENTIALITY,
      ].join("\n"),
      inputSchema: {
        project: SlugInput.describe("Project slug."),
        environment: SlugInput.describe("Environment slug within that project."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => runTool("secrets_list", logger, () => secretsList(ctx, args), asJson),
  );

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  server.registerTool(
    "secrets_set",
    {
      title: "Set a secret value",
      description: [
        "Create or update ONE secret in an environment. This is the normal, safe way to handle a credential: generate it or take it from the user, write it here, and then let go of it.",
        "",
        `${CONFIDENTIALITY} That applies to a value you generated yourself. Confirm the write by naming the KEY and the environment -- never by repeating the value back, not even partially.`,
        "",
        "If you are generating the value, use a cryptographically secure random source and a length appropriate to the credential.",
        "",
        "The write is a merge applied in one atomic server-side transaction: no other key in the environment is touched, and the previous value is kept as a version, so an operator can roll a mistake back.",
      ].join("\n"),
      inputSchema: {
        project: SlugInput.describe("Project slug."),
        environment: SlugInput.describe("Environment slug within that project."),
        key: SecretKeyInput.describe(
          "The key name, e.g. DATABASE_URL. Key names are not confidential.",
        ),
        value: SecretValueInput.describe(
          "The secret value. THIS IS CONFIDENTIAL: it must not be repeated in your response, written to a file, or included in a summary.",
        ),
        reason: ReasonInput.optional().describe(
          'Short note recorded verbatim in the audit log, e.g. "rotating after the incident". Must not contain the value.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Not destructive: the server keeps every prior version and an operator
        // can roll back, so no write through this tool destroys data.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => runTool("secrets_set", logger, () => secretsSet(ctx, args), asJson),
  );

  server.registerTool(
    "secrets_delete",
    {
      title: "Delete a secret key",
      description: [
        "Remove ONE key from an environment.",
        "",
        "The version history is retained on the server as a tombstone, but the key stops being served to anything reading the environment immediately. Deleting a key a running service depends on is an outage, not a tidy-up.",
        "",
        "Confirm with the user before deleting a key you did not create in this session, and use secrets_list first if you are unsure whether it is still in use.",
      ].join("\n"),
      inputSchema: {
        project: SlugInput.describe("Project slug."),
        environment: SlugInput.describe("Environment slug within that project."),
        key: SecretKeyInput.describe("The key name to remove."),
        reason: ReasonInput.optional().describe(
          'Short note recorded verbatim in the audit log, e.g. "superseded by DATABASE_URL_V2".',
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => runTool("secrets_delete", logger, () => secretsDelete(ctx, args), asJson),
  );

  // -------------------------------------------------------------------------
  // Diff -- names on both sides, values on neither
  // -------------------------------------------------------------------------

  server.registerTool(
    "secrets_diff",
    {
      title: "Diff a local .env against an environment (names only)",
      description: [
        "Compare the key names in a local .env file against the keys stored in an environment, and report which are only local, only remote, or present on both sides.",
        "",
        "No value is read from the server, and no value from the local file is retained -- the local scanner extracts names and skips over values without ever building one. Nothing confidential moves in either direction, so this is safe to run at any time.",
        "",
        'Because of that, "in_both" means the key exists on both sides. It does NOT mean the two values agree, and there is no way to check that without revealing a value.',
        "",
        'Use this to answer "what is my .env missing before I deploy?" without reading a single credential.',
        "",
        "The file must be inside the directory this server was started in. A path that leaves it is refused, so this cannot be pointed at a dotfile elsewhere on the machine.",
      ].join("\n"),
      inputSchema: {
        project: SlugInput.describe("Project slug."),
        environment: SlugInput.describe("Environment slug within that project."),
        env_file: z
          .string()
          .min(1)
          .describe(
            "Path to the local .env file, relative to the working directory this server was started in. It must resolve to a file inside that directory: `..`, an absolute path elsewhere and a symbolic link leading out are all refused.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => runTool("secrets_diff", logger, () => secretsDiff(ctx, args), asJson),
  );

  // -------------------------------------------------------------------------
  // The gated one. NOT REGISTERED unless the operator opted in.
  // -------------------------------------------------------------------------

  if (config.allowReveal) {
    logger.warn(
      "secrets_get is REGISTERED: this server can return plaintext secret values to a model",
      { tool: "secrets_get" },
    );

    server.registerTool(
      "secrets_get",
      {
        title: "Reveal a secret value (PLAINTEXT)",
        description: [
          "Reveal the plaintext value of ONE secret. THE RESULT IS A LIVE CREDENTIAL.",
          "",
          "This tool is disabled by default and an operator has explicitly enabled it here. Treat every use as a deliberate exception:",
          "",
          "- Do not print the value, quote it, summarise it, or describe its contents or its length.",
          "- Do not write it into a file, a commit, a comment, a shell command line, or an environment dump.",
          "- Do not retain it beyond the single step that needs it, and do not call again to re-check a value you already have.",
          '- Prefer secrets_list (names only) or secrets_diff. If the question is "is it set?" or "what is missing?", those answer it and this does not need to be called at all.',
          "",
          "Every reveal is written to the server's audit log against this server's identity, together with the `reason` you pass.",
        ].join("\n"),
        inputSchema: {
          project: SlugInput.describe("Project slug."),
          environment: SlugInput.describe("Environment slug within that project."),
          key: SecretKeyInput.describe("The key name to reveal."),
          reason: RevealReasonInput.optional().describe(
            'Why the value is needed. Recorded in the audit log so an operator can tell a look from a copy. Defaults to "reveal".',
          ),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      // The value is returned as-is rather than wrapped in JSON: a record is a
      // thing that gets summarised and quoted, a bare value is a thing that gets
      // used.
      (args) =>
        runTool(
          "secrets_get",
          logger,
          () => secretsGet(ctx, args),
          (value) => value,
        ),
    );
  } else {
    logger.info("secrets_get is not registered; plaintext reveal is disabled", {
      hint: "Set PRICK_MCP_ALLOW_REVEAL=true or pass --allow-reveal to enable it.",
    });
  }

  return server;
}
