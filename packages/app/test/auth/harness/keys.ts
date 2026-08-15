/**
 * Real RS256 key material for the Access harness.
 *
 * This module runs in BOTH realms: in Node when `vitest.config.ts` builds the
 * mock Access origin, and inside workerd when a test mints a token. It touches
 * nothing but `crypto.subtle`, which both provide, and it never imports
 * anything from `src/`.
 *
 * The keys are GENUINE. Nothing in this suite fakes a signature, stubs the
 * verifier, or injects a pre-decoded claim set -- the point of the harness is
 * that `verifyAccessJwt` does the same work against a real key that it does in
 * production, so a signature bug fails a test instead of shipping.
 */

/** A JWKS entry as Cloudflare Access publishes it. */
export interface AccessPublicJwk {
  kid: string;
  kty: "RSA";
  alg: "RS256";
  use: "sig";
  n: string;
  e: string;
}

export interface AccessKeyMaterial {
  kid: string;
  /** The private half, used to mint tokens. Never published in any JWKS. */
  privateJwk: JsonWebKey;
  /** The public half, as it appears at `/cdn-cgi/access/certs`. */
  publicJwk: AccessPublicJwk;
}

const RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: "SHA-256",
} as const;

export async function generateAccessKey(kid: string): Promise<AccessKeyMaterial> {
  const pair = (await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  if (typeof publicJwk.n !== "string" || typeof publicJwk.e !== "string") {
    throw new Error("exported RSA public key is missing its modulus or exponent");
  }

  return {
    kid,
    privateJwk,
    publicJwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: publicJwk.n, e: publicJwk.e },
  };
}

/** Wrap public halves in the `{ keys: [...] }` document shape Access serves. */
export function jwksDocument(keys: AccessPublicJwk[]): string {
  return JSON.stringify({ keys });
}
