// action/io.mjs — THE TWO DESTINATIONS A SECRET VALUE MAY REACH, and the
// encoding that makes each of them safe.
//
//   1. an `::add-mask::` workflow command, issued through `command()` below,
//      which escapes unconditionally so a caller cannot forget to, and
//   2. the file named by $GITHUB_ENV or $GITHUB_OUTPUT, written through
//      `appendEnv()` / `appendOutput()` in the heredoc form rendered here.
//
// There is no third, and this file is where that is checkable: `realIo()`
// contains the ONLY `process.stdout.write` and the ONLY `console.error` in the
// action, and inject.test.mjs asserts that by reading every source file in this
// directory and counting. If either count ever becomes 2, a route to the log
// exists that nothing audits, and the masking guarantee stops being local.
//
// WHY THE HEREDOC FORM, WITH A RANDOM DELIMITER
//
// `$GITHUB_ENV` is a line-oriented file. `KEY=value` cannot carry a value with
// a newline in it, and a fixed heredoc delimiter (`KEY<<EOF`) is an injection
// vector: a value whose own text contains a line equal to the delimiter closes
// the block early, and everything after it is parsed as further assignments. A
// secret store is exactly the place an attacker would put such a value. The
// delimiter is therefore 128 bits of CSPRNG per run, and is additionally
// checked against every value being written -- so the property is unconditional
// rather than merely overwhelmingly likely.

import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { ActionError } from "./errors.mjs";

/** The heredoc delimiter's fixed part. The random part follows it. */
export const DELIMITER_PREFIX = "__PRICK_EOF_";

// ---------------------------------------------------------------------------
// Workflow-command encoding
// ---------------------------------------------------------------------------

/**
 * Escapes the data half of a `::command::data` line.
 *
 * This is load-bearing, not cosmetic. A workflow command is one line: if a
 * multi-line value were written after `::add-mask::` unescaped, the runner
 * would treat the first line as the command and PRINT THE REST TO THE LOG.
 * Escaping newlines is what makes masking a multi-line secret possible at all.
 *
 * `%` is replaced first, or the `%0D`/`%0A` introduced below would be escaped
 * a second time.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * The `::add-mask::` payloads for one value.
 *
 * A mask registers a literal string; the runner redacts it wherever it appears
 * in a log line. A multi-line value therefore needs its lines masked
 * individually as well as whole, because no single log line ever equals the
 * whole value.
 *
 * Whitespace-only strings are skipped: the runner ignores them, and masking
 * " " would redact most of the log for no benefit.
 *
 * @param {string} value
 * @returns {string[]} raw payloads, in the order they must be issued
 */
export function maskPayloads(value) {
  const text = String(value);
  if (text.trim() === "") {
    return [];
  }

  const payloads = [text];
  if (/[\r\n]/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() !== "") {
        payloads.push(line);
      }
    }
  }

  return [...new Set(payloads)];
}

// ---------------------------------------------------------------------------
// The environment file
// ---------------------------------------------------------------------------

/**
 * A fresh heredoc delimiter.
 *
 * @param {(size: number) => Buffer} random
 * @returns {string}
 */
export function newDelimiter(random = randomBytes) {
  return `${DELIMITER_PREFIX}${random(16).toString("hex")}__`;
}

/**
 * A delimiter that appears in none of the values it will delimit.
 *
 * With 128 random bits the loop is theatre on any real input -- and that is the
 * point. The guarantee is not "a collision is unlikely", it is "a collision
 * cannot be written", which is a different and much easier property to reason
 * about when the values are chosen by whoever can write to the secret store.
 *
 * @param {string[]} values
 * @param {(size: number) => Buffer} random
 * @param {number} attempts
 * @returns {string}
 */
export function chooseDelimiter(values, random = randomBytes, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delimiter = newDelimiter(random);
    if (!values.some((value) => String(value).includes(delimiter))) {
      return delimiter;
    }
  }
  throw new ActionError("could not generate a delimiter that no value contains");
}

/**
 * Renders one heredoc assignment for `$GITHUB_ENV` or `$GITHUB_OUTPUT`.
 *
 * The value is written byte for byte between the delimiters: no trimming, no
 * escaping, no newline normalisation. A secrets manager that alters a value in
 * transit is worse than one that refuses to carry it.
 *
 * @param {string} name
 * @param {string} value
 * @param {string} delimiter
 * @returns {string}
 */
export function renderAssignment(name, value, delimiter) {
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/**
 * Renders the whole file-command block for a plan.
 *
 * @param {{ name: string, value: string }[]} entries
 * @param {string} delimiter
 * @returns {string}
 */
export function renderBlock(entries, delimiter) {
  return entries.map((entry) => renderAssignment(entry.name, entry.value, delimiter)).join("");
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Io
 * @property {(name: string, message: string) => void} command  a `::name::message` line
 * @property {(line: string) => void} log                        a human progress line
 * @property {(text: string) => void} appendEnv
 * @property {(text: string) => void} appendOutput
 */

/**
 * The real effects.
 *
 * This function contains the ONLY write to stdout and the ONLY write to stderr
 * in the action, and inject.test.mjs asserts that by reading the sources.
 * Keeping them to one each is what makes "no code path prints a value"
 * something you can check in a few seconds rather than something you have to
 * trust.
 *
 * `command()` escapes unconditionally, so a caller cannot forget to. That
 * matters most for `::add-mask::`: an unescaped newline there would end the
 * command and print the rest of the value into the log.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Io}
 */
export function realIo(env = process.env) {
  return {
    command(name, message) {
      process.stdout.write(`::${name}::${escapeData(message)}\n`);
    },
    log(line) {
      console.error(line);
    },
    appendEnv(text) {
      fs.appendFileSync(requireFile(env, "GITHUB_ENV"), text, "utf8");
    },
    appendOutput(text) {
      fs.appendFileSync(requireFile(env, "GITHUB_OUTPUT"), text, "utf8");
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string}
 */
function requireFile(env, name) {
  const value = env[name];
  if (!value) {
    throw new ActionError(
      `$${name} is not set`,
      "This action only runs inside a GitHub Actions job.",
    );
  }
  return value;
}
