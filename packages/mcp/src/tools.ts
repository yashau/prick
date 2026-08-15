import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { EnvironmentSummary, PrickApiClient, ProjectSummary, SecretListEntry } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import { scanDotenvKeys } from "./dotenv-keys.ts";
import { scrubEchoedValue, ToolError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { DOTENV_MAX_BYTES } from "./schemas.ts";

/**
 * The tool handlers, as plain functions.
 *
 * They are deliberately not closures created inside the `registerTool` calls:
 * "a secret value never appears on any error path" is the property this package
 * exists to hold, and a property worth holding is a property worth testing
 * directly, without an MCP client and a transport in the way.
 */

export interface ToolContext {
  client: PrickApiClient;
  config: ServerConfig;
  logger: Logger;
  /** Injectable so the diff tool can be tested without touching the disk. */
  readLocalFile?: (path: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Discovery -- no values are involved anywhere in this section
// ---------------------------------------------------------------------------

export interface ProjectsListResult {
  projects: ProjectSummary[];
  count: number;
}

export async function projectsList(ctx: ToolContext): Promise<ProjectsListResult> {
  const projects = await ctx.client.listProjects();
  ctx.logger.info("projects listed", { count: projects.length });
  return { projects, count: projects.length };
}

export interface EnvironmentsListArgs {
  project: string;
}

export interface EnvironmentsListResult {
  project: string;
  environments: EnvironmentSummary[];
  count: number;
}

export async function environmentsList(
  ctx: ToolContext,
  args: EnvironmentsListArgs,
): Promise<EnvironmentsListResult> {
  const environments = await ctx.client.listEnvironments(args.project);
  ctx.logger.info("environments listed", { project: args.project, count: environments.length });
  return { project: args.project, environments, count: environments.length };
}

// ---------------------------------------------------------------------------
// secrets_list -- names and metadata, never values
// ---------------------------------------------------------------------------

export interface SecretsListArgs {
  project: string;
  environment: string;
}

export interface SecretsListResult {
  project: string;
  environment: string;
  secrets: SecretListEntry[];
  count: number;
  /** Keys the server could not decrypt. Surfaced, never quietly dropped. */
  unreadable: string[];
}

export async function secretsList(
  ctx: ToolContext,
  args: SecretsListArgs,
): Promise<SecretsListResult> {
  const secrets = await ctx.client.listSecrets(args.project, args.environment);
  const unreadable = secrets.filter((entry) => entry.unreadable).map((entry) => entry.key);

  ctx.logger.info("secrets listed", {
    project: args.project,
    environment: args.environment,
    count: secrets.length,
    unreadable: unreadable.length,
  });

  if (unreadable.length > 0) {
    // Loud, on purpose. A row that fails its AEAD tag is either a tamper attempt
    // or a master key that was retired too early, and both need a human.
    ctx.logger.error("environment contains secrets that failed to decrypt", {
      project: args.project,
      environment: args.environment,
      keys: unreadable.join(","),
    });
  }

  return {
    project: args.project,
    environment: args.environment,
    secrets,
    count: secrets.length,
    unreadable,
  };
}

// ---------------------------------------------------------------------------
// secrets_set / secrets_delete
// ---------------------------------------------------------------------------

export interface SecretsSetArgs {
  project: string;
  environment: string;
  key: string;
  value: string;
  reason?: string;
}

export interface SecretsSetResult {
  project: string;
  environment: string;
  key: string;
  /** `created` when the key did not exist, `updated` when it did. */
  outcome: "created" | "updated" | "written";
  rev: number | null;
}

/**
 * Write ONE value.
 *
 * The result names the key and the resulting revision and NOTHING about the
 * value -- not its length, not a prefix, not a hash. A length is a real signal
 * about a credential and "it starts with sk-" is most of an identification.
 */
export async function secretsSet(
  ctx: ToolContext,
  args: SecretsSetArgs,
): Promise<SecretsSetResult> {
  let result;

  try {
    result = await ctx.client.setSecret(
      args.project,
      args.environment,
      args.key,
      args.value,
      args.reason,
    );
  } catch (error) {
    // The tripwire. This is the only function in the package that holds a
    // plaintext value and a failure at the same moment, so it is the only one
    // that can check whether the failure quotes the value back.
    const checked = scrubEchoedValue(error, args.value);

    if (checked.scrubbed) {
      ctx.logger.error("the API echoed a submitted secret value in its error response", {
        project: args.project,
        environment: args.environment,
        key: args.key,
      });
    }

    throw checked.error;
  }

  const outcome: SecretsSetResult["outcome"] = result.added.includes(args.key)
    ? "created"
    : result.changed.includes(args.key)
      ? "updated"
      : "written";

  ctx.logger.info("secret written", {
    project: args.project,
    environment: args.environment,
    key: args.key,
    outcome,
    rev: result.rev,
  });

  return {
    project: args.project,
    environment: args.environment,
    key: args.key,
    outcome,
    rev: result.rev,
  };
}

export interface SecretsDeleteArgs {
  project: string;
  environment: string;
  key: string;
  reason?: string;
}

export interface SecretsDeleteResult {
  project: string;
  environment: string;
  key: string;
  removed: boolean;
  rev: number | null;
}

export async function secretsDelete(
  ctx: ToolContext,
  args: SecretsDeleteArgs,
): Promise<SecretsDeleteResult> {
  const result = await ctx.client.deleteSecret(
    args.project,
    args.environment,
    args.key,
    args.reason,
  );

  ctx.logger.info("secret deleted", {
    project: args.project,
    environment: args.environment,
    key: args.key,
    rev: result.rev,
  });

  return {
    project: args.project,
    environment: args.environment,
    key: args.key,
    removed: result.removed.includes(args.key) || result.removed.length === 0,
    rev: result.rev,
  };
}

// ---------------------------------------------------------------------------
// secrets_diff -- key names on both sides, values on neither
// ---------------------------------------------------------------------------

export interface SecretsDiffArgs {
  project: string;
  environment: string;
  env_file: string;
}

export interface SecretsDiffResult {
  project: string;
  environment: string;
  env_file: string;
  only_in_file: string[];
  only_in_environment: string[];
  in_both: string[];
  unreadable_in_environment: string[];
  /** Names declared twice in the local file. The file does not say which wins. */
  duplicate_in_file: string[];
  /** Local names that are not usable environment variable names. */
  invalid_in_file: string[];
  malformed_lines: number[];
  note: string;
}

const DIFF_NOTE =
  "Key names only. No value was read from the environment and no value from the local file was retained, " +
  'so "in_both" means the key exists on both sides -- NOT that the two values agree. There is no way to ' +
  "compare values without revealing them, and this tool does not reveal.";

export async function secretsDiff(
  ctx: ToolContext,
  args: SecretsDiffArgs,
): Promise<SecretsDiffResult> {
  const path = isAbsolute(args.env_file)
    ? args.env_file
    : resolvePath(process.cwd(), args.env_file);

  const read = ctx.readLocalFile ?? readLocalDotenv;
  const source = await read(path);

  const local = scanDotenvKeys(source);
  const remote = await ctx.client.listSecrets(args.project, args.environment);

  const remoteKeys = new Set(remote.map((entry) => entry.key));
  const localKeys = new Set(local.keys);

  const result: SecretsDiffResult = {
    project: args.project,
    environment: args.environment,
    env_file: path,
    only_in_file: local.keys.filter((key) => !remoteKeys.has(key)),
    only_in_environment: remote.map((entry) => entry.key).filter((key) => !localKeys.has(key)),
    in_both: local.keys.filter((key) => remoteKeys.has(key)),
    unreadable_in_environment: remote.filter((entry) => entry.unreadable).map((entry) => entry.key),
    duplicate_in_file: local.duplicates,
    invalid_in_file: local.invalid,
    malformed_lines: local.malformedLines,
    note: DIFF_NOTE,
  };

  ctx.logger.info("environment diffed against a local file", {
    project: args.project,
    environment: args.environment,
    only_in_file: result.only_in_file.length,
    only_in_environment: result.only_in_environment.length,
    in_both: result.in_both.length,
  });

  return result;
}

/**
 * Read a local `.env`.
 *
 * Bounded, and refuses anything that is not a regular file. The size cap is not
 * about memory: a caller who points this at a 4 GB file has made a mistake, and
 * the useful response is to say so rather than to read it.
 */
async function readLocalDotenv(path: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;

  try {
    info = await stat(path);
  } catch {
    // The errno message embeds the path, which is fine, but it also varies by
    // platform. Say the useful thing directly.
    throw new ToolError("LOCAL_FILE", "No such file, or it cannot be read.", {
      path,
      hint: "Give a path relative to the working directory this server was started in, or an absolute path.",
    });
  }

  if (!info.isFile()) {
    throw new ToolError("LOCAL_FILE", "That path is not a regular file.", { path });
  }

  if (info.size > DOTENV_MAX_BYTES) {
    throw new ToolError(
      "LOCAL_FILE",
      `That file is larger than the ${String(DOTENV_MAX_BYTES)} byte limit for a .env.`,
      { path, hint: "Point at the .env itself rather than at a directory listing or an archive." },
    );
  }

  return await readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// secrets_get -- the gated one
// ---------------------------------------------------------------------------

export interface SecretsGetArgs {
  project: string;
  environment: string;
  key: string;
  reason?: "reveal" | "copy" | "export" | "run";
}

/**
 * Return ONE plaintext value.
 *
 * Returns the bare string, not a JSON document. A `{"key": ..., "value": ...}`
 * wrapper reads as a record, and a record is a thing an assistant summarises,
 * quotes and writes to a file. A bare value is a thing it uses.
 *
 * There is a second, redundant gate here. `secrets_get` is not registered at all
 * unless reveal is enabled, so this branch is unreachable through the MCP
 * transport -- it exists because the handler is also a plain exported function,
 * and an exported function that returns plaintext should carry its own guard
 * rather than rely on every future caller knowing about the one in `server.ts`.
 */
export async function secretsGet(ctx: ToolContext, args: SecretsGetArgs): Promise<string> {
  if (!ctx.config.allowReveal) {
    throw new ToolError(
      "REVEAL_DISABLED",
      "Revealing plaintext secret values is disabled on this server.",
      {
        project: args.project,
        environment: args.environment,
        key: args.key,
        hint: "An operator must start the server with PRICK_MCP_ALLOW_REVEAL=true or --allow-reveal. Use secrets_list to see which keys exist, or secrets_diff to compare against a local file.",
      },
    );
  }

  const reason = args.reason ?? "reveal";
  const value = await ctx.client.revealSecret(args.project, args.environment, args.key, reason);

  // The KEY and the REASON are logged. The value is not, and there is no log
  // level at which it would be.
  ctx.logger.warn("secret value revealed", {
    project: args.project,
    environment: args.environment,
    key: args.key,
    reason,
  });

  return value;
}
