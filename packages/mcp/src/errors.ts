/**
 * The one error type every tool handler throws, and the envelope every failed
 * tool call returns.
 *
 * THE SHAPE IS THE ENFORCEMENT.
 *
 * `ToolErrorDetail` has no field a secret value could be assigned to. There is
 * no `value`, no `body`, no `input`, no `cause` that gets serialised. A handler
 * under time pressure cannot reach for "just include what we sent, it helps
 * debugging", because there is nowhere to put it. Everything the envelope
 * carries -- project slug, environment slug, key name, HTTP status, request id
 * -- is plaintext metadata that the caller supplied or that the server prints in
 * its own audit log.
 *
 * Key NAMES are deliberately included. A key name is not confidential anywhere
 * in this system: it is what the list tool returns, what the UI renders and what
 * the audit log records. Without it, "the write failed" gives the assistant
 * nothing to act on.
 */

export const TOOL_ERROR_CODES = [
  /** The server is not configured; nothing can talk to the API. */
  "CONFIG",
  /** The request never reached the API: DNS, TLS, timeout, connection refused. */
  "TRANSPORT",
  /** The API answered with a status this tool cannot interpret as success. */
  "API",
  /** Arguments were structurally fine but semantically unacceptable. */
  "INVALID_INPUT",
  /** A local file could not be read, or is not a file. */
  "LOCAL_FILE",
  /** `secrets_get` was invoked while reveal is disabled. */
  "REVEAL_DISABLED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorDetail {
  /** Actionable next step. Never a value; never an echo of the request body. */
  hint?: string;
  /** HTTP status, when one was received. */
  status?: number;
  /** The API's own machine code from its error envelope (e.g. `NOT_FOUND`). */
  api_code?: string;
  /** `X-Request-Id`, so an operator can find the exact audit row. */
  request_id?: string;
  project?: string;
  environment?: string;
  /** The KEY the operation concerned. Never the value stored under it. */
  key?: string;
  /** A local filesystem path, for `secrets_diff`. Never file contents. */
  path?: string;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly detail: ToolErrorDetail;

  constructor(code: ToolErrorCode, message: string, detail: ToolErrorDetail = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/**
 * The ONLY message an unclassified failure may carry.
 *
 * A constant, not a template. By definition nothing has established what the
 * `message` of an unrecognised throwable contains -- `fetch` rejections and
 * JSON parse errors both quote fragments of what they were handed -- and
 * "include the underlying message, it is useful" is precisely how a value
 * reaches a transcript.
 */
export const UNCLASSIFIED_MESSAGE =
  "The operation failed for an unrecognised reason. Nothing was written.";

/**
 * Placeholder substituted for a value the SERVER handed back to us.
 *
 * See `scrubEchoedValue`.
 */
export const VALUE_ECHO_PLACEHOLDER = "[REDACTED: the server echoed the submitted value back]";

/**
 * Shorter than this and the tripwire is not armed.
 *
 * A three-character value would match inside ordinary English words and turn
 * every error message into confetti, which is its own kind of failure. Four is
 * the point at which an accidental match stops being the common case; anything
 * shorter than four characters is not a credential.
 */
const TRIPWIRE_MIN_LENGTH = 4;

/**
 * Last-ditch guard: refuse to forward a value the server sent back to us.
 *
 * The API contract says its zod error formatter drops `issue.input`, and the
 * client in `api.ts` only ever quotes fields from that documented envelope. Both
 * of those are promises made by a DIFFERENT package, on the other side of a
 * network boundary, by code that is still being written.
 *
 * `secrets_set` is the one place in this server that holds a plaintext value and
 * an error at the same time, so it is the one place that can check. If the value
 * it just sent appears anywhere in the error it got back, that text does not
 * reach the model -- it is replaced, and the fact is logged at `error`, because
 * a server that echoes submitted secrets in its error bodies is a defect
 * somebody needs to hear about.
 */
export function scrubEchoedValue(
  error: unknown,
  value: string,
): { error: unknown; scrubbed: boolean } {
  if (value.length < TRIPWIRE_MIN_LENGTH) return { error, scrubbed: false };
  if (!isToolError(error)) return { error, scrubbed: false };

  const replace = (text: string): string => text.split(value).join(VALUE_ECHO_PLACEHOLDER);

  const message = replace(error.message);
  const detail: ToolErrorDetail = { ...error.detail };

  if (detail.hint !== undefined) detail.hint = replace(detail.hint);

  const scrubbed = message !== error.message || detail.hint !== error.detail.hint;
  if (!scrubbed) return { error, scrubbed: false };

  return { error: new ToolError(error.code, message, detail), scrubbed: true };
}

export interface ToolErrorEnvelope {
  ok: false;
  error: {
    code: ToolErrorCode;
    message: string;
  } & ToolErrorDetail;
}

/**
 * Normalise anything thrown inside a tool handler into the error envelope.
 *
 * An unrecognised throwable becomes a bare `API`-less failure with the constant
 * message above. Its own text is discarded, not appended.
 */
export function toErrorEnvelope(error: unknown): ToolErrorEnvelope {
  if (isToolError(error)) {
    const detail: ToolErrorDetail = {};
    for (const [name, value] of Object.entries(error.detail)) {
      if (value !== undefined) Object.assign(detail, { [name]: value });
    }

    return { ok: false, error: { code: error.code, message: error.message, ...detail } };
  }

  return { ok: false, error: { code: "TRANSPORT", message: UNCLASSIFIED_MESSAGE } };
}
