/**
 * Master key loading, derivation and the two-key ring.
 *
 * TODO(build order step 8): implement.
 *
 * PARSING -- fail closed:
 *
 *   MASTER_KEY is base64 that decodes to EXACTLY 32 bytes. Validated at config
 *   parse time, not at first use. The bug this prevents is real and silent:
 *   feeding the base64 TEXT to HKDF instead of the decoded bytes means
 *   `MASTER_KEY="hunter2"` is accepted without complaint and produces a
 *   perfectly functional secrets manager protected by a password.
 *
 * DERIVATION:
 *
 *   kid(mk) = hex(first 8 bytes of HKDF(mk, salt, "prick/v1/kid"))
 *   DEK(mk) = HKDF-SHA256(mk, salt, "prick/v1/dek/secret.value")
 *
 *   `kid` is DERIVED from the key material rather than configured, so it cannot
 *   drift from the key it names. Two deployments given the same MASTER_KEY
 *   compute the same kid; a mistyped key computes a different one and the error
 *   says so.
 *
 *   The derived CryptoKey is imported with `extractable: false`, and it is
 *   derived ONCE per isolate rather than per request -- re-deriving on every
 *   request is pure latency for no security gain.
 *
 * ROTATION:
 *
 *   MASTER_KEY = new, MASTER_KEY_OLD = previous, deploy. New writes use the new
 *   key immediately; existing rows still decrypt under the old one. A cron
 *   trigger plus POST /api/v1/admin/rekey re-encrypt incrementally, and
 *   `keyring_state.rows_remaining` drives the settings screen's
 *   "safe to remove MASTER_KEY_OLD" indicator.
 *
 * SECRETS STORE SEAM:
 *
 *   `loadMasterMaterial(env)` prefers a `secrets_store_secrets` binding when
 *   one is bound and falls back to the plain `MASTER_KEY` secret. The seam
 *   exists so that adopting Secrets Store later is a config-only change; it is
 *   deliberately not adopted now, because an open-beta control plane in front
 *   of the only root of trust of a secrets manager is a bad trade and its
 *   actual advantages (sharing across Workers, central rotation) do not apply
 *   to a single self-hosted Worker.
 */

export const MASTER_KEY_BYTES = 32;
export const HKDF_INFO_KID = "prick/v1/kid";
export const HKDF_INFO_DEK = "prick/v1/dek/secret.value";

export interface MasterMaterial {
  /** Raw 32 bytes. Never logged, never serialised, never returned by an API. */
  bytes: Uint8Array;
  /** Hex, 16 characters (8 bytes). */
  kid: string;
}

export interface Keyring {
  active: MasterMaterial;
  /** `MASTER_KEY_OLD`, when set. Decrypt-only. */
  previous: MasterMaterial | null;
}

export function loadMasterMaterial(_env: unknown): Promise<Keyring> {
  throw new Error("loadMasterMaterial() is not implemented yet");
}

export function deriveDek(_material: MasterMaterial): Promise<CryptoKey> {
  throw new Error("deriveDek() is not implemented yet");
}
