/**
 * The envelope and the codecs underneath it.
 *
 * Two things are being established here. First, that the envelope is
 * self-describing and that byte 0 is genuinely the first thing consulted --
 * a format this build does not know must be refused before any length is
 * trusted or any key is touched. Second, that base64url round-trips exactly,
 * because the envelope is the only thing standing between a database row and
 * `crypto.subtle`, and a codec that silently normalises its input would make
 * two different rows decode to the same bytes.
 */
import { describe, expect, it } from "vitest";

import {
  ALG_AES_256_GCM,
  CryptoFormatError,
  CryptoInputError,
  decodeBase64Flexible,
  decodeBase64Url,
  encodeBase64,
  encodeBase64Url,
  ENVELOPE_V0_HEADER_BYTES,
  ENVELOPE_V0_LEGACY,
  ENVELOPE_V1,
  ENVELOPE_V1_HEADER_BYTES,
  formatEnvelope,
  IV_BYTES,
  KID_BYTES,
  parseEnvelope,
  TAG_BYTES,
  toHex,
  type Bytes,
} from "../../src/lib/server/crypto/index.js";

const KID = "0123456789abcdef";

function body(size: number, fill = 0x5a): Bytes {
  return new Uint8Array(size).fill(fill);
}

function iv(fill = 0x11): Bytes {
  return new Uint8Array(IV_BYTES).fill(fill);
}

/** Deterministic PRNG, so a fuzz failure is reproducible from its seed. */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

describe("format and parse", () => {
  it("round-trips a v1 envelope", () => {
    const ciphertext = body(64);
    const envelope = formatEnvelope({
      version: ENVELOPE_V1,
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(),
      ciphertext,
    });

    const parsed = parseEnvelope(envelope);

    expect(parsed.version).toBe(ENVELOPE_V1);
    expect(parsed.alg).toBe(ALG_AES_256_GCM);
    expect(parsed.kid).toBe(KID);
    expect(toHex(parsed.iv)).toBe(toHex(iv()));
    expect(toHex(parsed.ciphertext)).toBe(toHex(ciphertext));
  });

  it("lays the header out as version | alg | kid[8] | iv[12]", () => {
    const envelope = formatEnvelope({
      version: ENVELOPE_V1,
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(0x22),
      ciphertext: body(TAG_BYTES, 0x33),
    });

    const bytes = decodeBase64Url(envelope);

    expect(ENVELOPE_V1_HEADER_BYTES).toBe(22);
    expect(ENVELOPE_V0_HEADER_BYTES).toBe(13);
    expect(bytes[0]).toBe(ENVELOPE_V1);
    expect(bytes[1]).toBe(ALG_AES_256_GCM);
    expect(toHex(bytes.slice(2, 2 + KID_BYTES))).toBe(KID);
    expect(toHex(bytes.slice(10, 22))).toBe(toHex(iv(0x22)));
    expect(bytes.length).toBe(ENVELOPE_V1_HEADER_BYTES + TAG_BYTES);
  });

  it("emits unpadded base64url", () => {
    const envelope = formatEnvelope({
      version: ENVELOPE_V1,
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(),
      ciphertext: body(23),
    });

    expect(envelope).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to emit anything but the current format", () => {
    const parts = {
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(),
      ciphertext: body(TAG_BYTES),
    };

    expect(() => formatEnvelope({ ...parts, version: ENVELOPE_V0_LEGACY })).toThrow(
      CryptoInputError,
    );
    expect(() => formatEnvelope({ ...parts, version: 0x02 })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, version: ENVELOPE_V1, alg: 0x02 })).toThrow(
      CryptoInputError,
    );
  });

  it("refuses malformed parts", () => {
    const parts = {
      version: ENVELOPE_V1,
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(),
      ciphertext: body(TAG_BYTES),
    };

    expect(() => formatEnvelope({ ...parts, kid: "abc" })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, kid: "0123456789ABCDEF" })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, kid: "0123456789abcdeg" })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, iv: new Uint8Array(11) })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, iv: new Uint8Array(13) })).toThrow(CryptoInputError);
    expect(() => formatEnvelope({ ...parts, ciphertext: body(TAG_BYTES - 1) })).toThrow(
      CryptoInputError,
    );
  });

  it("dispatches on byte 0 before trusting any length", () => {
    // A blob that would be long enough for v1 but names an unknown format. The
    // format complaint must win: nothing may be read out of a layout this build
    // does not know.
    const bytes = new Uint8Array(ENVELOPE_V1_HEADER_BYTES + TAG_BYTES);
    bytes[0] = 0x7f;

    expect(() => parseEnvelope(encodeBase64Url(bytes))).toThrow(/0x7f/);
  });

  it("parses a v0 envelope as having no key id", () => {
    const bytes = new Uint8Array(ENVELOPE_V0_HEADER_BYTES + TAG_BYTES);
    bytes[0] = ENVELOPE_V0_LEGACY;
    bytes.set(iv(0x44), 1);

    const parsed = parseEnvelope(encodeBase64Url(bytes));

    expect(parsed.version).toBe(ENVELOPE_V0_LEGACY);
    expect(parsed.kid).toBeNull();
    expect(toHex(parsed.iv)).toBe(toHex(iv(0x44)));
    expect(parsed.ciphertext).toHaveLength(TAG_BYTES);
  });

  it("rejects envelopes shorter than the format they name", () => {
    for (const [version, minimum] of [
      [ENVELOPE_V1, ENVELOPE_V1_HEADER_BYTES + TAG_BYTES],
      [ENVELOPE_V0_LEGACY, ENVELOPE_V0_HEADER_BYTES + TAG_BYTES],
    ] as const) {
      const short = new Uint8Array(minimum - 1);
      short[0] = version;
      short[1] = ALG_AES_256_GCM;

      expect(() => parseEnvelope(encodeBase64Url(short))).toThrow(CryptoFormatError);

      const exact = new Uint8Array(minimum);
      exact[0] = version;
      exact[1] = ALG_AES_256_GCM;

      expect(() => parseEnvelope(encodeBase64Url(exact))).not.toThrow();
    }
  });

  it("rejects an empty envelope", () => {
    expect(() => parseEnvelope("")).toThrow(CryptoFormatError);
  });

  it("returns copies rather than views into a shared buffer", () => {
    const envelope = formatEnvelope({
      version: ENVELOPE_V1,
      alg: ALG_AES_256_GCM,
      kid: KID,
      iv: iv(),
      ciphertext: body(32),
    });

    const parsed = parseEnvelope(envelope);

    expect(parsed.iv.byteOffset).toBe(0);
    expect(parsed.iv.buffer.byteLength).toBe(IV_BYTES);
    expect(parsed.ciphertext.byteOffset).toBe(0);
    expect(parsed.ciphertext.buffer.byteLength).toBe(32);
  });
});

describe("base64url", () => {
  it("round-trips random byte strings of every residue class", () => {
    const next = xorshift32(0x9e3779b9);

    for (let iteration = 0; iteration < 512; iteration += 1) {
      const length = next() % 300;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = next() & 0xff;

      const encoded = encodeBase64Url(bytes);

      expect(encoded).not.toMatch(/[+/=]/);
      expect(toHex(decodeBase64Url(encoded))).toBe(toHex(bytes));
    }
  });

  it("round-trips through the padded standard alphabet as well", () => {
    const next = xorshift32(0x1234_5678);

    for (let iteration = 0; iteration < 256; iteration += 1) {
      const length = next() % 96;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = next() & 0xff;

      const encoded = encodeBase64(bytes);

      expect(encoded.length % 4).toBe(0);
      expect(toHex(decodeBase64Flexible(encoded, "fixture"))).toBe(toHex(bytes));
      expect(toHex(decodeBase64Flexible(encoded.replace(/=+$/, ""), "fixture"))).toBe(toHex(bytes));
    }
  });

  it("refuses the standard alphabet where base64url is expected", () => {
    expect(() => decodeBase64Url("ab+d")).toThrow(CryptoFormatError);
    expect(() => decodeBase64Url("ab/d")).toThrow(CryptoFormatError);
  });

  it("refuses whitespace, stray characters and impossible lengths", () => {
    expect(() => decodeBase64Url("ab cd")).toThrow(CryptoFormatError);
    expect(() => decodeBase64Url("ab\ncd")).toThrow(CryptoFormatError);
    expect(() => decodeBase64Url("abcde")).toThrow(CryptoFormatError); // 5 % 4 === 1
    expect(() => decodeBase64Url("a")).toThrow(CryptoFormatError);
    expect(() => decodeBase64Url("abc====")).toThrow(CryptoFormatError);
  });

  it("refuses non-canonical trailing bits, so one byte string has one spelling", () => {
    // "AB" and "AC" would both decode to the single byte 0x00 under a lenient
    // decoder; only the one whose discarded bits are zero is accepted.
    expect(toHex(decodeBase64Url("AA"))).toBe("00");
    expect(() => decodeBase64Url("AB")).toThrow(CryptoFormatError);
    expect(toHex(decodeBase64Url("AAA"))).toBe("0000");
    expect(() => decodeBase64Url("AAB")).toThrow(CryptoFormatError);
  });

  it("does not echo the offending character", () => {
    // The decoder is pointed at master key material as well as at rows.
    let message = "";
    try {
      decodeBase64Url("aa$aSECRET", "Envelope");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).not.toContain("$");
    expect(message).not.toContain("SECRET");
    expect(message).toContain("Envelope");
  });
});
