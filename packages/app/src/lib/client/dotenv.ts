/**
 * `.env` serialisation for the export path.
 *
 * The rules are the same ones the CLI's `env` output format uses, and they are
 * rules rather than preferences:
 *
 *   - EVERY value is double-quoted, unconditionally. A bare value is only safe
 *     until it contains a space, a `#`, or a trailing backslash, and "quote it
 *     when it looks like it needs quoting" is how a parser and a writer end up
 *     disagreeing about one edge case in ten thousand rows.
 *   - Only backslash, double quote, newline, carriage return and tab are
 *     escaped. Raw UTF-8 otherwise -- never `\uXXXX`, which most `.env` parsers
 *     in the wild do not implement and will hand back to you literally.
 *   - Any other C0 control character is UNREPRESENTABLE. The export fails
 *     naming the key rather than emitting a line that some parsers will read
 *     one way and others another.
 */

export class UnrepresentableValueError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `${key} contains a control character that cannot be written to a .env file without ambiguity.`,
    );
    this.name = "UnrepresentableValueError";
    this.key = key;
  }
}

/** Tab, LF and CR -- the only three control characters `.env` can express. */
const ESCAPABLE_CONTROLS = new Set([9, 10, 13]);

/**
 * Scanned by code point rather than matched with a regex.
 *
 * A character class of C0 controls has to be written either with literal
 * control bytes -- invisible in every diff the file ever appears in -- or with
 * `\u` escapes that then need a lint suppression. Comparing numbers is the
 * version a reviewer can actually check.
 */
function isUnrepresentable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (ESCAPABLE_CONTROLS.has(code)) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function escapeValue(key: string, value: string): string {
  if (isUnrepresentable(value)) throw new UnrepresentableValueError(key);

  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/**
 * Render a whole environment as `.env` text.
 *
 * Keys are sorted so that two exports of the same environment produce
 * byte-identical files and a diff between two environments is readable.
 */
export function toDotenv(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .sort()
    .map((key) => `${key}="${escapeValue(key, values[key] ?? "")}"`);
  return `${lines.join("\n")}\n`;
}

/** The same environment as sorted, stable JSON. */
export function toJson(values: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key] ?? "";
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Hand the browser a file.
 *
 * An object URL rather than a `data:` URL because a `data:` URL is a navigable
 * document under some handlers, and the CSP here is `default-src 'none'`. The
 * URL is revoked on the next task: revoking synchronously races the download in
 * WebKit, and never revoking leaks the plaintext for the lifetime of the tab.
 */
export function downloadText(filename: string, contents: string, type = "text/plain"): void {
  const blob = new Blob([contents], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";

  // `appendChild`/`removeChild` rather than `append`/`remove`: the generated
  // `worker-configuration.d.ts` declares a global `Element` for HTMLRewriter
  // whose `append` takes a string, and interface merging makes the DOM methods
  // of the same name ambiguous in this program.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 0);
}
