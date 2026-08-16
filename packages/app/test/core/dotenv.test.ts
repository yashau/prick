import { describe, expect, it } from "vitest";

import {
  DotenvParseError,
  parseDotenv,
  parseDotenvToMap,
} from "../../src/lib/server/core/dotenv.js";
import { throwsWith } from "../auth/rejects.js";

/**
 * The strict `.env` parser.
 *
 * Every assertion below is a decision about ambiguity. A `.env` file is an
 * under-specified format -- there is no grammar, only a pile of mutually
 * incompatible implementations -- and in a secrets manager each ambiguity is a
 * chance to store something other than what the file says. Storing the WRONG
 * value is worse than refusing the file, because a refusal is visible.
 */

function parse(source: string): Record<string, string> {
  return parseDotenvToMap(source);
}

describe("the basic forms", () => {
  it("reads KEY=value", () => {
    expect(parse("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("accepts and discards an `export ` prefix", () => {
    // Half the .env files in existence were written to be `source`d by a shell.
    expect(parse("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("trims insignificant whitespace around an unquoted value", () => {
    expect(parse("FOO=   bar   ")).toEqual({ FOO: "bar" });
  });

  it("preserves whitespace inside quotes", () => {
    expect(parse('FOO="  bar  "')).toEqual({ FOO: "  bar  " });
    expect(parse("FOO='  bar  '")).toEqual({ FOO: "  bar  " });
  });

  it("reads an empty value", () => {
    expect(parse("FOO=")).toEqual({ FOO: "" });
    expect(parse('FOO=""')).toEqual({ FOO: "" });
  });

  it("skips blank lines and whole-line comments", () => {
    expect(parse("# a comment\n\nFOO=bar\n   # indented\nBAZ=qux\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("tolerates CRLF", () => {
    expect(parse("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips a UTF-8 BOM", () => {
    // Without this the first key is `﻿FOO`, which fails the name check
    // with a complaint about a character that is invisible in every editor.
    expect(parse("﻿FOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("the comment rule for unquoted values", () => {
  it("refuses ` #` on an unquoted value rather than picking a reading", () => {
    // THE decision. `PASSWORD=hunter2 # 1` is a password containing a hash to
    // one reader and a password with a comment to the next. Storing `hunter2`
    // hands production a truncated credential and reports success; storing the
    // whole line welds a comment onto the secret. Both are silent, so neither
    // is taken.
    const error = throwsWith(() => parse("PASSWORD=hunter2 # 1"), "VALIDATION_FAILED");

    expect(error).toBeInstanceOf(DotenvParseError);
    expect((error as DotenvParseError).line).toBe(1);
    expect(error.message).toContain("PASSWORD");
    expect(error.message).not.toContain("hunter2");
  });

  it("refuses a tab before the `#` too", () => {
    throwsWith(() => parse("A=1\nPASSWORD=hunter2\t# 1"), "VALIDATION_FAILED");
  });

  it("refuses an empty value followed by a comment", () => {
    // `COLOR= #ffffff` reads equally well as the empty value with a comment or
    // as `#ffffff` written with insignificant leading whitespace, which is a
    // spelling this parser accepts everywhere else. Same ambiguity, same answer.
    throwsWith(() => parse("COLOR= # nothing yet"), "VALIDATION_FAILED");
  });

  it("keeps a `#` that is NOT preceded by whitespace", () => {
    // The load-bearing case for refusing the one above. `COLOR=#ffffff` is a
    // colour, and a parser that strips from the first `#` stores the empty
    // string for it. A token containing `#` is the same problem with worse
    // consequences. Neither line is ambiguous, so neither is refused.
    expect(parse("COLOR=#ffffff")).toEqual({ COLOR: "#ffffff" });
    expect(parse("TOKEN=ab#cd")).toEqual({ TOKEN: "ab#cd" });
    expect(parse("PASSWORD=hunter2#1")).toEqual({ PASSWORD: "hunter2#1" });
  });

  it("does not treat `#` inside quotes as a comment at all", () => {
    expect(parse('TOKEN="ab # cd"')).toEqual({ TOKEN: "ab # cd" });
  });

  it("takes quoting as the answer to the ambiguity, in both directions", () => {
    // What the refusal tells the operator to write. One keeps the hash, the
    // other drops the comment; the file now says which.
    expect(parse('PASSWORD="hunter2 # 1"')).toEqual({ PASSWORD: "hunter2 # 1" });
    expect(parse("PASSWORD='hunter2 # 1'")).toEqual({ PASSWORD: "hunter2 # 1" });
    expect(parse('PASSWORD="hunter2" # 1')).toEqual({ PASSWORD: "hunter2" });
  });
});

describe("quoting", () => {
  it("takes a single-quoted value completely literally", () => {
    expect(parse("FOO='a\\nb $VAR \"x\"'")).toEqual({ FOO: 'a\\nb $VAR "x"' });
  });

  it("expands escapes inside double quotes", () => {
    expect(parse('FOO="a\\nb\\tc"')).toEqual({ FOO: "a\nb\tc" });
    expect(parse('FOO="say \\"hi\\""')).toEqual({ FOO: 'say "hi"' });
    expect(parse('FOO="back\\\\slash"')).toEqual({ FOO: "back\\slash" });
  });

  it("refuses an unknown escape rather than guessing", () => {
    // `\q` could plausibly mean `q` or `\q`. Both choices silently store
    // something the author did not write, so neither is taken.
    const error = throwsWith(() => parse('FOO="a\\qb"'), "VALIDATION_FAILED");
    expect(error.message).toContain("Line 1");
  });

  it("allows a multi-line value INSIDE quotes", () => {
    expect(parse('KEY="line one\nline two"')).toEqual({ KEY: "line one\nline two" });
    expect(parse("KEY='line one\nline two'")).toEqual({ KEY: "line one\nline two" });
  });

  it("normalises CRLF inside a quoted multi-line value to LF", () => {
    // A PEM key's bytes must not depend on whether the file came off a Windows
    // checkout -- otherwise the same secret has two representations and a
    // signature verification fails on one of them.
    expect(parse('KEY="line one\r\nline two"')).toEqual({ KEY: "line one\nline two" });
  });

  it("ends an UNQUOTED value at the newline", () => {
    expect(parse("A=one\nB=two")).toEqual({ A: "one", B: "two" });
  });

  it("refuses an unterminated quote, naming the line it opened on", () => {
    const error = throwsWith(() => parse('A=one\nB="never closed\nC=three'), "VALIDATION_FAILED");
    expect(error).toBeInstanceOf(DotenvParseError);
    expect((error as DotenvParseError).line).toBe(2);
  });

  it("refuses text after a closing quote", () => {
    // `KEY="a" "b"` would otherwise silently store `a` and discard the rest.
    throwsWith(() => parse('KEY="a" garbage'), "VALIDATION_FAILED");
  });

  it("allows a comment after a closing quote", () => {
    expect(parse('KEY="a"   # why')).toEqual({ KEY: "a" });
  });

  it("refuses backtick quoting", () => {
    throwsWith(() => parse("KEY=`a`"), "VALIDATION_FAILED");
  });
});

describe("NO interpolation, ever", () => {
  it("stores $VAR literally", () => {
    // THE decision this parser exists to make. `$aB3!x$k` is an ordinary
    // generated password; an interpolating parser silently stores `$aB3!x`
    // plus whatever `$k` resolved to -- usually nothing. The secret is now
    // wrong, still looks like a password, and no error was raised.
    expect(parse('PASSWORD="$aB3!x$k"')).toEqual({ PASSWORD: "$aB3!x$k" });
    expect(parse("PASSWORD=${OTHER}")).toEqual({ PASSWORD: "${OTHER}" });
  });

  it("warns about a $VAR-like sequence without quoting any of the value", () => {
    const document = parseDotenv("PASSWORD=${OTHER}\nOK=plain");

    expect(document.warnings).toHaveLength(1);
    expect(document.warnings[0]).toMatchObject({ line: 1, key: "PASSWORD" });
    // The warning names the LINE and the KEY. It must not carry the value, or
    // any fragment of it -- a warning travels to the same three places an
    // error does.
    expect(document.warnings[0]?.message).not.toContain("OTHER");
  });
});

describe("strictness", () => {
  it("refuses a duplicate key, naming both lines", () => {
    // Last-one-wins would silently pick which of two production databases the
    // deploy talks to.
    const error = throwsWith(
      () => parse("DATABASE_URL=one\nOTHER=x\nDATABASE_URL=two"),
      "VALIDATION_FAILED",
    );

    expect(error.message).toContain("Line 3");
    expect(error.message).toContain("line 1");
  });

  it("refuses a line with no `=`", () => {
    const error = throwsWith(() => parse("FOO=bar\njust some text"), "VALIDATION_FAILED");
    expect(error.message).toContain("Line 2");
  });

  it("refuses a name that is not a POSIX environment variable", () => {
    throwsWith(() => parse("9LIVES=x"), "VALIDATION_FAILED");
    throwsWith(() => parse("has-dash=x"), "VALIDATION_FAILED");
    throwsWith(() => parse("=novalue"), "VALIDATION_FAILED");
  });

  it("counts lines correctly across a multi-line value", () => {
    // A value spanning three lines must not throw the counter off, or every
    // subsequent error points somewhere else and the operator edits the wrong
    // line.
    const error = throwsWith(
      () => parse('A="one\ntwo\nthree"\nbroken line here'),
      "VALIDATION_FAILED",
    );

    expect(error.message).toContain("Line 4");
  });
});

describe("what a parse error may say", () => {
  it("never quotes the offending line", () => {
    // Every line of a .env file is, by construction, a line containing a
    // secret. The message travels into an HTTP response and a Worker log.
    const secret = "sk-live-01234567890abcdef";
    const error = throwsWith(() => parse(`TOKEN="${secret}`), "VALIDATION_FAILED");

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.detail)).not.toContain(secret);
  });
});
