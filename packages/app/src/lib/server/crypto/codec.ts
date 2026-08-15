/**
 * Byte codecs: base64, base64url, hex, UTF-8.
 *
 * WHY NOT `atob`/`btoa`: `atob` implements the WHATWG "forgiving-base64"
 * algorithm, which strips ASCII whitespace before decoding and accepts
 * encodings whose final group carries non-zero bits that decode to nothing.
 * Forgiving is the wrong disposition for both consumers here. `MASTER_KEY` is
 * the root of trust of the entire system and the failure being guarded against
 * is precisely "a string that is not really 32 bytes of key was accepted
 * anyway"; the envelope decoder reads a value out of a database row that an
 * attacker with write access controls. Both want a decoder that rejects
 * everything it is not certain about.
 *
 * So: explicit alphabets, canonical padding, canonical trailing bits, no
 * whitespace, no alphabet mixing. Anything else throws.
 */

import { CryptoFormatError } from "./errors.js";

const BASE64_STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CHAR_PAD = 0x3d; // '='

function lookupTable(alphabet: string): Int8Array {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
}

const URL_TABLE = lookupTable(BASE64_URL);
/** Accepts either alphabet, for human-supplied configuration only. */
const EITHER_TABLE = (() => {
  const table = lookupTable(BASE64_STANDARD);
  table[BASE64_URL.charCodeAt(62)] = 62;
  table[BASE64_URL.charCodeAt(63)] = 63;
  return table;
})();

const HEX_DIGITS = "0123456789abcdef";

const utf8Encoder = new TextEncoder();
/** `fatal` so that malformed bytes throw instead of yielding U+FFFD. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A byte array backed by a plain, non-shared `ArrayBuffer`.
 *
 * Since TypeScript 5.7 the typed arrays are generic in their buffer, so a bare
 * `Uint8Array` means `Uint8Array<ArrayBufferLike>` -- which includes
 * `SharedArrayBuffer`-backed views and is therefore NOT assignable to
 * `BufferSource`, the parameter type of every `crypto.subtle` call. Naming the
 * concrete type once here keeps the WebCrypto call sites free of casts, and
 * confines the one place a cast IS needed to this file.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function encodeUtf8(text: string): Bytes {
  // `TextEncoder.encode` is declared as a bare `Uint8Array` in the generated
  // runtime types, but it allocates the buffer itself and cannot hand back a
  // shared one. This is the only assertion of its kind in the crypto layer.
  return utf8Encoder.encode(text) as Bytes;
}

/**
 * Decode UTF-8 STRICTLY.
 *
 * A decrypted plaintext that is not valid UTF-8 means the wrong bytes came
 * back, which means something is wrong that must not be papered over with
 * replacement characters. Callers turn the thrown `TypeError` into a
 * `DecryptFailedError`.
 */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_DIGITS[(byte >> 4) & 0x0f];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

/** Format a single byte as `0x0f`, for messages about format bytes. */
export function byteToHexLiteral(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

function decodeWith(text: string, table: Int8Array, label: string): Bytes {
  let end = text.length;
  let padding = 0;
  while (end > 0 && text.charCodeAt(end - 1) === CHAR_PAD) {
    end -= 1;
    padding += 1;
  }

  if (padding > 2) {
    throw new CryptoFormatError(`${label} carries more than two padding characters.`);
  }
  const remainder = end % 4;
  if (remainder === 1) {
    throw new CryptoFormatError(`${label} is not valid base64: its length is not a whole group.`);
  }
  if (padding > 0 && (end + padding) % 4 !== 0) {
    throw new CryptoFormatError(`${label} is not padded to a multiple of four characters.`);
  }

  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;

  for (let i = 0; i < end; i += 1) {
    const charCode = text.charCodeAt(i);
    const value = charCode < 128 ? (table[charCode] ?? -1) : -1;
    if (value < 0) {
      // The offending character is NOT echoed. This decoder is pointed at
      // master key material.
      throw new CryptoFormatError(`${label} contains a character that is not valid base64.`);
    }
    // Masked to 16 bits. `bits` never exceeds 12, so nothing meaningful is
    // above that, and without the mask the accumulator overflows into the sign
    // bit on any input longer than five characters -- harmless here, but only
    // by an argument about which bits are read rather than by construction.
    accumulator = ((accumulator << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (accumulator >> bits) & 0xff;
      offset += 1;
    }
  }

  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    // "AB" decodes to one byte and discards four bits. A canonical encoder
    // never emits those bits set, so a value that has them was not produced by
    // one -- and two distinct strings decoding to identical bytes is exactly
    // the ambiguity this whole layer is built to avoid.
    throw new CryptoFormatError(`${label} is not canonically encoded.`);
  }

  return out;
}

function encodeWith(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(triple >> 18) & 0x3f];
    out += alphabet[(triple >> 12) & 0x3f];
    out += alphabet[(triple >> 6) & 0x3f];
    out += alphabet[triple & 0x3f];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = (bytes[i] ?? 0) << 16;
    out += alphabet[(chunk >> 18) & 0x3f];
    out += alphabet[(chunk >> 12) & 0x3f];
    if (pad) out += "==";
  } else if (remaining === 2) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += alphabet[(chunk >> 18) & 0x3f];
    out += alphabet[(chunk >> 12) & 0x3f];
    out += alphabet[(chunk >> 6) & 0x3f];
    if (pad) out += "=";
  }

  return out;
}

/** Unpadded base64url. The envelope encoding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeWith(bytes, BASE64_URL, false);
}

/**
 * Decode base64url. Padding is tolerated, the standard `+`/`/` alphabet is NOT
 * -- this decoder only reads a format we emit, so it should accept exactly
 * that format.
 */
export function decodeBase64Url(text: string, label = "Envelope"): Bytes {
  return decodeWith(text, URL_TABLE, label);
}

/** Padded standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
  return encodeWith(bytes, BASE64_STANDARD, true);
}

/**
 * Decode operator-supplied base64.
 *
 * Both alphabets are accepted here and only here: an operator generating a key
 * may reach for `openssl rand -base64 32` or for a URL-safe generator, and
 * refusing one of them buys nothing -- the two decode to the same bytes, and it
 * is the BYTES that become the key. Padding may be present or absent.
 */
export function decodeBase64Flexible(text: string, label: string): Bytes {
  return decodeWith(text, EITHER_TABLE, label);
}

/** Non-short-circuiting byte comparison. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}
