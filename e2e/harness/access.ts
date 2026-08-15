/**
 * Real Cloudflare Access credentials, for a Worker that no Cloudflare Access
 * sits in front of.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Every route below `/api/v1/health` requires a verified Access JWT, and there
 * is no Access in front of `wrangler dev`. The tempting fix is a bypass -- a
 * `vars` flag that skips verification locally, or a header the Worker trusts
 * when it thinks it is in development. Both are the same fix, and both put a
 * code path into the shipped Worker whose entire purpose is to accept an
 * unverified identity. For a secrets manager that is the worst possible thing
 * to have in the binary, however carefully it is gated.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 * ---------------------------------------------------------------------------
 * The same thing `packages/app/test/auth/harness/` does for the unit suite, one
 * layer out: the certs URL is CONFIGURATION (`ACCESS_CERTS_URL`), so the
 * harness generates a genuine RS256 keypair, publishes the public half as a
 * real JWKS at a real HTTPS URL, and mints genuine Access-shaped tokens with
 * the private half. `verifyAccessJwt` runs completely unmodified: it fetches
 * the JWKS over the network, selects the key by `kid`, pins the algorithm from
 * the JWKS entry, checks the signature, and asserts every claim.
 *
 * Nothing here fakes a signature or injects a claim set. If the verifier
 * regresses, this suite stops authenticating.
 *
 * The claim shapes below are the two Access actually issues, and the difference
 * between them is load-bearing: a SERVICE token has an EMPTY `sub`, a
 * `common_name`, no `email` and NO `nbf`. A verifier written against the human
 * shape rejects every machine client, so the service fixture exists to make
 * that a test failure rather than a support ticket.
 */

import { webcrypto } from "node:crypto";

import { ACCESS_AUD, ACCESS_KID, ACCESS_TEAM } from "./constants";

const subtle = webcrypto.subtle;

export interface AccessKeyMaterial {
  kid: string;
  /** Used only to mint. Never published, never leaves this process's files. */
  privateJwk: JsonWebKey;
  /** The public half, exactly as it appears at `/cdn-cgi/access/certs`. */
  publicJwk: Record<string, string>;
  /** The serialised `{ keys: [...] }` document the mock origin serves. */
  jwksDocument: string;
}

export async function generateAccessKey(): Promise<AccessKeyMaterial> {
  const pair = (await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
  const exported = await subtle.exportKey("jwk", pair.publicKey);

  if (typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("The exported RSA public key carries no modulus or exponent.");
  }

  const publicJwk = {
    kid: ACCESS_KID,
    kty: "RSA",
    alg: "RS256",
    use: "sig",
    n: exported.n,
    e: exported.e,
  };

  return {
    kid: ACCESS_KID,
    privateJwk,
    publicJwk,
    jwksDocument: JSON.stringify({ keys: [publicJwk] }),
  };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function encodePart(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface AccessPayload {
  iss: string;
  /** An ARRAY. Access issues an array and the verifier asserts `.includes()`. */
  aud: string[];
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  common_name?: string;
  type?: string;
  country?: string;
  identity_nonce?: string;
}

async function signJwt(privateJwk: JsonWebKey, payload: AccessPayload): Promise<string> {
  const header = encodePart({ typ: "JWT", alg: "RS256", kid: ACCESS_KID });
  const body = encodePart(payload);
  const input = new TextEncoder().encode(`${header}.${body}`);

  const key = await subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, input));

  return `${header}.${body}.${base64Url(signature)}`;
}

const issuer = (): string => `https://${ACCESS_TEAM}.cloudflareaccess.com`;

/**
 * A human token.
 *
 * `ttlSeconds` is an hour by default -- comfortably longer than any run -- and
 * short enough to be worth nothing if the state directory is ever archived.
 */
export async function mintUserToken(
  material: AccessKeyMaterial,
  email: string,
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<string> {
  const seconds = Math.floor((options.now ?? Date.now()) / 1000);

  return signJwt(material.privateJwk, {
    iss: issuer(),
    aud: [ACCESS_AUD],
    sub: "9b1f0e6a-3c25-4f8d-9a71-2e6b4d8f0c31",
    email,
    exp: seconds + (options.ttlSeconds ?? 3600),
    iat: seconds - 5,
    nbf: seconds - 5,
    identity_nonce: "e2enonce",
    country: "MV",
    type: "app",
  });
}

/**
 * A service token.
 *
 * EMPTY `sub`, a `common_name`, no `email`, and deliberately NO `nbf` -- that
 * is the shape Access issues, and a verifier that requires `nbf` rejects every
 * machine client in the estate. Keeping the omission here means the negative
 * case is exercised by the whole service-role half of this suite rather than by
 * one unit test.
 */
export async function mintServiceToken(
  material: AccessKeyMaterial,
  commonName: string,
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<string> {
  const seconds = Math.floor((options.now ?? Date.now()) / 1000);

  return signJwt(material.privateJwk, {
    iss: issuer(),
    aud: [ACCESS_AUD],
    sub: "",
    common_name: commonName,
    exp: seconds + (options.ttlSeconds ?? 3600),
    iat: seconds - 5,
    type: "app",
  });
}
