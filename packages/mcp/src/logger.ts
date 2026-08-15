/**
 * Structured logging for a stdio MCP server.
 *
 * TWO RULES, BOTH LOAD-BEARING.
 *
 * 1. **Everything goes to stderr.** stdout is the MCP transport: it carries
 *    newline-delimited JSON-RPC frames and nothing else. A single stray
 *    `console.log` interleaves a non-JSON-RPC line into that stream and the
 *    client's parser desynchronises -- the failure presents as "the server
 *    stopped responding", which is about as far from its cause as a bug gets.
 *
 * 2. **A secret value is never a log field.** The field type below admits
 *    strings, so this cannot be enforced by the compiler the way the Rust half
 *    of this project enforces it. What it can do is make the safe thing the
 *    obvious thing: every call site in this package logs `key`, `project`,
 *    `environment`, `status` and `request_id`, which are the things that make a
 *    log useful, and none of them is confidential.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * What may appear in a log line.
 *
 * Deliberately narrow. `unknown` would let a caller hand the logger a whole
 * response body or a parsed request, and a request body is where the values
 * are.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /**
   * Where a formatted line goes. Defaults to stderr.
   *
   * Injectable so the tests can assert on what was written -- "no value ever
   * reaches the log" is a property worth a test, and a test cannot make that
   * assertion about a stream it does not hold.
   */
  write?: (line: string) => void;
  /** Injectable clock, so log assertions are not time-dependent. */
  now?: () => Date;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_RANK[options.level];

  function emit(level: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) return;

    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      logger: "prick-mcp",
      msg: message,
    };

    if (fields !== undefined) {
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) record[name] = value;
      }
    }

    write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (message, fields) => {
      emit("debug", message, fields);
    },
    info: (message, fields) => {
      emit("info", message, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, fields);
    },
    error: (message, fields) => {
      emit("error", message, fields);
    },
  };
}
