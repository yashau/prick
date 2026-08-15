/**
 * AEAD additional authenticated data.
 *
 * This is the most important file in the repository, and the one thing here
 * that genuinely cannot be retrofitted: once rows exist without AAD, every one
 * of them has to be decrypted and re-encrypted to gain it.
 *
 * The defect it closes: an AES-GCM ciphertext with no additional data is bound
 * to nothing. Every blob in the table is interchangeable with every other, so
 * anyone with write access to the database can transplant a production secret
 * into a development environment they are allowed to read, and the decryption
 * succeeds, because there is nothing to contradict.
 *
 * Layout:
 *
 *   AAD = "prick" || 0x01
 *       || len16(purpose)        || purpose          ("secret.value")
 *       || len16(environment_id) || environment_id
 *       || len16(key)            || key
 *       || u32be(version)
 *
 * EVERY variable-length field is LENGTH-PREFIXED with a big-endian u16. It is
 * not delimiter-separated, and the difference is not stylistic: a delimiter
 * scheme becomes ambiguous the instant a field can contain the delimiter, and
 * "the key can't contain a colon" is an assumption, not a guarantee.
 * Length-prefixing is unconditionally injective for two bytes per field.
 *
 * The property that is tested explicitly: {key: "AB", env: "C"} and
 * {key: "A", env: "BC"} MUST produce different AAD. A separator scheme fails
 * exactly this.
 *
 * The lengths are counted in UTF-8 BYTES, not in JavaScript string units. A
 * length prefix that counted UTF-16 code units while the payload was written
 * as UTF-8 would not describe the bytes that follow it, which reintroduces the
 * ambiguity by another route.
 *
 * What binding these four fields buys, all as GCM tag failures:
 *
 *   environment_id -> cross-environment transplant
 *   key            -> cross-key transplant
 *   version        -> rollback and roll-forward replay
 *   purpose        -> reuse of a value blob in some future non-value context
 *
 * `project_id` is DELIBERATELY EXCLUDED. Including it would promote "an
 * environment can never be reparented" into a cryptographic invariant, so any
 * future reparent would require re-encrypting every row in the project. Instead
 * `environments.id` and `.project_id` are documented as immutable and there is
 * no reparent operation -- a schema constraint rather than a crypto one.
 *
 * `kid` is ALSO excluded, and for the opposite reason: a rekey must change
 * which key protects a row without changing the row's identity. `kid` lives in
 * the envelope, so re-encrypting under a new master key leaves the AAD -- and
 * therefore the version -- untouched.
 *
 * NOTHING IN THIS ENCODING MAY EVER CHANGE. Every stored row's tag was computed
 * over these exact bytes; altering the magic, the version byte, the field order
 * or the prefix width makes every existing row undecryptable. A new binding
 * requires a new envelope format byte, not an edit here.
 */

import { encodeUtf8, type Bytes } from "./codec.js";
import { CryptoInputError } from "./errors.js";

export const AAD_MAGIC = "prick";
export const AAD_VERSION = 0x01;
export const PURPOSE_SECRET_VALUE = "secret.value";

/** The widest field a u16 length prefix can describe. */
export const AAD_MAX_FIELD_BYTES = 0xffff;
/** The widest version a u32be can describe. */
export const AAD_MAX_VERSION = 0xffff_ffff;

const MAGIC_BYTES = encodeUtf8(AAD_MAGIC);

export interface SecretValueAadInput {
  environmentId: string;
  key: string;
  version: number;
  /**
   * Defaults to `secret.value`. Present as a parameter so that a future
   * encrypted field -- a grant note, an audit detail -- gets its own domain
   * without any chance of a value blob being replayed into it.
   */
  purpose?: string;
}

function encodeField(value: string, name: string): Bytes {
  if (value.length === 0) {
    throw new CryptoInputError(`AAD field "${name}" is empty; it is part of the row's identity.`);
  }
  const bytes = encodeUtf8(value);
  if (bytes.byteLength > AAD_MAX_FIELD_BYTES) {
    throw new CryptoInputError(
      `AAD field "${name}" is longer than the ${AAD_MAX_FIELD_BYTES}-byte maximum.`,
    );
  }
  return bytes;
}

/**
 * Build the additional data a `secret.value` ciphertext is bound to.
 *
 * Pure and synchronous: same inputs, same bytes, forever.
 */
export function buildSecretValueAad(input: SecretValueAadInput): Bytes {
  const purpose = encodeField(input.purpose ?? PURPOSE_SECRET_VALUE, "purpose");
  const environmentId = encodeField(input.environmentId, "environment_id");
  const key = encodeField(input.key, "key");

  const { version } = input;
  if (!Number.isInteger(version) || version < 0 || version > AAD_MAX_VERSION) {
    throw new CryptoInputError(
      `AAD field "version" must be an integer in [0, ${AAD_MAX_VERSION}]; received ${String(version)}.`,
    );
  }

  const size =
    MAGIC_BYTES.byteLength +
    1 +
    2 +
    purpose.byteLength +
    2 +
    environmentId.byteLength +
    2 +
    key.byteLength +
    4;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(MAGIC_BYTES, offset);
  offset += MAGIC_BYTES.byteLength;

  out[offset] = AAD_VERSION;
  offset += 1;

  for (const field of [purpose, environmentId, key]) {
    view.setUint16(offset, field.byteLength, false);
    offset += 2;
    out.set(field, offset);
    offset += field.byteLength;
  }

  view.setUint32(offset, version, false);
  offset += 4;

  /* istanbul ignore next -- structural invariant, not a runtime condition */
  if (offset !== size) {
    throw new CryptoInputError("AAD encoder wrote the wrong number of bytes.");
  }

  return out;
}
