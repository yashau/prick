import type { SecretValueAadInput } from "./aad.js";
import type { Keyring } from "./keyring.js";

export * from "./aad.js";
export * from "./envelope.js";
export * from "./keyring.js";

/**
 * TODO(build order step 8): encrypt a secret value.
 *
 * ALWAYS emits format 0x01 with full AAD. There is no code path that produces
 * a 0x00 envelope.
 */
export function encryptSecretValue(
  _keyring: Keyring,
  _aad: SecretValueAadInput,
  _plaintext: string,
): Promise<string> {
  throw new Error("encryptSecretValue() is not implemented yet");
}

/**
 * TODO(build order step 8): decrypt a secret value.
 *
 * Accepts 0x00 (legacy, no AAD) and 0x01. Tries the active key, then the
 * previous one. Every failure THROWS -- there is no path that returns null, an
 * empty string, or a "skipped" marker. `DECRYPT_FAILED` is surfaced loudly
 * because a tamper attempt must be the most conspicuous event in the system.
 *
 * THE TAMPER SUITE, which must be green before any database code is written.
 * Encrypt `DATABASE_URL` in environment A at v3, then assert decrypt THROWS
 * for every one of:
 *
 *   - the same blob presented with `environment_id = B`   (transplant)
 *   - the same blob presented with a different `key`      (transplant)
 *   - the same blob presented at version 2                (rollback replay)
 *   - the same blob presented at version 4                (roll-forward)
 *   - a single flipped bit in the ciphertext
 *   - a single flipped bit in the tag
 *   - a single flipped bit in the IV
 *   - a truncated envelope
 *   - an unknown format byte
 *   - an unknown kid                                      (names the kid)
 *
 * Plus length-prefix injectivity: {key:"AB", env:"C"} and {key:"A", env:"BC"}
 * must produce different AAD.
 */
export function decryptSecretValue(
  _keyring: Keyring,
  _aad: SecretValueAadInput,
  _blob: string,
): Promise<string> {
  throw new Error("decryptSecretValue() is not implemented yet");
}
