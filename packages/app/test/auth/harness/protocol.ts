/**
 * The contract between the mock Access origin (Node, built by
 * `vitest.config.ts`) and the tests that talk to it (workerd).
 *
 * They cannot share memory, so everything crosses as JSON over the intercepted
 * outbound fetch. Keeping the shapes in one file is what stops the two halves
 * drifting into a harness that silently stops asserting anything.
 */

import type { AccessPublicJwk } from "./keys.js";

/**
 * A hostname that resolves to nothing.
 *
 * `.test` is reserved by RFC 6761 precisely for this, so a bug that removes the
 * interception fails with a DNS error rather than reaching a real service.
 */
export const HARNESS_ORIGIN = "https://access-harness.test";

/**
 * Which public keys a certs path serves.
 *
 *   primary    the one key, forever. Rotation never happens.
 *   both       primary and rotated from the first fetch.
 *   rotating   primary on the FIRST fetch, primary + rotated on every fetch
 *              after it. This is the Access key-rotation window, reproduced:
 *              a cache populated before the rotation cannot verify a token
 *              signed after it until something refetches.
 *   empty      a valid JWKS with no keys.
 *   malformed  200, JSON, no `keys` array.
 *   broken     HTTP 500, always.
 *   flaky      200 on the FIRST fetch, HTTP 500 after it. A refetch against a
 *              momentarily unavailable origin must not throw away a key set
 *              that still verifies real traffic.
 *   no-alg     the primary key with its `alg` REMOVED. An entry that declares
 *              no algorithm lets the token header choose one, which is the
 *              whole vulnerability, so such an entry must be unusable.
 *   enc-use    the primary key marked `use: "enc"`. A key published for
 *              encryption must never verify a signature.
 */
export type CertsProfile =
  | "primary"
  | "both"
  | "rotating"
  | "empty"
  | "malformed"
  | "broken"
  | "flaky"
  | "no-alg"
  | "enc-use";

export interface HarnessKeyMaterialWire {
  kid: string;
  privateJwk: JsonWebKey;
  publicJwk: AccessPublicJwk;
}

export interface HarnessKeysResponse {
  /** Published by every profile. The ordinary signing key. */
  primary: HarnessKeyMaterialWire;
  /** Published only after a rotation. Drives the unknown-`kid` refetch case. */
  rotated: HarnessKeyMaterialWire;
  /** NEVER published by any profile. Drives the "signed by a stranger" case. */
  foreign: HarnessKeyMaterialWire;
}

export interface HarnessStatsResponse {
  /** How many times the mock origin has served this exact certs path. */
  fetches: number;
}

/** A certs URL that no other test shares, so module-scope caches cannot leak. */
export function certsUrlFor(profile: CertsProfile, nonce: string): string {
  return `${HARNESS_ORIGIN}/certs/${profile}/${nonce}`;
}

export function statsUrlFor(profile: CertsProfile, nonce: string): string {
  return `${HARNESS_ORIGIN}/stats/${profile}/${nonce}`;
}

export const HARNESS_KEYS_URL = `${HARNESS_ORIGIN}/keys`;

export const HARNESS_MIGRATIONS_URL = `${HARNESS_ORIGIN}/migrations`;

/** `D1Migration` from `cloudflare:test`, restated so workerd code need not import the pool. */
export interface HarnessMigration {
  name: string;
  queries: string[];
}
