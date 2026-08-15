import { ToolError } from "./errors.ts";
import { isLogLevel, type LogLevel } from "./logger.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

/**
 * Configuration, resolved once at startup from the environment and argv.
 *
 * Two things are deliberately absent from the flag surface:
 *
 * - **There is no `--client-secret` flag, and there never will be.** An argument
 *   is visible to every other process on the machine through `ps`, and it lands
 *   in the invoking shell's history. The credential comes from the environment
 *   or it does not come at all. (`--api-url` is fine: a hostname is not a
 *   secret.)
 * - **There is no "reveal just this once" flag that a tool call can set.**
 *   Whether plaintext can leave this process is decided before the transport is
 *   connected, by the operator, and cannot be changed by anything arriving over
 *   the wire.
 */
export interface ServerConfig {
  /** Origin + optional base path, normalised without a trailing slash. */
  apiBaseUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  /**
   * Whether `secrets_get` is registered AT ALL.
   *
   * When false the tool is not merely refused -- it is never advertised in
   * `tools/list`, so a model reading the tool list has no reason to believe
   * revealing a value is something this server can do.
   */
  allowReveal: boolean;
  requestTimeoutMs: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

/** Environment variables consulted, in precedence order, for each setting. */
export const ENV_NAMES = {
  apiUrl: ["PRICK_MCP_API_URL", "PRK_URL"],
  clientId: ["PRICK_MCP_CLIENT_ID", "PRK_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID"],
  clientSecret: ["PRICK_MCP_CLIENT_SECRET", "PRK_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET"],
  allowReveal: ["PRICK_MCP_ALLOW_REVEAL"],
  timeoutMs: ["PRICK_MCP_TIMEOUT_MS"],
  logLevel: ["PRICK_MCP_LOG_LEVEL"],
} as const;

export const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export type Environmentish = Record<string, string | undefined>;

function pick(env: Environmentish, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Parse the accepted flags.
 *
 * Hand-rolled rather than pulled from a library: the surface is four flags, and
 * a dependency here would be a dependency in the published artefact of a
 * secrets tool. `--` terminates parsing.
 */
export interface ParsedArgs {
  allowReveal: boolean;
  apiUrl?: string;
  logLevel?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { allowReveal: false, help: false, version: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") break;

    switch (arg) {
      case "--allow-reveal":
        parsed.allowReveal = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-V":
        parsed.version = true;
        break;
      case "--api-url": {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new ConfigError(
            "--api-url needs a value.",
            `Example: --api-url https://secrets.example.com`,
          );
        }
        parsed.apiUrl = next;
        index += 1;
        break;
      }
      case "--log-level": {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new ConfigError(
            "--log-level needs a value.",
            "One of: debug, info, warn, error, silent.",
          );
        }
        parsed.logLevel = next;
        index += 1;
        break;
      }
      default: {
        if (arg.startsWith("--api-url=")) {
          parsed.apiUrl = arg.slice("--api-url=".length);
          break;
        }
        if (arg.startsWith("--log-level=")) {
          parsed.logLevel = arg.slice("--log-level=".length);
          break;
        }
        throw new ConfigError(
          `Unrecognised argument "${arg}".`,
          "Run with --help for the accepted flags. Credentials are read from the environment and are never accepted as arguments.",
        );
      }
    }
  }

  return parsed;
}

/**
 * Normalise and validate the API base URL.
 *
 * Refuses plaintext `http://` to anything but a loopback host. The credential
 * this server sends on every request is a long-lived Cloudflare Access service
 * token; putting one on the wire in the clear to a remote host is not a
 * configuration choice, it is a disclosure. Loopback is exempt so that
 * `wrangler dev` works.
 *
 * Refuses embedded credentials (`https://user:pass@host`) outright: they would
 * be logged by every proxy in the path and they are not how this API
 * authenticates.
 */
export function normaliseBaseUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      "The API base URL is not a valid absolute URL.",
      "Set it to the origin your Worker is served from, e.g. https://secrets.example.com",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `The API base URL uses the unsupported scheme "${url.protocol}".`,
      "Only http (loopback only) and https are accepted.",
    );
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol === "http:" && !loopback) {
    throw new ConfigError(
      "Refusing to use a plaintext http:// URL for a remote host.",
      "The Access service token is sent on every request. Use https, or point at localhost for a local `wrangler dev`.",
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(
      "The API base URL must not embed credentials.",
      "Remove the user:password@ part. Authentication is the CF-Access-Client-Id / CF-Access-Client-Secret header pair.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      "The API base URL must not carry a query string or fragment.",
      "Give the origin only, e.g. https://secrets.example.com",
    );
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `${ENV_NAMES.timeoutMs[0]} must be a whole number of milliseconds between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}.`,
      `Unset it to use the default of ${String(DEFAULT_TIMEOUT_MS)} ms.`,
    );
  }

  return value;
}

/**
 * `true` and nothing else.
 *
 * Not `1`, not `yes`, not `TRUE`. An opt-in that turns plaintext secrets on
 * should be impossible to trip over: a fuzzy parser means `PRICK_MCP_ALLOW_REVEAL=false`
 * and `PRICK_MCP_ALLOW_REVEAL=off` both risk being read as "set, therefore
 * truthy" by the next person who edits this function.
 */
export function parseAllowReveal(raw: string | undefined): boolean {
  return raw === "true";
}

export function loadConfig(env: Environmentish, argv: readonly string[]): ServerConfig {
  const args = parseArgs(argv);

  const apiUrlRaw = args.apiUrl ?? pick(env, ENV_NAMES.apiUrl);
  const clientId = pick(env, ENV_NAMES.clientId);
  const clientSecret = pick(env, ENV_NAMES.clientSecret);

  const missing: string[] = [];
  if (apiUrlRaw === undefined) missing.push(ENV_NAMES.apiUrl[0]);
  if (clientId === undefined) missing.push(ENV_NAMES.clientId[0]);
  if (clientSecret === undefined) missing.push(ENV_NAMES.clientSecret[0]);

  if (apiUrlRaw === undefined || clientId === undefined || clientSecret === undefined) {
    // FAIL FAST, and say exactly what is missing and what would satisfy it.
    // A stdio MCP server that starts anyway and fails on the first tool call
    // reports its misconfiguration to a language model instead of to the person
    // who can fix it.
    throw new ConfigError(
      `not configured -- ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      [
        "Set these in the `env` block of your MCP client configuration:",
        `  ${ENV_NAMES.apiUrl[0]}       the origin of your deployed Worker, e.g. https://secrets.example.com`,
        `  ${ENV_NAMES.clientId[0]}     the Cloudflare Access service token Client ID`,
        `  ${ENV_NAMES.clientSecret[0]} the matching Client Secret`,
        "",
        `Aliases are accepted for cloudflared parity: ${ENV_NAMES.clientId.join(", ")} and ${ENV_NAMES.clientSecret.join(", ")}.`,
        "The secret is read from the environment only -- there is no flag for it, because arguments are visible in `ps`.",
      ].join("\n"),
    );
  }

  const logLevelRaw = args.logLevel ?? pick(env, ENV_NAMES.logLevel) ?? "info";
  if (!isLogLevel(logLevelRaw)) {
    throw new ConfigError(
      `"${logLevelRaw}" is not a log level.`,
      "One of: debug, info, warn, error, silent.",
    );
  }

  return {
    apiBaseUrl: normaliseBaseUrl(apiUrlRaw),
    accessClientId: clientId,
    accessClientSecret: clientSecret,
    allowReveal: args.allowReveal || parseAllowReveal(pick(env, ENV_NAMES.allowReveal)),
    requestTimeoutMs: parseTimeout(pick(env, ENV_NAMES.timeoutMs)),
    logLevel: logLevelRaw,
  };
}

export function helpText(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    "",
    "A Model Context Protocol server over stdio for a self-hosted secrets manager.",
    "",
    "USAGE",
    `  ${SERVER_NAME} [--api-url <url>] [--allow-reveal] [--log-level <level>]`,
    "",
    "FLAGS",
    "  --api-url <url>     Base URL of the deployed Worker. Overrides PRICK_MCP_API_URL.",
    "  --allow-reveal      Register `secrets_get`, which returns PLAINTEXT SECRET VALUES.",
    "                      Off by default. Equivalent to PRICK_MCP_ALLOW_REVEAL=true.",
    "  --log-level <level> debug | info | warn | error | silent. Default: info.",
    "  -h, --help          Print this and exit.",
    "  -V, --version       Print the version and exit.",
    "",
    "ENVIRONMENT",
    `  ${ENV_NAMES.apiUrl.join(" | ")}`,
    `  ${ENV_NAMES.clientId.join(" | ")}`,
    `  ${ENV_NAMES.clientSecret.join(" | ")}`,
    `  ${ENV_NAMES.allowReveal[0]}    "true" enables secrets_get. Any other value leaves it off.`,
    `  ${ENV_NAMES.timeoutMs[0]}       per-request timeout in ms. Default ${String(DEFAULT_TIMEOUT_MS)}.`,
    `  ${ENV_NAMES.logLevel[0]}        as --log-level.`,
    "",
    "NOTES",
    "  The Access service token secret is read from the environment only. There is",
    "  no flag for it: process arguments are readable by every other process on the",
    "  machine and are recorded in shell history.",
    "",
    "  All logging goes to stderr. stdout carries the MCP transport and nothing else.",
  ].join("\n");
}

/** Kept alongside `ToolError` so the import graph has one error module. */
export function configErrorAsToolError(error: ConfigError): ToolError {
  return new ToolError("CONFIG", error.message, { hint: error.hint });
}
