/**
 * THE TAMPER SUITE.
 *
 * This file is the reason the crypto layer is built before any database code
 * exists. Every assertion here is about something that must FAIL. A test that
 * passes because `decryptSecretValue` returned `undefined`, or an empty string,
 * or the wrong plaintext, is not a passing test -- so nothing here uses a bare
 * `.rejects.toThrow()`; each case goes through `expectRejection`, which fails
 * loudly if the call resolves at all and never puts the resolved value in the
 * failure message.
 *
 * Runs under `@cloudflare/vitest-pool-workers`, i.e. against the real Workers
 * `crypto.subtle` in workerd rather than Node's. AES-GCM additional-data
 * handling is exactly the sort of thing that can differ between
 * implementations, so the suite is worth very little run anywhere else.
 *
 * The fixture plaintext is a deliberately inert URL with no credentials in it,
 * and it never appears in a test name.
 */
import { describe, expect, it } from "vitest";

import {
  ALG_AES_256_GCM,
  buildKeyring,
  buildSecretValueAad,
  CryptoFormatError,
  CryptoInputError,
  decodeBase64Url,
  decryptSecretValue,
  DecryptFailedError,
  encodeBase64Url,
  encryptSecretValue,
  ENVELOPE_V0_LEGACY,
  ENVELOPE_V1,
  formatEnvelope,
  IV_BYTES,
  parseEnvelope,
  PURPOSE_SECRET_VALUE,
  SecretTooLargeError,
  toHex,
  UnknownKeyError,
  type Keyring,
} from "../../src/lib/server/crypto/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32 bytes, base64. Test material only; it protects nothing. */
const MASTER_A = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
/** A second, unrelated 32-byte key -- the "you forgot MASTER_KEY_OLD" side. */
const MASTER_B = "f359fHt6eXh3dnV0c3JxcG9ubWxramloZ2ZlZGNiYWA=";

const ENV_A = "01924f9c-0000-7000-8000-00000000000a";
const ENV_B = "01924f9c-0000-7000-8000-00000000000b";
const KEY = "DATABASE_URL";
const VERSION = 3;

/** Inert. No credentials, and a host that cannot resolve. */
const FIXTURE = "pg://example.invalid:5432/app";

/** Written as an escape on purpose: a raw NUL in a source file is invisible. */
const NUL = "\u0000";

async function ringA(): Promise<Keyring> {
  return buildKeyring({ active: MASTER_A, retired: [] });
}

async function sealed(): Promise<{ keyring: Keyring; envelope: string }> {
  const keyring = await ringA();
  const envelope = await encryptSecretValue({
    dek: keyring.active.dek,
    kid: keyring.active.kid,
    environmentId: ENV_A,
    key: KEY,
    version: VERSION,
    plaintext: FIXTURE,
  });
  return { keyring, envelope };
}

/**
 * Assert that a promise REJECTS, and hand back the error for further checks.
 *
 * Deliberately not `expect(p).rejects.toThrow()`: that reads well, but its
 * failure message renders the resolved value, and the resolved value on this
 * code path is a decrypted secret. Only `typeof` is reported.
 */
async function expectRejection<T extends Error>(
  promise: Promise<unknown>,
  constructor: new (...args: never[]) => T,
): Promise<T> {
  let resolved = false;
  let resolvedType = "";
  let caught: unknown;

  try {
    const value = await promise;
    resolved = true;
    resolvedType = value === null ? "null" : typeof value;
  } catch (error) {
    caught = error;
  }

  if (resolved) {
    throw new Error(
      `expected a rejection but the call resolved with a ${resolvedType}. ` +
        "Returning anything at all here -- a value, undefined, an empty string -- " +
        "is the failure mode this suite exists to catch.",
    );
  }

  expect(caught).toBeInstanceOf(constructor);
  return caught as T;
}

/** Flip the lowest bit of one byte of an envelope and re-encode it. */
function flipBit(envelope: string, index: number): string {
  const bytes = decodeBase64Url(envelope);
  const before = bytes[index];
  if (before === undefined) throw new Error(`byte ${index} is past the end of the envelope`);
  bytes[index] = before ^ 0x01;
  return encodeBase64Url(bytes);
}

function withBytes(envelope: string, mutate: (bytes: Uint8Array) => Uint8Array): string {
  return encodeBase64Url(mutate(decodeBase64Url(envelope)));
}

// ---------------------------------------------------------------------------
// The matrix: DATABASE_URL, environment A, version 3.
// ---------------------------------------------------------------------------

describe("a sealed secret value", () => {
  it("round-trips under the identical identity", async () => {
    const { keyring, envelope } = await sealed();

    await expect(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
    ).resolves.toBe(FIXTURE);
  });

  it("survives a value of multi-byte text at the byte ceiling", async () => {
    const keyring = await ringA();
    // 4 UTF-8 bytes per code point, so `.length` is half the byte count -- the
    // discrepancy the limit must be checked against.
    const plaintext = "\u{1f511}".repeat(64);
    const encodedBytes = new TextEncoder().encode(plaintext).byteLength;

    expect(encodedBytes).toBe(256);
    expect(plaintext.length).toBe(128);

    const seal = (maxBytes: number) =>
      encryptSecretValue({
        dek: keyring.active.dek,
        kid: keyring.active.kid,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
        plaintext,
        maxBytes,
      });

    await expect(
      decryptSecretValue({
        keyring,
        envelope: await seal(256),
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
    ).resolves.toBe(plaintext);

    // 200 is above `plaintext.length` and below the encoded size. A limit
    // checked against the string length would wave this through.
    await expectRejection(seal(200), SecretTooLargeError);
  });

  it("uses a fresh IV on every encryption", async () => {
    const keyring = await ringA();
    const seal = () =>
      encryptSecretValue({
        dek: keyring.active.dek,
        kid: keyring.active.kid,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
        plaintext: FIXTURE,
      });

    const envelopes = await Promise.all(Array.from({ length: 32 }, seal));
    const ivs = new Set(envelopes.map((e) => toHex(parseEnvelope(e).iv)));

    expect(ivs.size).toBe(envelopes.length);
    for (const iv of ivs) expect(iv).toHaveLength(IV_BYTES * 2);
  });
});

describe("transplant", () => {
  it("rejects the same envelope presented under a different environment", async () => {
    const { keyring, envelope } = await sealed();

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_B,
        key: KEY,
        version: VERSION,
      }),
      DecryptFailedError,
    );
  });

  it("rejects the same envelope presented under a different key name", async () => {
    const { keyring, envelope } = await sealed();

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: "DATABASE_URI",
        version: VERSION,
      }),
      DecryptFailedError,
    );
  });

  it("rejects the same envelope presented under a different purpose", async () => {
    const { keyring, envelope } = await sealed();

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
        purpose: "grant.note",
      }),
      DecryptFailedError,
    );
  });
});

describe("replay", () => {
  it("rejects a rollback to an earlier version", async () => {
    const { keyring, envelope } = await sealed();

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION - 1,
      }),
      DecryptFailedError,
    );
  });

  it("rejects a roll-forward to a later version", async () => {
    const { keyring, envelope } = await sealed();

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION + 1,
      }),
      DecryptFailedError,
    );
  });
});

describe("bit flips", () => {
  const decrypt = (keyring: Keyring, envelope: string) =>
    decryptSecretValue({ keyring, envelope, environmentId: ENV_A, key: KEY, version: VERSION });

  it("rejects a flipped bit in the ciphertext body", async () => {
    const { keyring, envelope } = await sealed();
    // Byte 22 is the first byte after version|alg|kid[8]|iv[12].
    await expectRejection(decrypt(keyring, flipBit(envelope, 22)), DecryptFailedError);
  });

  it("rejects a flipped bit in the GCM tag", async () => {
    const { keyring, envelope } = await sealed();
    const last = decodeBase64Url(envelope).length - 1;
    await expectRejection(decrypt(keyring, flipBit(envelope, last)), DecryptFailedError);
  });

  it("rejects a flipped bit in the IV", async () => {
    const { keyring, envelope } = await sealed();
    // Byte 10 is the first IV byte.
    await expectRejection(decrypt(keyring, flipBit(envelope, 10)), DecryptFailedError);
  });

  it("rejects a flipped bit anywhere in the authenticated region", async () => {
    const { keyring, envelope } = await sealed();
    const length = decodeBase64Url(envelope).length;

    // Bytes 0 and 1 are format and algorithm, and 2..9 are the kid; those are
    // rejected by the parser and the keyring rather than by the tag, and have
    // their own cases. Everything from the IV onwards must fail the tag.
    for (let index = 10; index < length; index += 1) {
      await expectRejection(decrypt(keyring, flipBit(envelope, index)), DecryptFailedError);
    }
  });
});

describe("malformed envelopes", () => {
  const decrypt = (keyring: Keyring, envelope: string) =>
    decryptSecretValue({ keyring, envelope, environmentId: ENV_A, key: KEY, version: VERSION });

  it("rejects a truncated envelope", async () => {
    const { keyring, envelope } = await sealed();
    const truncated = withBytes(envelope, (bytes) => bytes.slice(0, bytes.length - 1));

    await expectRejection(decrypt(keyring, truncated), DecryptFailedError);
  });

  it("rejects an envelope truncated at every length", async () => {
    const { keyring, envelope } = await sealed();
    const length = decodeBase64Url(envelope).length;

    for (let cut = 0; cut < length; cut += 1) {
      const truncated = withBytes(envelope, (bytes) => bytes.slice(0, cut));
      // Below the header it is a format error; above it, the tag fails. Either
      // way it throws, and never returns a shorter plaintext.
      await expectRejection(decrypt(keyring, truncated), Error);
    }
  });

  it("rejects an envelope shorter than its own header", async () => {
    const { keyring, envelope } = await sealed();
    const stub = withBytes(envelope, (bytes) => bytes.slice(0, 10));

    const error = await expectRejection(decrypt(keyring, stub), CryptoFormatError);
    expect(error.message).toMatch(/too short/i);
  });

  it("rejects an empty envelope", async () => {
    const keyring = await ringA();
    await expectRejection(decrypt(keyring, ""), CryptoFormatError);
  });

  it("rejects an unknown format byte without attempting to decrypt", async () => {
    const { keyring, envelope } = await sealed();
    const unknown = withBytes(envelope, (bytes) => {
      bytes[0] = 0x02;
      return bytes;
    });

    const error = await expectRejection(decrypt(keyring, unknown), CryptoFormatError);
    expect(error.message).toContain("0x02");
  });

  it("rejects every format byte this build does not implement", async () => {
    const { keyring, envelope } = await sealed();

    for (let format = 2; format < 256; format += 1) {
      const unknown = withBytes(envelope, (bytes) => {
        bytes[0] = format;
        return bytes;
      });
      await expectRejection(decrypt(keyring, unknown), CryptoFormatError);
    }
  });

  it("rejects an unknown algorithm byte", async () => {
    const { keyring, envelope } = await sealed();
    const unknown = withBytes(envelope, (bytes) => {
      bytes[1] = 0x07;
      return bytes;
    });

    const error = await expectRejection(decrypt(keyring, unknown), CryptoFormatError);
    expect(error.message).toContain("0x07");
  });

  it("rejects an envelope that is not base64url", async () => {
    const keyring = await ringA();
    await expectRejection(decrypt(keyring, "not base64url!!"), CryptoFormatError);
  });
});

describe("unknown key id", () => {
  it("throws an error naming the kid rather than a generic failure", async () => {
    const { keyring, envelope } = await sealed();
    const foreign = withBytes(envelope, (bytes) => {
      for (let i = 2; i < 10; i += 1) bytes[i] = 0xab;
      return bytes;
    });

    const error = await expectRejection(
      decryptSecretValue({
        keyring,
        envelope: foreign,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
      UnknownKeyError,
    );

    expect(error.kid).toBe("abababababababab");
    expect(error.message).toContain("abababababababab");
    // The operator needs to see what IS loaded to tell "forgot MASTER_KEY_OLD"
    // apart from "this row is corrupt".
    expect(error.message).toContain(keyring.active.kid);
    expect(error.knownKids).toEqual([keyring.active.kid]);
  });

  it("decrypts a row written under a retired key once that key is in the ring", async () => {
    const retiredRing = await buildKeyring({ active: MASTER_B, retired: [] });
    const envelope = await encryptSecretValue({
      dek: retiredRing.active.dek,
      kid: retiredRing.active.kid,
      environmentId: ENV_A,
      key: KEY,
      version: VERSION,
      plaintext: FIXTURE,
    });

    const withoutOld = await buildKeyring({ active: MASTER_A, retired: [] });
    await expectRejection(
      decryptSecretValue({
        keyring: withoutOld,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
      UnknownKeyError,
    );

    const withOld = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });
    await expect(
      decryptSecretValue({
        keyring: withOld,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
    ).resolves.toBe(FIXTURE);
  });

  it("keeps the AAD binding for a row read under a retired key", async () => {
    // A rekey changes the kid and nothing else, so a retired-key row is bound
    // exactly as tightly as an active-key one. If it were not, "we have not
    // finished rekeying yet" would be a window in which transplant works.
    const retiredRing = await buildKeyring({ active: MASTER_B, retired: [] });
    const envelope = await encryptSecretValue({
      dek: retiredRing.active.dek,
      kid: retiredRing.active.kid,
      environmentId: ENV_A,
      key: KEY,
      version: VERSION,
      plaintext: FIXTURE,
    });

    const keyring = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_B,
        key: KEY,
        version: VERSION,
      }),
      DecryptFailedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Length-prefix injectivity -- the property a separator scheme fails.
// ---------------------------------------------------------------------------

describe("AAD length-prefix injectivity", () => {
  /**
   * Pairs of (environment_id, key) tuples that a NAIVE encoder renders
   * identically, each labelled with the scheme that collapses it.
   *
   * BOTH ORIENTATIONS of every pair are present, because a test that only
   * happens to bite for the field order this encoder uses today is testing the
   * field order, not the property. `AB|C` versus `A|BC` collides under bare
   * concatenation in one order and not the other, so listing only one of them
   * leaves half the failure undetected.
   */
  const collisions: { scheme: string; left: [string, string]; right: [string, string] }[] = [
    // Bare concatenation. The stated case, and its mirror.
    { scheme: "concatenation", left: ["AB", "C"], right: ["A", "BC"] },
    { scheme: "concatenation", left: ["C", "AB"], right: ["BC", "A"] },
    { scheme: "concatenation", left: ["prod", "APIKEY"], right: ["prodAPI", "KEY"] },
    // Single-character delimiters, both orientations each.
    { scheme: "':' delimiter", left: ["a:b", "c"], right: ["a", "b:c"] },
    { scheme: "':' delimiter", left: ["c", "a:b"], right: ["c:a", "b"] },
    { scheme: "'|' delimiter", left: ["a|b", "c"], right: ["a", "b|c"] },
    { scheme: "'|' delimiter", left: ["c", "a|b"], right: ["c|a", "b"] },
    { scheme: "'/' delimiter", left: ["prod/api", "KEY"], right: ["prod", "api/KEY"] },
    { scheme: "space delimiter", left: ["a b", "c"], right: ["a", "b c"] },
    // NUL, the delimiter people reach for when they have decided a printable
    // one is unsafe. A key name is a string, and a string can contain it.
    { scheme: "NUL delimiter", left: [`a${NUL}b`, "c"], right: ["a", `b${NUL}c`] },
    { scheme: "NUL delimiter", left: ["c", `a${NUL}b`], right: [`c${NUL}a`, "b"] },
    // Multi-byte UTF-8 on both sides of the split.
    { scheme: "concatenation", left: ["éé", "é"], right: ["é", "éé"] },
    { scheme: "concatenation", left: ["中文", "キー"], right: ["中", "文キー"] },
    {
      scheme: "concatenation",
      left: ["\u{1f511}\u{1f511}", "\u{1f511}"],
      right: ["\u{1f511}", "\u{1f511}\u{1f511}"],
    },
    { scheme: "':' delimiter", left: ["é:中", "\u{1f511}"], right: ["é", `中:\u{1f511}`] },
  ];

  it("distinguishes {key: 'AB', environment: 'C'} from {key: 'A', environment: 'BC'}", () => {
    // The stated case and its mirror. Under bare concatenation exactly one of
    // the two collapses, whichever order the encoder writes its fields in, so
    // both are asserted.
    const pairs: [[string, string], [string, string]][] = [
      [
        ["C", "AB"],
        ["BC", "A"],
      ],
      [
        ["AB", "C"],
        ["A", "BC"],
      ],
    ];

    for (const [[envLeft, keyLeft], [envRight, keyRight]] of pairs) {
      const left = buildSecretValueAad({ environmentId: envLeft, key: keyLeft, version: 1 });
      const right = buildSecretValueAad({ environmentId: envRight, key: keyRight, version: 1 });

      expect(toHex(left)).not.toBe(toHex(right));
    }
  });

  it("stays injective for fields containing separators, NUL and multi-byte UTF-8", () => {
    for (const { scheme, left, right } of collisions) {
      const [envLeft, keyLeft] = left;
      const [envRight, keyRight] = right;

      const encodedLeft = toHex(
        buildSecretValueAad({ environmentId: envLeft, key: keyLeft, version: 7 }),
      );
      const encodedRight = toHex(
        buildSecretValueAad({ environmentId: envRight, key: keyRight, version: 7 }),
      );

      // Labelled so a failure names the scheme that would have produced it.
      expect(`${scheme} ${encodedLeft}`).not.toBe(`${scheme} ${encodedRight}`);
    }
  });

  it("assigns a distinct encoding to every tuple in the collision table", () => {
    const tuples = new Set(
      collisions.flatMap(({ left, right }) => [JSON.stringify(left), JSON.stringify(right)]),
    );
    const encodings = new Set(
      collisions.flatMap(({ left, right }) =>
        [left, right].map(([environmentId, key]) =>
          toHex(buildSecretValueAad({ environmentId, key, version: 7 })),
        ),
      ),
    );

    expect(encodings.size).toBe(tuples.size);
  });

  it("is injective across a cross-product of adversarial field values", () => {
    // Chosen so the set itself contains concatenation-ambiguous splits:
    // ("a", "ab") and ("aa", "b") both concatenate to "aab"; ("a", "ba") and
    // ("ab", "a") both to "aba".
    const fields = [
      "a",
      "b",
      "aa",
      "ab",
      "ba",
      "aab",
      "a:b",
      "a|b",
      "a b",
      `a${NUL}b`,
      "",
      "é",
      "\u{1f511}",
    ];
    const purposes = [PURPOSE_SECRET_VALUE, "grant.note"];
    const versions = [0, 1, 3, 0xffffffff];

    const seen = new Set<string>();
    let built = 0;

    for (const environmentId of fields) {
      for (const key of fields) {
        for (const purpose of purposes) {
          for (const version of versions) {
            if (environmentId === "" || key === "") {
              // Identity fields are required; an empty one is a caller bug.
              expect(() => buildSecretValueAad({ environmentId, key, version, purpose })).toThrow(
                CryptoInputError,
              );
              continue;
            }
            seen.add(toHex(buildSecretValueAad({ environmentId, key, version, purpose })));
            built += 1;
          }
        }
      }
    }

    expect(built).toBeGreaterThan(0);
    expect(seen.size).toBe(built);
  });

  it("emits the locked wire format", () => {
    const aad = buildSecretValueAad({ environmentId: "env-a", key: KEY, version: 3 });

    // "prick" 01 | 000c "secret.value" | 0005 "env-a" | 000c "DATABASE_URL" | 00000003
    expect(toHex(aad)).toBe(
      "707269636b01" +
        "000c" +
        "7365637265742e76616c7565" +
        "0005" +
        "656e762d61" +
        "000c" +
        "44415441424153455f55524c" +
        "00000003",
    );
    expect(aad.byteLength).toBe(45);
  });

  it("counts length prefixes in UTF-8 bytes, not UTF-16 units", () => {
    // "é" is one JavaScript character and two bytes. A prefix of 0x0001 here
    // would not describe what follows it.
    const aad = buildSecretValueAad({ environmentId: "é", key: "\u{1f511}", version: 0 });

    expect(toHex(aad)).toBe(
      "707269636b01" +
        "000c" +
        "7365637265742e76616c7565" +
        "0002" +
        "c3a9" +
        "0004" +
        "f09f9491" +
        "00000000",
    );
  });

  it("refuses a field longer than a u16 length prefix can describe", () => {
    expect(() =>
      buildSecretValueAad({ environmentId: ENV_A, key: "k".repeat(0x10000), version: 1 }),
    ).toThrow(CryptoInputError);
    // 0xffff bytes is the widest that fits, and must be accepted.
    expect(() =>
      buildSecretValueAad({ environmentId: ENV_A, key: "k".repeat(0xffff), version: 1 }),
    ).not.toThrow();
  });

  it("refuses a version outside u32", () => {
    for (const version of [-1, 1.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildSecretValueAad({ environmentId: ENV_A, key: KEY, version })).toThrow(
        CryptoInputError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The legacy format: decrypt-only, never emitted.
// ---------------------------------------------------------------------------

describe("the v0 legacy format", () => {
  /** Build a `0x00 || iv[12] || ciphertext||tag` blob -- no AAD, no kid. */
  async function legacyEnvelope(keyring: Keyring, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        keyring.active.dek,
        new TextEncoder().encode(plaintext),
      ),
    );

    const bytes = new Uint8Array(1 + iv.length + ciphertext.length);
    bytes[0] = ENVELOPE_V0_LEGACY;
    bytes.set(iv, 1);
    bytes.set(ciphertext, 1 + iv.length);
    return encodeBase64Url(bytes);
  }

  it("decrypts", async () => {
    const keyring = await ringA();
    const envelope = await legacyEnvelope(keyring, FIXTURE);

    await expect(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
      }),
    ).resolves.toBe(FIXTURE);
  });

  it("can be refused explicitly", async () => {
    const keyring = await ringA();
    const envelope = await legacyEnvelope(keyring, FIXTURE);

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope,
        environmentId: ENV_A,
        key: KEY,
        version: VERSION,
        allowLegacyV0: false,
      }),
      CryptoFormatError,
    );
  });

  it("is never emitted by the encrypt path", async () => {
    const keyring = await ringA();

    for (let i = 0; i < 24; i += 1) {
      const envelope = await encryptSecretValue({
        dek: keyring.active.dek,
        kid: keyring.active.kid,
        environmentId: ENV_A,
        key: KEY,
        version: i,
        plaintext: FIXTURE,
      });

      const parsed = parseEnvelope(envelope);
      expect(parsed.version).toBe(ENVELOPE_V1);
      expect(parsed.alg).toBe(ALG_AES_256_GCM);
      expect(decodeBase64Url(envelope)[0]).toBe(ENVELOPE_V1);
    }
  });

  it("cannot be produced by the formatter either", () => {
    expect(() =>
      formatEnvelope({
        version: ENVELOPE_V0_LEGACY,
        alg: ALG_AES_256_GCM,
        kid: "0011223344556677",
        iv: new Uint8Array(IV_BYTES),
        ciphertext: new Uint8Array(16),
      }),
    ).toThrow(CryptoInputError);
  });

  it("does not let a v1 row be downgraded to strip its AAD", async () => {
    // Reassembling a v1 body as a v0 blob is the obvious way to try to shed the
    // binding. The GCM tag is computed over the AAD, so it fails.
    const { keyring, envelope } = await sealed();
    const v1 = decodeBase64Url(envelope);
    const downgraded = new Uint8Array(v1.length - 9);
    downgraded[0] = ENVELOPE_V0_LEGACY;
    downgraded.set(v1.subarray(10), 1);

    await expectRejection(
      decryptSecretValue({
        keyring,
        envelope: encodeBase64Url(downgraded),
        environmentId: ENV_B,
        key: "ANYTHING",
        version: 999,
      }),
      DecryptFailedError,
    );
  });
});
