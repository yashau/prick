/**
 * Master key loading, derivation and the rotation ring.
 *
 * PARSING -- fail closed:
 *
 *   MASTER_KEY is base64 that decodes to EXACTLY 32 bytes. It is validated when
 *   the ring is built, before any route runs, so a bad key means the Worker
 *   refuses EVERY request -- including /health -- rather than answering happily
 *   until the first secret is read.
 *
 *   The DECODED BYTES are the HKDF input keying material. Not the base64 text.
 *   Feeding HKDF the text is the failure this validation exists to make
 *   impossible, because it is completely silent: `MASTER_KEY="hunter2"` is
 *   accepted, HKDF happily stretches those seven bytes, and the result is a
 *   fully functional secrets manager protected by a password. Nothing observable
 *   at runtime distinguishes it from a correct deployment.
 *
 * DERIVATION:
 *
 *   kid(mk) = hex(first 8 bytes of HKDF-SHA256(ikm = mk, salt, "prick/v1/kid"))
 *   DEK(mk) = HKDF-SHA256(ikm = mk, salt, "prick/v1/dek/secret.value")
 *
 *   `kid` is DERIVED from the key material rather than configured, so it cannot
 *   drift from the key it names. Two deployments given the same MASTER_KEY
 *   compute the same kid; a mistyped key computes a different one, and the
 *   resulting error names it.
 *
 *   THE SALT AND THE INFO STRINGS ARE PART OF THE STORAGE FORMAT. Changing
 *   either changes every kid and every DEK, which makes every stored row
 *   undecryptable. They are constants, not configuration.
 *
 *   The DEK is imported with `extractable: false`, so it cannot be read back
 *   out of the runtime -- not by later code in this file, not by a bug
 *   elsewhere that gets hold of the `CryptoKey`.
 *
 *   THE RAW MASTER BYTES ARE NOT RETAINED. Once `kid` and the DEK are derived,
 *   the decoded material goes out of scope; the `Keyring` holds a non-
 *   extractable `CryptoKey` and a hex id, and nothing else. There is no field
 *   on any object here that a serialiser, a logger or a debugger could render
 *   into key material.
 *
 * MEMOISATION:
 *
 *   Two HKDF derivations per key, once per isolate, keyed on a hash of the
 *   concatenated material. Re-deriving on every request is pure latency for no
 *   security gain. The cache key is a hash rather than the material itself so
 *   that a test suite exercising several different keys does not collide, and
 *   so that no module-scope map is keyed by a live master key.
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

import { bytesEqual, decodeBase64Flexible, encodeUtf8, toHex, type Bytes } from "./codec.js";
import { KID_BYTES } from "./envelope.js";
import { MasterKeyConfigError } from "./errors.js";

export const MASTER_KEY_BYTES = 32;
export const HKDF_INFO_KID = "prick/v1/kid";
export const HKDF_INFO_DEK = "prick/v1/dek/secret.value";

/**
 * The HKDF salt. Fixed, public, and load-bearing: it is not a secret, but it is
 * part of the derivation, so it may never change.
 */
export const HKDF_SALT_TEXT = "prick/v1/keyring";

const HKDF_SALT = encodeUtf8(HKDF_SALT_TEXT);
const INFO_KID = encodeUtf8(HKDF_INFO_KID);
const INFO_DEK = encodeUtf8(HKDF_INFO_DEK);

/** One master key, reduced to the only two things anything needs from it. */
export interface KeyringKey {
  /** Hex, 16 characters (8 bytes). Not secret; it appears in every row. */
  readonly kid: string;
  /** AES-256-GCM, `extractable: false`. */
  readonly dek: CryptoKey;
}

export interface Keyring {
  readonly active: KeyringKey;
  /** `MASTER_KEY_OLD`. Decrypt-only; nothing is ever written under these. */
  readonly retired: readonly KeyringKey[];
  /** Every kid in the ring, active first. Safe to put in an error message. */
  readonly kids: readonly string[];
  find(kid: string): KeyringKey | undefined;
}

/** The raw, still-encoded material, exactly as configuration supplied it. */
export interface MasterMaterial {
  active: string;
  retired: string[];
}

/** Structural shape of a `secrets_store_secrets` binding. */
export interface SecretsStoreBinding {
  get(): Promise<string>;
}

/**
 * The bindings this module reads.
 *
 * Declared structurally rather than as `Env` because `MASTER_KEY` is a Worker
 * SECRET: `wrangler types` only knows about `vars` and bindings declared in
 * `wrangler.jsonc`, so it does not appear on the generated `Env` at all. An
 * `Env` argument would typecheck against a type that cannot describe the thing
 * being read.
 */
export interface MasterKeyEnv {
  MASTER_KEY?: string | undefined;
  MASTER_KEY_OLD?: string | undefined;
  MASTER_KEY_STORE?: SecretsStoreBinding | undefined;
  MASTER_KEY_OLD_STORE?: SecretsStoreBinding | undefined;
}

function isSecretsStoreBinding(value: unknown): value is SecretsStoreBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

async function readBinding(
  store: unknown,
  plain: unknown,
  name: string,
): Promise<string | undefined> {
  if (isSecretsStoreBinding(store)) {
    try {
      return await store.get();
    } catch (cause) {
      throw new MasterKeyConfigError(
        `The Secrets Store binding for ${name} is bound but could not be read.`,
        { cause },
      );
    }
  }
  if (typeof plain === "string") return plain;
  if (plain !== undefined && plain !== null) {
    throw new MasterKeyConfigError(`${name} is bound but is not a string.`);
  }
  return undefined;
}

/**
 * THE ONE ACCESSOR for master key material.
 *
 * Everything else in the codebase goes through this, which is what makes the
 * Secrets Store migration a config change: the preference order lives here and
 * nowhere else.
 *
 * `MASTER_KEY_OLD` may name more than one retired key, comma-separated. Base64
 * never contains a comma in either alphabet, so the separator is unambiguous
 * for this field in a way it would not be for a secret key name -- which is
 * exactly why the AAD next door is length-prefixed instead.
 */
export async function loadMasterMaterial(env: MasterKeyEnv): Promise<MasterMaterial> {
  const active = await readBinding(env.MASTER_KEY_STORE, env.MASTER_KEY, "MASTER_KEY");
  const retiredRaw = await readBinding(
    env.MASTER_KEY_OLD_STORE,
    env.MASTER_KEY_OLD,
    "MASTER_KEY_OLD",
  );

  if (active === undefined || active.trim() === "") {
    throw new MasterKeyConfigError(
      "MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and " +
        "install it with `wrangler secret put MASTER_KEY`.",
    );
  }

  const retired = (retiredRaw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  return { active: active.trim(), retired };
}

function decodeMasterKey(text: string, name: string): Bytes {
  let bytes: Bytes;
  try {
    bytes = decodeBase64Flexible(text, name);
  } catch (cause) {
    throw new MasterKeyConfigError(
      `${name} is not valid base64. It must be the base64 of exactly ${MASTER_KEY_BYTES} random bytes.`,
      { cause },
    );
  }

  if (bytes.byteLength !== MASTER_KEY_BYTES) {
    // The DECODED length is reported. The value is not, and neither is any
    // prefix of it.
    throw new MasterKeyConfigError(
      `${name} decodes to ${bytes.byteLength} bytes; exactly ${MASTER_KEY_BYTES} are required. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }

  return bytes;
}

async function deriveKeyringKey(material: Bytes): Promise<KeyringKey> {
  // HKDF keys are never extractable -- WebCrypto requires it -- and the only
  // usages they may carry are the two derive operations.
  const ikm = await crypto.subtle.importKey("raw", material, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);

  const kidBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: INFO_KID },
    ikm,
    KID_BYTES * 8,
  );

  const dek = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: INFO_DEK },
    ikm,
    { name: "AES-GCM", length: 256 },
    // extractable: false. The data encryption key cannot be read back out.
    false,
    ["encrypt", "decrypt"],
  );

  return { kid: toHex(new Uint8Array(kidBits)), dek };
}

const keyringCache = new Map<string, Promise<Keyring>>();
/**
 * A running Worker holds one ring, two during a rotation. The bound exists so
 * that a test suite or an import script cycling through many keys cannot grow
 * this map without limit.
 */
const KEYRING_CACHE_MAX = 8;

async function cacheKeyFor(material: MasterMaterial): Promise<string> {
  // Length-prefixed, for the same reason the AAD is: a delimiter would make
  // {active: "a,b", retired: []} and {active: "a", retired: ["b"]} collide, and
  // those are different rings.
  const parts = [material.active, ...material.retired];
  let joined = "";
  for (const part of parts) joined += `${part.length}:${part}`;

  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(joined));
  return toHex(new Uint8Array(digest));
}

async function deriveKeyring(material: MasterMaterial): Promise<Keyring> {
  const activeBytes = decodeMasterKey(material.active, "MASTER_KEY");

  const retiredBytes = material.retired.map((text, index) =>
    decodeMasterKey(text, `MASTER_KEY_OLD[${index}]`),
  );

  for (const [index, bytes] of retiredBytes.entries()) {
    if (bytesEqual(bytes, activeBytes)) {
      throw new MasterKeyConfigError(
        `MASTER_KEY_OLD[${index}] is the same key as MASTER_KEY. A retired key must be the ` +
          "PREVIOUS key; listing the active one there means the rotation has not actually " +
          "happened and the 'safe to remove' indicator would go green while nothing had moved.",
      );
    }
  }

  const active = await deriveKeyringKey(activeBytes);
  const retired = await Promise.all(retiredBytes.map(deriveKeyringKey));

  const byKid = new Map<string, KeyringKey>();
  for (const entry of [active, ...retired]) {
    const existing = byKid.get(entry.kid);
    if (existing !== undefined) {
      throw new MasterKeyConfigError(
        `Two keys in the ring derive the same key id ${entry.kid}. Every key in MASTER_KEY and ` +
          "MASTER_KEY_OLD must be distinct, or a row cannot be attributed to the key that " +
          "protects it and the rekey job cannot tell what is left to do.",
      );
    }
    byKid.set(entry.kid, entry);
  }

  return {
    active,
    retired,
    kids: [...byKid.keys()],
    find: (kid) => byKid.get(kid),
  };
}

/**
 * Build (or return the memoised) keyring for some master material.
 *
 * Throws `MasterKeyConfigError` on anything wrong with the material. Callers do
 * not catch it: it is the fail-closed path.
 */
export async function buildKeyring(material: MasterMaterial): Promise<Keyring> {
  const cacheKey = await cacheKeyFor(material);

  const cached = keyringCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pending = deriveKeyring(material);
  // A rejected promise is not kept: a misconfiguration should re-report itself
  // rather than be answered from a cache, and holding a rejected promise
  // indefinitely produces spurious unhandled-rejection noise.
  pending.catch(() => keyringCache.delete(cacheKey));

  if (keyringCache.size >= KEYRING_CACHE_MAX) {
    const oldest = keyringCache.keys().next();
    if (!oldest.done) keyringCache.delete(oldest.value);
  }
  keyringCache.set(cacheKey, pending);

  return pending;
}

/**
 * The keyring for this environment.
 *
 * THE WORKER ENTRY MUST AWAIT THIS BEFORE ROUTING, on every route including
 * `/health`. That is what makes a misconfigured `MASTER_KEY` a 500 on
 * everything rather than a surprise on the first read: a secrets manager that
 * answers `/health` with 200 while its root of trust is unusable is reporting
 * the opposite of the truth.
 */
export async function getKeyring(env: MasterKeyEnv): Promise<Keyring> {
  return buildKeyring(await loadMasterMaterial(env));
}
