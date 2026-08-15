/**
 * The stored ciphertext envelope.
 *
 *   base64url( version || alg || kid[8] || iv[12] || ciphertext||tag )
 *
 * BYTE 0 IS READ FIRST and dispatches. An unknown format byte THROWS; it is
 * never guessed at, never best-effort decoded, and never treated as the current
 * format on the assumption that it probably is. In particular the length checks
 * are made AFTER the dispatch and are specific to the format that byte named --
 * a shared "is it long enough" check up front would be checking the wrong
 * number for every format but one.
 *
 * Formats:
 *
 *   0x00  v0 -- legacy, no AAD. DECRYPT-ONLY, NEVER EMITTED. Accepted so that
 *         a v0 export can be imported and immediately re-encrypted as 0x01.
 *         Its body is `iv[12] || ciphertext||tag`: no algorithm byte (AES-GCM
 *         is implied) and no key id, which is why decrypting one has to try
 *         every key in the ring. Nothing in this codebase may produce one, and
 *         `formatEnvelope` refuses to.
 *
 *   0x01  current -- AES-256-GCM with the additional data built by
 *         `buildSecretValueAad`.
 *
 * `kid` is in the ENVELOPE and NOT in the AAD. That asymmetry is what makes
 * rekeying possible: re-encrypting a row under a new master key must leave the
 * row's identity -- and therefore its AAD -- untouched, changing only which key
 * protects it. Putting `kid` in the AAD would make every rekey a version bump.
 *
 * An unknown `kid` throws an error that NAMES THE KID, so an operator can tell
 * "you forgot to set MASTER_KEY_OLD" apart from "this row is corrupt". A
 * generic "decryption failed" cannot distinguish those, and they need opposite
 * responses.
 */

import { byteToHexLiteral, decodeBase64Url, encodeBase64Url, toHex, type Bytes } from "./codec.js";
import { CryptoFormatError, CryptoInputError } from "./errors.js";

export const ENVELOPE_V0_LEGACY = 0x00;
export const ENVELOPE_V1 = 0x01;

export const ALG_AES_256_GCM = 0x01;

export const KID_BYTES = 8;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/** version || alg || kid[8] || iv[12] */
export const ENVELOPE_V1_HEADER_BYTES = 1 + 1 + KID_BYTES + IV_BYTES;
/** version || iv[12] */
export const ENVELOPE_V0_HEADER_BYTES = 1 + IV_BYTES;

const KID_HEX_LENGTH = KID_BYTES * 2;
const KID_HEX_PATTERN = /^[0-9a-f]{16}$/;

export interface ParsedEnvelope {
  version: number;
  alg: number;
  /** Hex. `null` for a v0 envelope, which carries none. */
  kid: string | null;
  iv: Bytes;
  ciphertext: Bytes;
}

export function parseEnvelope(blob: string): ParsedEnvelope {
  const bytes = decodeBase64Url(blob, "Envelope");

  if (bytes.length === 0) {
    throw new CryptoFormatError("Envelope is empty.");
  }

  // Byte 0, before anything else. Nothing below this line may run for a format
  // this build does not know.
  const version = bytes[0] ?? 0;

  if (version === ENVELOPE_V1) {
    if (bytes.length < ENVELOPE_V1_HEADER_BYTES + TAG_BYTES) {
      throw new CryptoFormatError(
        `Envelope is too short for format ${byteToHexLiteral(version)}: ` +
          `${bytes.length} bytes, minimum ${ENVELOPE_V1_HEADER_BYTES + TAG_BYTES}.`,
      );
    }

    const alg = bytes[1] ?? 0;
    if (alg !== ALG_AES_256_GCM) {
      throw new CryptoFormatError(
        `Envelope names algorithm ${byteToHexLiteral(alg)}, which this build does not implement.`,
      );
    }

    return {
      version,
      alg,
      kid: toHex(bytes.slice(2, 2 + KID_BYTES)),
      iv: bytes.slice(2 + KID_BYTES, ENVELOPE_V1_HEADER_BYTES),
      ciphertext: bytes.slice(ENVELOPE_V1_HEADER_BYTES),
    };
  }

  if (version === ENVELOPE_V0_LEGACY) {
    if (bytes.length < ENVELOPE_V0_HEADER_BYTES + TAG_BYTES) {
      throw new CryptoFormatError(
        `Envelope is too short for format ${byteToHexLiteral(version)}: ` +
          `${bytes.length} bytes, minimum ${ENVELOPE_V0_HEADER_BYTES + TAG_BYTES}.`,
      );
    }

    return {
      version,
      alg: ALG_AES_256_GCM,
      kid: null,
      iv: bytes.slice(1, ENVELOPE_V0_HEADER_BYTES),
      ciphertext: bytes.slice(ENVELOPE_V0_HEADER_BYTES),
    };
  }

  throw new CryptoFormatError(
    `Envelope names format ${byteToHexLiteral(version)}, which this build does not implement. ` +
      "It has not been decrypted and will not be.",
  );
}

/**
 * Serialise a v0.1 envelope.
 *
 * Refuses every other format byte, including `0x00`. That refusal is the
 * structural half of "the legacy format is never emitted": it is not a rule
 * about how callers should behave, it is the absence of a code path.
 */
export function formatEnvelope(parts: Omit<ParsedEnvelope, "kid"> & { kid: string }): string {
  if (parts.version !== ENVELOPE_V1) {
    throw new CryptoInputError(
      `Refusing to emit envelope format ${byteToHexLiteral(parts.version)}. ` +
        `Only ${byteToHexLiteral(ENVELOPE_V1)} is written.`,
    );
  }
  if (parts.alg !== ALG_AES_256_GCM) {
    throw new CryptoInputError(
      `Refusing to emit algorithm ${byteToHexLiteral(parts.alg)}. ` +
        `Only ${byteToHexLiteral(ALG_AES_256_GCM)} is written.`,
    );
  }
  if (parts.kid.length !== KID_HEX_LENGTH || !KID_HEX_PATTERN.test(parts.kid)) {
    throw new CryptoInputError(
      `Key id must be ${KID_HEX_LENGTH} lower-case hex characters; received ${parts.kid.length}.`,
    );
  }
  if (parts.iv.byteLength !== IV_BYTES) {
    throw new CryptoInputError(
      `IV must be exactly ${IV_BYTES} bytes; received ${parts.iv.byteLength}.`,
    );
  }
  if (parts.ciphertext.byteLength < TAG_BYTES) {
    throw new CryptoInputError(
      `Ciphertext must carry at least the ${TAG_BYTES}-byte tag; received ${parts.ciphertext.byteLength}.`,
    );
  }

  const out = new Uint8Array(ENVELOPE_V1_HEADER_BYTES + parts.ciphertext.byteLength);
  out[0] = ENVELOPE_V1;
  out[1] = ALG_AES_256_GCM;

  for (let i = 0; i < KID_BYTES; i += 1) {
    out[2 + i] = Number.parseInt(parts.kid.slice(i * 2, i * 2 + 2), 16);
  }
  out.set(parts.iv, 2 + KID_BYTES);
  out.set(parts.ciphertext, ENVELOPE_V1_HEADER_BYTES);

  return encodeBase64Url(out);
}
