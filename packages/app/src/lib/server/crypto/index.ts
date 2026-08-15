/**
 * Sealing and opening a secret value.
 *
 * Two functions, and between them one rule: THEY EITHER RETURN A CORRECT
 * RESULT OR THEY THROW. There is no path here that returns `null`, an empty
 * string, a "skipped" marker or a partially-decoded value. A tamper attempt has
 * to be the loudest thing in the system, and the way that is guaranteed is that
 * the only alternative to success is an exception -- the caller cannot
 * accidentally treat a failure as an absent row, which is how an environment
 * quietly deploys without its DATABASE_URL.
 *
 * The tamper suite in `test/crypto/aad.test.ts` is the specification for that
 * behaviour and is written against these two signatures.
 */

import { SECRET_VALUE_MAX_BYTES } from "@prick/shared";

import { buildSecretValueAad } from "./aad.js";
import { decodeUtf8, encodeUtf8 } from "./codec.js";
import {
  ALG_AES_256_GCM,
  ENVELOPE_V0_LEGACY,
  ENVELOPE_V1,
  formatEnvelope,
  IV_BYTES,
  parseEnvelope,
  TAG_BYTES,
} from "./envelope.js";
import {
  CryptoFormatError,
  DecryptFailedError,
  SecretTooLargeError,
  UnknownKeyError,
} from "./errors.js";
import type { Keyring, KeyringKey } from "./keyring.js";

export * from "./aad.js";
export * from "./codec.js";
export * from "./envelope.js";
export * from "./errors.js";
export * from "./keyring.js";

const GCM_TAG_BITS = TAG_BYTES * 8;

export interface EncryptSecretValueInput {
  /**
   * The active DEK, and the kid that names it.
   *
   * PASS BOTH FROM THE SAME `KeyringKey` -- `keyring.active.dek` with
   * `keyring.active.kid`, never one from the active key and one from a retired
   * one. Nothing here can detect a mismatch: the DEK is non-extractable, so
   * there is no way to re-derive its id and compare. A mismatched pair encrypts
   * and stores perfectly happily and produces a row that names a key which
   * cannot open it -- undetectable until someone tries to read it, and by then
   * every write since has the same defect.
   *
   * Writes always use `keyring.active`. A retired key is decrypt-only.
   */
  dek: CryptoKey;
  kid: string;
  environmentId: string;
  key: string;
  version: number;
  plaintext: string;
  /** Defaults to `secret.value`. */
  purpose?: string;
  /**
   * `SECRET_MAX_BYTES`, from the runtime config. Enforced on the UTF-8 ENCODED
   * length, never on `plaintext.length`: a JavaScript string length counts
   * UTF-16 code units, so a limit checked against it lets a value of emoji or
   * CJK text through at up to three or four times the intended size, and
   * rejects a perfectly legal ASCII value of the intended size never. The row
   * is stored in bytes, so the limit is in bytes.
   */
  maxBytes?: number;
}

/**
 * Seal a secret value.
 *
 * ALWAYS emits format 0x01 with full AAD. There is no parameter that selects a
 * format and no code path that produces a 0x00 envelope; `formatEnvelope`
 * refuses one even if a caller assembled the parts by hand.
 */
export async function encryptSecretValue(input: EncryptSecretValueInput): Promise<string> {
  const maxBytes = input.maxBytes ?? SECRET_VALUE_MAX_BYTES;
  const plaintext = encodeUtf8(input.plaintext);

  if (plaintext.byteLength > maxBytes) {
    throw new SecretTooLargeError(maxBytes);
  }

  const aad = buildSecretValueAad({
    environmentId: input.environmentId,
    key: input.key,
    version: input.version,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  });

  // Fresh every time. A repeated (key, IV) pair in GCM is catastrophic -- it
  // leaks the XOR of the two plaintexts and, worse, the authentication subkey.
  // 96 random bits per encryption is the standard construction; nothing here
  // reuses, derives or counters an IV.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: GCM_TAG_BITS },
    input.dek,
    plaintext,
  );

  return formatEnvelope({
    version: ENVELOPE_V1,
    alg: ALG_AES_256_GCM,
    kid: input.kid,
    iv,
    ciphertext: new Uint8Array(sealed),
  });
}

export interface DecryptSecretValueInput {
  keyring: Keyring;
  /** The stored `secret_versions.ciphertext`. */
  envelope: string;
  environmentId: string;
  key: string;
  version: number;
  /** Defaults to `secret.value`. */
  purpose?: string;
  /**
   * Whether to accept the legacy no-AAD format. Defaults to `true`, because
   * the import path exists to read exactly those rows and re-seal them.
   *
   * Pass `false` from a read path that should only ever see rows this
   * deployment wrote. A v0 row is bound to nothing, so it IS transplantable --
   * that is the property v0 lacks and the reason import re-encrypts
   * immediately rather than leaving rows in place.
   */
  allowLegacyV0?: boolean;
}

/**
 * Open a secret value.
 *
 * Every failure throws. In particular an AEAD failure and a
 * presented-under-the-wrong-identity failure are indistinguishable to AES-GCM
 * and are reported the same way -- which is correct, because they are the same
 * event: the bytes were not sealed against the identity they are being opened
 * under.
 */
export async function decryptSecretValue(input: DecryptSecretValueInput): Promise<string> {
  const parsed = parseEnvelope(input.envelope);

  if (parsed.version === ENVELOPE_V1) {
    if (parsed.kid === null) {
      throw new CryptoFormatError("Envelope format 0x01 carries no key id.");
    }

    const entry = input.keyring.find(parsed.kid);
    if (entry === undefined) {
      throw new UnknownKeyError(parsed.kid, input.keyring.kids);
    }

    const aad = buildSecretValueAad({
      environmentId: input.environmentId,
      key: input.key,
      version: input.version,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    });

    let opened: ArrayBuffer;
    try {
      opened = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: parsed.iv, additionalData: aad, tagLength: GCM_TAG_BITS },
        entry.dek,
        parsed.ciphertext,
      );
    } catch (cause) {
      throw new DecryptFailedError(describeFailure(input, parsed.kid), { cause });
    }

    return finish(opened, input, parsed.kid);
  }

  if (parsed.version === ENVELOPE_V0_LEGACY) {
    if (input.allowLegacyV0 === false) {
      throw new CryptoFormatError(
        "Envelope is in the legacy no-AAD format, which this read path does not accept.",
      );
    }

    // No key id, so the ring is tried in order. This loop swallows nothing: if
    // no key opens the blob it falls through to a throw, exactly as the v1
    // path does.
    const candidates: KeyringKey[] = [input.keyring.active, ...input.keyring.retired];
    for (const candidate of candidates) {
      let opened: ArrayBuffer;
      try {
        opened = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: parsed.iv, tagLength: GCM_TAG_BITS },
          candidate.dek,
          parsed.ciphertext,
        );
      } catch {
        continue;
      }
      return finish(opened, input, candidate.kid);
    }

    throw new DecryptFailedError(describeFailure(input, null));
  }

  /* istanbul ignore next -- parseEnvelope has already rejected every other byte */
  throw new CryptoFormatError("Envelope names a format this build does not implement.");
}

function finish(opened: ArrayBuffer, input: DecryptSecretValueInput, kid: string): string {
  try {
    return decodeUtf8(opened);
  } catch (cause) {
    // The tag verified but the bytes are not text. Returning them with
    // replacement characters would be returning a wrong plaintext, which is the
    // one outcome this module must never produce.
    throw new DecryptFailedError(describeFailure(input, kid), { cause });
  }
}

/**
 * Build the failure message.
 *
 * Names the ROW -- environment, key, version, kid -- and never the value or the
 * ciphertext. That is the whole distinction AGENTS.md draws: an error message
 * identifies which secret failed so an operator can act, and carries nothing
 * that would make the log line itself worth stealing.
 */
function describeFailure(input: DecryptSecretValueInput, kid: string | null): string {
  return (
    `Authenticated decryption failed for key "${input.key}" version ${input.version} in ` +
    `environment ${input.environmentId}${kid === null ? "" : ` under key id ${kid}`}. ` +
    "The stored bytes were not sealed against this identity: either the row has been " +
    "altered, or it belongs to a different environment, key or version."
  );
}
