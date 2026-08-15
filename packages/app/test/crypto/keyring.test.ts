/**
 * The keyring: parsing, derivation, rotation, and failing closed.
 *
 * The single most important assertion in this file is `derives the same kid
 * from the same BYTES however they were spelled`. It is the only test that can
 * distinguish "HKDF was given the decoded 32 bytes" from "HKDF was given the
 * base64 text", and the difference between those two is a secrets manager
 * protected by 256 bits of entropy and one protected by whatever the operator
 * typed. Every other test here would pass under both implementations.
 */
import { describe, expect, it } from "vitest";

import {
  buildKeyring,
  decodeBase64Flexible,
  encodeBase64,
  encodeBase64Url,
  getKeyring,
  HKDF_INFO_DEK,
  HKDF_INFO_KID,
  HKDF_SALT_TEXT,
  loadMasterMaterial,
  MASTER_KEY_BYTES,
  MasterKeyConfigError,
  toHex,
} from "../../src/lib/server/crypto/index.js";

/** 32 bytes, base64. Test material only; it protects nothing. */
const MASTER_A = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const MASTER_B = "f359fHt6eXh3dnV0c3JxcG9ubWxramloZ2ZlZGNiYWA=";
/** Chosen so its standard base64 contains both `+` and `/`. */
const MASTER_C = "+/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("derivation", () => {
  it("derives a locked kid from a fixed master key vector", async () => {
    const keyring = await buildKeyring({ active: MASTER_A, retired: [] });

    // LOCKED VECTOR. If this value changes, every stored row in every existing
    // deployment has become undecryptable -- the salt, the info string, the
    // digest or the input keying material moved. It is not a value to update.
    //
    // Cross-checked against an independent HKDF-SHA256 implementation rather
    // than recorded from this one, so it pins the ALGORITHM and not merely this
    // build's behaviour:
    //
    //   hkdfSync("sha256", <32 bytes 0x00..0x1f>,
    //            "prick/v1/keyring", "prick/v1/kid", 8)
    //     = 68db8c75e111f4df
    expect(keyring.active.kid).toBe("68db8c75e111f4df");
    expect(keyring.active.kid).toMatch(/^[0-9a-f]{16}$/);

    // The NEGATIVE vector, and the reason this test exists. Feeding HKDF the
    // base64 TEXT instead of the 32 decoded bytes produces this instead, and
    // nothing else observable at runtime differs -- the deployment works
    // perfectly, protected by whatever the operator typed.
    expect(keyring.active.kid).not.toBe("12b02f6fc97b9a67");
  });

  it("pins the salt and info strings that the vector depends on", () => {
    expect(HKDF_SALT_TEXT).toBe("prick/v1/keyring");
    expect(HKDF_INFO_KID).toBe("prick/v1/kid");
    expect(HKDF_INFO_DEK).toBe("prick/v1/dek/secret.value");
  });

  it("derives the same kid from the same bytes however they were spelled", async () => {
    const bytes = decodeBase64Flexible(MASTER_C, "fixture");
    expect(bytes.byteLength).toBe(MASTER_KEY_BYTES);

    const padded = encodeBase64(bytes); // A+/ alphabet, trailing '='
    const unpadded = padded.replace(/=+$/, "");
    const urlSafe = encodeBase64Url(bytes); // -_ alphabet, no padding

    expect(padded).not.toBe(urlSafe);

    const kids = await Promise.all(
      [padded, unpadded, urlSafe].map(
        async (active) => (await buildKeyring({ active, retired: [] })).active.kid,
      ),
    );

    // Three different strings, one set of bytes, one kid. This can only hold if
    // the DECODED bytes are the HKDF input.
    expect(new Set(kids).size).toBe(1);
  });

  it("derives different kids for different keys", async () => {
    const a = await buildKeyring({ active: MASTER_A, retired: [] });
    const b = await buildKeyring({ active: MASTER_B, retired: [] });

    expect(a.active.kid).not.toBe(b.active.kid);
  });

  it("imports the data encryption key as non-extractable", async () => {
    const keyring = await buildKeyring({ active: MASTER_A, retired: [] });

    expect(keyring.active.dek.extractable).toBe(false);
    expect(keyring.active.dek.type).toBe("secret");
    expect([...keyring.active.dek.usages].sort()).toEqual(["decrypt", "encrypt"]);
    await expect(crypto.subtle.exportKey("raw", keyring.active.dek)).rejects.toThrow();
  });

  it("retains no master key material on the ring", async () => {
    const keyring = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });

    // Nothing serialisable on the ring may contain the material. If a `bytes`
    // field is ever added back, this fails.
    const rendered = JSON.stringify(keyring, (_key, value: unknown) =>
      value instanceof Uint8Array ? toHex(value) : value,
    );

    expect(rendered).not.toContain(MASTER_A);
    expect(rendered).not.toContain(MASTER_A.replace(/=+$/, ""));
    expect(rendered).not.toContain(toHex(decodeBase64Flexible(MASTER_A, "fixture")));
  });
});

describe("parsing fails closed", () => {
  const reject = async (active: string) =>
    expect(buildKeyring({ active, retired: [] })).rejects.toBeInstanceOf(MasterKeyConfigError);

  it("rejects a 31-byte master key", async () => {
    await reject(encodeBase64(new Uint8Array(31).fill(0x11)));
  });

  it("rejects a 33-byte master key", async () => {
    await reject(encodeBase64(new Uint8Array(33).fill(0x22)));
  });

  it("rejects an empty master key", async () => {
    await reject("");
  });

  it("rejects a master key that is not base64", async () => {
    await reject("this is not base64");
    await reject("****************************************????");
    await reject("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdH.8=");
  });

  it("rejects base64 that is padded or encoded non-canonically", async () => {
    // 43 data characters cannot carry two padding characters.
    await reject(`${MASTER_A}=`);
    // The final character carries bits that decode to nothing, so this string
    // and MASTER_A would decode to the same 32 bytes. Two spellings of one key
    // is the ambiguity this whole layer refuses.
    await reject("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9=");
  });

  it("names the decoded byte count without echoing the value", async () => {
    const short = encodeBase64(new Uint8Array(31).fill(0x11));

    let message = "";
    try {
      await buildKeyring({ active: short, retired: [] });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toMatch(/31 bytes/);
    expect(message).not.toContain(short);
    expect(message).not.toContain(short.slice(0, 8));
  });

  it("rejects a retired key of the wrong length", async () => {
    await expect(
      buildKeyring({ active: MASTER_A, retired: [encodeBase64(new Uint8Array(16))] }),
    ).rejects.toBeInstanceOf(MasterKeyConfigError);
  });
});

describe("ring consistency", () => {
  it("refuses the active key listed as retired", async () => {
    await expect(buildKeyring({ active: MASTER_A, retired: [MASTER_A] })).rejects.toBeInstanceOf(
      MasterKeyConfigError,
    );
  });

  it("refuses the active key listed as retired under a different spelling", async () => {
    const unpadded = MASTER_A.replace(/=+$/, "");

    await expect(buildKeyring({ active: MASTER_A, retired: [unpadded] })).rejects.toBeInstanceOf(
      MasterKeyConfigError,
    );
  });

  it("refuses a duplicated retired key", async () => {
    await expect(
      buildKeyring({ active: MASTER_A, retired: [MASTER_B, MASTER_B] }),
    ).rejects.toBeInstanceOf(MasterKeyConfigError);
  });

  it("exposes every kid, active first", async () => {
    const keyring = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });

    expect(keyring.kids).toEqual([keyring.active.kid, keyring.retired[0]?.kid]);
    expect(keyring.find(keyring.active.kid)).toBe(keyring.active);
    expect(keyring.find(keyring.retired[0]?.kid ?? "")).toBe(keyring.retired[0]);
    expect(keyring.find("0000000000000000")).toBeUndefined();
  });
});

describe("memoisation", () => {
  it("derives once per isolate for the same material", async () => {
    const first = await buildKeyring({ active: MASTER_B, retired: [] });
    const second = await buildKeyring({ active: MASTER_B, retired: [] });

    expect(second).toBe(first);
    expect(second.active.dek).toBe(first.active.dek);
  });

  it("does not confuse two different rings", async () => {
    const one = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });
    const two = await buildKeyring({ active: MASTER_B, retired: [MASTER_A] });

    expect(one).not.toBe(two);
    expect(one.active.kid).toBe(two.retired[0]?.kid);
    expect(two.active.kid).toBe(one.retired[0]?.kid);
  });

  it("keys the cache injectively across the active/retired split", async () => {
    // A delimiter-joined cache key would collide these two if a key could ever
    // contain the delimiter. The prefix-length key cannot.
    const left = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });
    const right = await buildKeyring({ active: MASTER_A, retired: [] });

    expect(left).not.toBe(right);
    expect(right.retired).toHaveLength(0);
  });
});

describe("loadMasterMaterial", () => {
  it("reads the plain secret when no store is bound", async () => {
    await expect(loadMasterMaterial({ MASTER_KEY: MASTER_A })).resolves.toEqual({
      active: MASTER_A,
      retired: [],
    });
  });

  it("splits MASTER_KEY_OLD into a list", async () => {
    await expect(
      loadMasterMaterial({ MASTER_KEY: MASTER_A, MASTER_KEY_OLD: ` ${MASTER_B} , ${MASTER_C} ,` }),
    ).resolves.toEqual({ active: MASTER_A, retired: [MASTER_B, MASTER_C] });
  });

  it("prefers a bound Secrets Store binding over the plain secret", async () => {
    const material = await loadMasterMaterial({
      MASTER_KEY: MASTER_B,
      MASTER_KEY_STORE: { get: async () => MASTER_A },
    });

    expect(material.active).toBe(MASTER_A);
  });

  it("fails closed when a bound store cannot be read", async () => {
    await expect(
      loadMasterMaterial({
        MASTER_KEY: MASTER_A,
        MASTER_KEY_STORE: {
          get: async () => {
            throw new Error("store unavailable");
          },
        },
      }),
    ).rejects.toBeInstanceOf(MasterKeyConfigError);
  });

  it("fails closed when MASTER_KEY is absent", async () => {
    await expect(loadMasterMaterial({})).rejects.toBeInstanceOf(MasterKeyConfigError);
    await expect(loadMasterMaterial({ MASTER_KEY: "   " })).rejects.toBeInstanceOf(
      MasterKeyConfigError,
    );
  });

  it("points the operator at the command that produces a correct key", async () => {
    await expect(loadMasterMaterial({})).rejects.toThrow(/openssl rand -base64 32/);
  });
});

describe("getKeyring", () => {
  it("fails closed on a misconfigured environment", async () => {
    await expect(getKeyring({})).rejects.toBeInstanceOf(MasterKeyConfigError);
    await expect(getKeyring({ MASTER_KEY: "short" })).rejects.toBeInstanceOf(MasterKeyConfigError);
  });

  it("builds the same memoised ring as buildKeyring", async () => {
    const viaEnv = await getKeyring({ MASTER_KEY: MASTER_A, MASTER_KEY_OLD: MASTER_B });
    const direct = await buildKeyring({ active: MASTER_A, retired: [MASTER_B] });

    expect(viaEnv).toBe(direct);
  });
});
