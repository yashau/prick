/**
 * AEAD additional authenticated data.
 *
 * TODO(build order step 8): implement THIS FIRST, together with the tamper
 * suite, before any database code exists. This is the piece that cannot be
 * retrofitted: once rows are written without AAD, every one of them has to be
 * re-encrypted to gain it.
 *
 * The defect this closes: an AES-GCM ciphertext with no additional data is
 * bound to nothing. Every blob in the table is interchangeable with every
 * other, so anyone with D1 write access can transplant a production secret into
 * a development environment they are allowed to read, and the decryption
 * succeeds because there is nothing to contradict.
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
 * The property that must be tested explicitly: {key: "AB", env: "C"} and
 * {key: "A", env: "BC"} MUST produce different AAD. A separator scheme fails
 * exactly this.
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
 */

export const AAD_MAGIC = "prick";
export const AAD_VERSION = 0x01;
export const PURPOSE_SECRET_VALUE = "secret.value";

export interface SecretValueAadInput {
  environmentId: string;
  key: string;
  version: number;
}

export function buildSecretValueAad(_input: SecretValueAadInput): Uint8Array {
  throw new Error("buildSecretValueAad() is not implemented yet");
}
