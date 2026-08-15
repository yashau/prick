import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { scanDotenvKeys } from "../src/dotenv-keys.ts";

describe("scanDotenvKeys", () => {
  test("reads names, and the result contains no value anywhere", () => {
    const source = [
      "# a comment",
      "DATABASE_URL=postgres://user:hunter2@db.internal/app",
      "export STRIPE_KEY='sk_live_TOPSECRET'",
      'SENTRY_DSN="https://abc@o1.ingest.example/42"',
      "",
      "EMPTY=",
    ].join("\n");

    const scan = scanDotenvKeys(source);

    assert.deepEqual(scan.keys, ["DATABASE_URL", "STRIPE_KEY", "SENTRY_DSN", "EMPTY"]);

    // The property that makes secrets_diff safe: the scan's OUTPUT cannot
    // contain a value, because no value was ever built.
    const serialised = JSON.stringify(scan);
    for (const fragment of ["hunter2", "sk_live_TOPSECRET", "o1.ingest.example", "postgres://"]) {
      assert.ok(!serialised.includes(fragment), `scan result leaked ${fragment}`);
    }
  });

  test("a multi-line quoted value does not produce phantom keys", () => {
    // The failure this prevents: a PEM block whose interior lines look like
    // `KEY=` declarations, which would report keys that do not exist and, worse,
    // suggest the file is structured differently than it is.
    const source = [
      'TLS_KEY="-----BEGIN PRIVATE KEY-----',
      "NOT_A_KEY=still inside the quotes",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
      '-----END PRIVATE KEY-----"',
      "REAL_KEY=yes",
    ].join("\n");

    assert.deepEqual(scanDotenvKeys(source).keys, ["TLS_KEY", "REAL_KEY"]);
  });

  test("a single-quoted multi-line value is skipped the same way", () => {
    const source = ["A='line one", "B=not a key", "line three'", "C=3"].join("\n");
    assert.deepEqual(scanDotenvKeys(source).keys, ["A", "C"]);
  });

  test("an escaped quote does not end a double-quoted value early", () => {
    const source = ['A="he said \\"hi\\" and B=no"', "C=3"].join("\n");
    assert.deepEqual(scanDotenvKeys(source).keys, ["A", "C"]);
  });

  test("comments, blank lines and a BOM are handled", () => {
    const source = "﻿# header\n\n  # indented comment\nA=1\n\nB=2 # trailing\n";
    assert.deepEqual(scanDotenvKeys(source).keys, ["A", "B"]);
  });

  test("CRLF files scan identically", () => {
    const lf = scanDotenvKeys("A=1\nB=2\n");
    const crlf = scanDotenvKeys("A=1\r\nB=2\r\n");
    assert.deepEqual(crlf.keys, lf.keys);
  });

  test("duplicates are reported rather than silently resolved", () => {
    const scan = scanDotenvKeys("A=1\nA=2\n");
    assert.deepEqual(scan.keys, ["A"]);
    assert.deepEqual(scan.duplicates, ["A"]);
  });

  test("invalid names and malformed lines are reported, not thrown", () => {
    const scan = scanDotenvKeys("9LIVES=1\nnot a declaration\nGOOD=2\n");

    assert.deepEqual(scan.keys, ["GOOD"]);
    assert.deepEqual(scan.invalid, ["9LIVES"]);
    assert.deepEqual(scan.malformedLines, [2]);
  });

  test("an unterminated quote consumes the rest of the file without looping", () => {
    const scan = scanDotenvKeys('A="never closed\nB=2\n');
    assert.deepEqual(scan.keys, ["A"]);
  });
});
