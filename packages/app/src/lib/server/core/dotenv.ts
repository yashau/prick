import { SecretKey } from "@prick/shared";

import { PrickError } from "./errors.js";

/**
 * A strict `.env` parser.
 *
 * "Strict" is the entire specification. Every `.env` parser in the wild is
 * lenient in a different direction, and leniency in a secrets manager is not a
 * convenience -- it is a class of outage. The three decisions that follow from
 * that:
 *
 * 1. **NO `$VAR` INTERPOLATION. AT ALL.**
 *    Several popular parsers expand `$OTHER` / `${OTHER}` inside double quotes.
 *    Here they do not, and there is no flag to make them. Consider what silent
 *    interpolation means for this product: a value of `$aB3!x$k` is a perfectly
 *    ordinary generated password, and an interpolating parser stores it as
 *    `$aB3!x` plus whatever `$k` happened to resolve to -- usually the empty
 *    string. The secret is now WRONG, it is wrong in a way that still looks like
 *    a password, and nothing anywhere reports an error. A parser that stores
 *    what the file says cannot do that.
 *
 *    A `${...}` sequence still produces a WARNING, because someone migrating
 *    from an interpolating tool needs to be told their file will not mean what
 *    it used to. The warning names the LINE and never the text.
 *
 * 2. **Every failure carries a line number.** "Invalid .env file" for a 300-line
 *    paste is not a diagnosis.
 *
 * 3. **A duplicate key is an ERROR, not last-one-wins.** A file that sets
 *    `DATABASE_URL` twice is a file whose author has already lost track of it;
 *    silently picking one is picking which of two production databases the
 *    deploy talks to.
 *
 * CRLF is tolerated everywhere, including inside a quoted multi-line value,
 * where it is NORMALISED to `\n`. A secret's bytes must not depend on whether
 * the file came off a Windows checkout.
 *
 * Multi-line values are possible ONLY inside quotes. A bare newline ends an
 * unquoted value, always.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line the key was declared on. */
  line: number;
}

export interface DotenvWarning {
  line: number;
  key: string;
  message: string;
}

export interface DotenvDocument {
  entries: DotenvEntry[];
  /** Non-fatal observations. The UI shows these on the import dry-run screen. */
  warnings: DotenvWarning[];
}

/**
 * A parse failure, carrying the line it happened on.
 *
 * `VALIDATION_FAILED` (422) rather than `BAD_REQUEST`: the request was
 * well-formed HTTP carrying a well-formed body; it is the CONTENT of a field
 * that is unacceptable, which is exactly what 422 means.
 *
 * THE MESSAGE NEVER QUOTES THE LINE. It says what is wrong and where, and stops
 * -- the offending line of a `.env` file is, by construction, a line containing
 * a secret, and this message travels into an HTTP response and a Worker log.
 */
export class DotenvParseError extends PrickError {
  readonly line: number;

  constructor(line: number, message: string, hint?: string) {
    super("VALIDATION_FAILED", `Line ${String(line)}: ${message}`, {
      ...(hint === undefined ? {} : { hint }),
      detail: { line },
    });
    this.name = "DotenvParseError";
    this.line = line;
  }
}

/** Recognised escapes inside a double-quoted value. */
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  f: "\f",
  b: "\b",
  '"': '"',
  "'": "'",
  "\\": "\\",
  $: "$",
  "`": "`",
};

interface Cursor {
  readonly text: string;
  index: number;
  line: number;
}

export function parseDotenv(source: string): DotenvDocument {
  // A UTF-8 BOM in front of the first key turns `KEY` into `﻿KEY`, which
  // then fails the POSIX name check with a message about an invalid character
  // that is invisible in every editor.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const cursor: Cursor = { text, index: 0, line: 1 };
  const entries: DotenvEntry[] = [];
  const warnings: DotenvWarning[] = [];
  const seen = new Map<string, number>();

  while (cursor.index < cursor.text.length) {
    skipBlank(cursor);
    if (cursor.index >= cursor.text.length) break;

    const declaredOn = cursor.line;
    const key = readKey(cursor);
    const value = readValue(cursor, key);

    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new DotenvParseError(
        declaredOn,
        `duplicate key "${key}", already set on line ${String(previous)}.`,
        "Remove one of the two declarations. This file does not say which value you meant.",
      );
    }
    seen.set(key, declaredOn);

    if (/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) {
      warnings.push({
        line: declaredOn,
        key,
        // Names the KEY (plaintext metadata) and never any part of the value.
        message:
          "value contains a $VAR-like sequence and will be stored literally -- this parser performs no interpolation.",
      });
    }

    entries.push({ key, value, line: declaredOn });
  }

  return { entries, warnings };
}

/** Advance past whitespace, blank lines and whole-line comments. */
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
 * Read `KEY` (optionally behind `export `) up to and including the `=`.
 *
 * `export ` is accepted because half the `.env` files in existence were written
 * to be `source`d by a shell. It is accepted and then DISCARDED -- it carries no
 * meaning here.
 */
function readKey(cursor: Cursor): string {
  const startLine = cursor.line;
  const start = cursor.index;

  skipToEndOfLine(cursor);
  const rawLine = cursor.text.slice(start, cursor.index).replace(/\r$/, "");

  const equals = rawLine.indexOf("=");
  if (equals === -1) {
    throw new DotenvParseError(
      startLine,
      "expected KEY=value but found no `=`.",
      "Every non-comment line must assign a value. Multi-line values are only possible inside quotes.",
    );
  }

  let name = rawLine.slice(0, equals).trim();
  if (name.startsWith("export ") || name.startsWith("export\t")) {
    name = name.slice("export".length).trim();
  }

  if (name === "") {
    throw new DotenvParseError(startLine, "the name before `=` is empty.");
  }

  const validated = SecretKey.safeParse(name);
  if (!validated.success) {
    // Names the KEY. A key name is plaintext metadata everywhere in this system
    // -- it is what the UI lists and the audit log records -- so echoing it is
    // not a leak, and without it the operator has to count lines to find out
    // which one this is about.
    throw new DotenvParseError(
      startLine,
      `"${name}" is not a valid environment variable name.`,
      "Names must be a letter or underscore followed by letters, digits or underscores.",
    );
  }

  // Rewind to just after the `=` so the value reader starts there. The line
  // counter is untouched: `skipToEndOfLine` never crossed a newline.
  cursor.index = start + equals + 1;

  return validated.data;
}

function readValue(cursor: Cursor, key: string): string {
  // Leading horizontal whitespace between `=` and the value is insignificant,
  // so the opening quote is looked for PAST it -- but the cursor is only
  // advanced for a quoted value. `readUnquoted` needs to see that whitespace,
  // because whether it was there is exactly what distinguishes
  // `COLOR=#ffffff` (a value) from `COLOR= # a comment` (an empty one).
  let peek = cursor.index;
  while (cursor.text[peek] === " " || cursor.text[peek] === "\t") peek += 1;

  const opener = cursor.text[peek];

  if (opener === '"') {
    cursor.index = peek;
    return readDoubleQuoted(cursor, key);
  }
  if (opener === "'") {
    cursor.index = peek;
    return readSingleQuoted(cursor, key);
  }
  if (opener === "`") {
    cursor.index = peek;
    throw new DotenvParseError(
      cursor.line,
      `the value of "${key}" is backtick-quoted, which is not accepted.`,
      "Use single quotes for a literal value or double quotes if you need escapes.",
    );
  }

  return readUnquoted(cursor);
}

/**
 * An unquoted value: everything to end of line, minus a trailing comment.
 *
 * THE COMMENT RULE, stated exactly because it is the ambiguous case every
 * parser gets differently: a `#` starts a comment ONLY when preceded by
 * whitespace. So `COLOR=#ffffff` is the seven-character value `#ffffff`;
 * `COLOR=#ffffff # the brand one` is that same value with a comment; and
 * `COLOR= # nothing yet` is the EMPTY value with a comment. A `#` immediately
 * following a non-space character is part of the value, which is what keeps
 * `TOKEN=ab#cd` from silently becoming `ab`.
 *
 * This is why `readValue` hands the leading whitespace over intact rather than
 * consuming it: the search is for whitespace-then-`#`, and consuming the
 * whitespace first would make the empty-value case indistinguishable from the
 * `#ffffff` one.
 *
 * If you need a value that both starts with whitespace and contains ` #`, quote
 * it. That is what quotes are for.
 */
function readUnquoted(cursor: Cursor): string {
  const start = cursor.index;
  skipToEndOfLine(cursor);

  const raw = cursor.text.slice(start, cursor.index).replace(/\r$/, "");

  const comment = raw.search(/[ \t]#/);
  const body = comment === -1 ? raw : raw.slice(0, comment);

  return body.trim();
}

function readSingleQuoted(cursor: Cursor, key: string): string {
  const openedOn = cursor.line;
  cursor.index += 1;

  let out = "";

  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];

    if (char === "'") {
      cursor.index += 1;
      assertNothingAfterClose(cursor, key);
      return out;
    }

    if (char === "\r") {
      // CRLF normalisation: a value must not change because of a checkout's
      // line-ending policy.
      if (cursor.text[cursor.index + 1] === "\n") {
        cursor.index += 1;
        continue;
      }
    }

    if (char === "\n") cursor.line += 1;

    out += char;
    cursor.index += 1;
  }

  throw new DotenvParseError(
    openedOn,
    `the single-quoted value of "${key}" is never closed.`,
    "A single-quoted value is literal -- there are no escapes, so it cannot contain a single quote.",
  );
}

function readDoubleQuoted(cursor: Cursor, key: string): string {
  const openedOn = cursor.line;
  cursor.index += 1;

  let out = "";

  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];

    if (char === "\\") {
      const escaped = cursor.text[cursor.index + 1];

      if (escaped === undefined) break;

      if (escaped === "\n") {
        // A backslash-newline is a line continuation and contributes nothing.
        cursor.index += 2;
        cursor.line += 1;
        continue;
      }

      const replacement = DOUBLE_QUOTE_ESCAPES[escaped];
      if (replacement === undefined) {
        throw new DotenvParseError(
          cursor.line,
          `unknown escape sequence in the value of "${key}".`,
          "Recognised escapes are \\n \\r \\t \\f \\b \\\" \\' \\\\ \\$ and \\`. A lone backslash must be written \\\\.",
        );
      }

      out += replacement;
      cursor.index += 2;
      continue;
    }

    if (char === '"') {
      cursor.index += 1;
      assertNothingAfterClose(cursor, key);
      return out;
    }

    if (char === "\r" && cursor.text[cursor.index + 1] === "\n") {
      cursor.index += 1;
      continue;
    }

    if (char === "\n") cursor.line += 1;

    out += char;
    cursor.index += 1;
  }

  throw new DotenvParseError(
    openedOn,
    `the double-quoted value of "${key}" is never closed.`,
    "Check for an unescaped double quote inside the value.",
  );
}

/**
 * After a closing quote only whitespace or a comment may follow.
 *
 * `KEY="a" garbage` is rejected rather than being read as `a`. Accepting it
 * means a mistyped `KEY="a" "b"` silently stores `a`, and the operator has no
 * way to see that half their value was discarded.
 */
function assertNothingAfterClose(cursor: Cursor, key: string): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];

    if (char === " " || char === "\t" || char === "\r") {
      cursor.index += 1;
      continue;
    }

    if (char === "\n" || char === "#") return;

    throw new DotenvParseError(
      cursor.line,
      `unexpected text after the closing quote of "${key}".`,
      "Only whitespace or a `#` comment may follow a quoted value.",
    );
  }
}

/**
 * Parse into the map shape the write path takes.
 *
 * Separate from `parseDotenv` so the import dry-run can report warnings and line
 * numbers, which a bare `Record<string, string>` cannot carry.
 */
export function parseDotenvToMap(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of parseDotenv(source).entries) out[entry.key] = entry.value;
  return out;
}
