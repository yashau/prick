/**
 * A `.env` scanner that reads KEY NAMES and nothing else.
 *
 * This is not a `.env` parser with the values thrown away afterwards. It never
 * builds a value string in the first place: when it reaches the `=` it works out
 * where the value ends -- which requires tracking quoting, because a quoted
 * value may span lines and may contain a `#` or an `=` -- and skips the cursor
 * past it. No accumulator exists for a value to be appended to.
 *
 * That distinction is the entire reason `secrets_diff` is safe to hand to a
 * language model. A parser that returns `{key, value}` and a caller that
 * promises to only read `.key` is one refactor away from leaking a developer's
 * whole local environment into a transcript; a scanner with no value in its
 * return type is not.
 *
 * The quoting rules mirror the server's own strict `.env` parser closely enough
 * that the two agree on where a value ends. Where they differ, this one is more
 * forgiving: a malformed line is reported, not thrown, because refusing to diff
 * a file over a bad line on line 200 is worse than diffing the other 199.
 */

/** POSIX environment variable name, matching the server's `SecretKey`. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DotenvKeyScan {
  /** Valid key names, in file order, with duplicates collapsed. */
  keys: string[];
  /** Names declared more than once. The file does not say which was meant. */
  duplicates: string[];
  /** Names that are not usable environment variable names. */
  invalid: string[];
  /** 1-based line numbers that are neither blank, comment, nor `KEY=`. */
  malformedLines: number[];
}

interface Cursor {
  readonly text: string;
  index: number;
  line: number;
}

export function scanDotenvKeys(source: string): DotenvKeyScan {
  // A UTF-8 BOM ahead of the first key turns `KEY` into an invisible-prefixed
  // name that fails the POSIX check for reasons no editor will show you.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const cursor: Cursor = { text, index: 0, line: 1 };

  const seen = new Set<string>();
  const keys: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const malformedLines: number[] = [];

  while (cursor.index < text.length) {
    skipBlank(cursor);
    if (cursor.index >= text.length) break;

    const declaredOn = cursor.line;
    const name = readName(cursor);

    if (name === null) {
      malformedLines.push(declaredOn);
      continue;
    }

    skipValue(cursor);

    if (!KEY_PATTERN.test(name)) {
      if (!invalid.includes(name)) invalid.push(name);
      continue;
    }

    if (seen.has(name)) {
      if (!duplicates.includes(name)) duplicates.push(name);
      continue;
    }

    seen.add(name);
    keys.push(name);
  }

  return { keys, duplicates, invalid, malformedLines };
}

function skipBlank(cursor: Cursor): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];

    if (char === "\n") {
      cursor.index += 1;
      cursor.line += 1;
      continue;
    }

    if (char === "\r" || char === " " || char === "\t") {
      cursor.index += 1;
      continue;
    }

    if (char === "#") {
      skipToEndOfLine(cursor);
      continue;
    }

    return;
  }
}

function skipToEndOfLine(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && cursor.text[cursor.index] !== "\n") {
    cursor.index += 1;
  }
}

/**
 * Read the name up to the `=`, leaving the cursor just past it.
 *
 * Returns `null` for a line with no `=`, having consumed the line. `export ` is
 * accepted and discarded: half the `.env` files in existence were written to be
 * `source`d by a shell.
 */
function readName(cursor: Cursor): string | null {
  const start = cursor.index;

  skipToEndOfLine(cursor);
  const rawLine = cursor.text.slice(start, cursor.index).replace(/\r$/, "");

  const equals = rawLine.indexOf("=");
  if (equals === -1) return null;

  let name = rawLine.slice(0, equals).trim();
  if (name.startsWith("export ") || name.startsWith("export\t")) {
    name = name.slice("export".length).trim();
  }

  // Rewind to just past the `=`. The line counter is untouched -- the scan above
  // never crossed a newline.
  cursor.index = start + equals + 1;

  return name;
}

/**
 * Advance the cursor past the value. NOTHING IS RETURNED.
 *
 * Quoting has to be tracked even though the content is discarded, because it is
 * what decides where the value ENDS: an unquoted value stops at the newline, a
 * quoted one does not, and mistaking the second for the first makes the next
 * line of a multi-line private key look like a new key declaration.
 */
function skipValue(cursor: Cursor): void {
  while (cursor.text[cursor.index] === " " || cursor.text[cursor.index] === "\t") {
    cursor.index += 1;
  }

  const opener = cursor.text[cursor.index];

  if (opener === '"') {
    cursor.index += 1;

    while (cursor.index < cursor.text.length) {
      const char = cursor.text[cursor.index];

      if (char === "\\") {
        if (cursor.text[cursor.index + 1] === "\n") cursor.line += 1;
        cursor.index += 2;
        continue;
      }

      if (char === '"') {
        cursor.index += 1;
        skipToEndOfLine(cursor);
        return;
      }

      if (char === "\n") cursor.line += 1;
      cursor.index += 1;
    }

    return;
  }

  if (opener === "'") {
    cursor.index += 1;

    while (cursor.index < cursor.text.length) {
      const char = cursor.text[cursor.index];

      if (char === "'") {
        cursor.index += 1;
        skipToEndOfLine(cursor);
        return;
      }

      if (char === "\n") cursor.line += 1;
      cursor.index += 1;
    }

    return;
  }

  skipToEndOfLine(cursor);
}
