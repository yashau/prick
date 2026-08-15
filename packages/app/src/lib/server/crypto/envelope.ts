/**
 * The stored ciphertext envelope.
 *
 * TODO(build order step 8): implement with the tamper suite.
 *
 *   base64url( version || alg || kid[8] || iv[12] || ciphertext||tag )
 *
 * BYTE 0 IS READ FIRST and dispatches. An unknown format byte THROWS; it is
 * never guessed at, never best-effort decoded, and never treated as the current
 * format on the assumption that it probably is.
 *
 * Formats:
 *
 *   0x00  v0 -- legacy, no AAD. DECRYPT-ONLY, NEVER EMITTED. Accepted so that
 *         a v0 export can be imported and immediately re-encrypted as 0x01.
 *         Nothing in this codebase may produce a 0x00 envelope.
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

export const ENVELOPE_V0_LEGACY = 0x00;
export const ENVELOPE_V1 = 0x01;

export const ALG_AES_256_GCM = 0x01;

export const KID_BYTES = 8;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface ParsedEnvelope {
  version: number;
  alg: number;
  /** Hex. `null` for a v0 envelope, which carries none. */
  kid: string | null;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export function parseEnvelope(_blob: string): ParsedEnvelope {
  throw new Error("parseEnvelope() is not implemented yet");
}

export function formatEnvelope(_parts: Omit<ParsedEnvelope, "kid"> & { kid: string }): string {
  throw new Error("formatEnvelope() is not implemented yet");
}
