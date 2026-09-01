/**
 * The library surface.
 *
 * `main.ts` is the executable; this module is what the tests import and what an
 * embedder would use to mount the same tools on a transport other than stdio.
 */

export {
  PrickApiClient,
  toBatchResult,
  toEnvironmentSummary,
  toProjectSummary,
  toSecretListEntry,
  unwrapCollection,
  type BatchResult,
  type EnvironmentSummary,
  type FetchLike,
  type ProjectSummary,
  type SecretListEntry,
} from "./api.ts";

export {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  ENV_NAMES,
  helpText,
  loadConfig,
  normaliseBaseUrl,
  parseAllowReveal,
  parseArgs,
  resolveWorkspaceRoot,
  type Environmentish,
  type ParsedArgs,
  type ServerConfig,
} from "./config.ts";

export { scanDotenvKeys, type DotenvKeyScan } from "./dotenv-keys.ts";

export {
  isToolError,
  scrubEchoedValue,
  toErrorEnvelope,
  ToolError,
  TOOL_ERROR_CODES,
  UNCLASSIFIED_MESSAGE,
  VALUE_ECHO_PLACEHOLDER,
  type ToolErrorCode,
  type ToolErrorDetail,
  type ToolErrorEnvelope,
} from "./errors.ts";

export { createLogger, isLogLevel, LOG_LEVELS, type Logger, type LogLevel } from "./logger.ts";

export { API_PREFIX, routes } from "./routes.ts";

export * from "./schemas.ts";

export { createMcpServer, type CreateServerOptions } from "./server.ts";

export {
  environmentsList,
  projectsList,
  secretsDelete,
  secretsDiff,
  secretsGet,
  secretsList,
  secretsSet,
  type ToolContext,
} from "./tools.ts";

export { SERVER_NAME, SERVER_VERSION, USER_AGENT } from "./version.ts";

export {
  isWithinRoot,
  outsideWorkspace,
  resolveWithinRoot,
  type WorkspacePath,
} from "./workspace.ts";
