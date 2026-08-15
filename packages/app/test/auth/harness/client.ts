/**
 * The workerd half of the Access harness: talks to the mock origin through the
 * same intercepted outbound path the verifier itself uses.
 *
 * Every test takes a FRESH certs URL. `jwks.ts` caches in module scope keyed by
 * URL, and a suite that shared one URL would have each test observing whatever
 * cache state its predecessors happened to leave -- which is how a rate-limit
 * test passes because of an unrelated TTL.
 */

import {
  HARNESS_KEYS_URL,
  HARNESS_MIGRATIONS_URL,
  certsUrlFor,
  statsUrlFor,
  type CertsProfile,
  type HarnessKeysResponse,
  type HarnessMigration,
  type HarnessStatsResponse,
} from "./protocol.js";

let cachedKeys: HarnessKeysResponse | null = null;

/** The three keypairs, fetched once per isolate. */
export async function harnessKeys(): Promise<HarnessKeysResponse> {
  if (cachedKeys !== null) return cachedKeys;

  const response = await fetch(HARNESS_KEYS_URL);
  if (!response.ok) {
    throw new Error(
      `Access harness is not intercepting outbound fetches (HTTP ${String(response.status)} from ${HARNESS_KEYS_URL})`,
    );
  }

  cachedKeys = (await response.json()) as HarnessKeysResponse;
  return cachedKeys;
}

let cachedMigrations: HarnessMigration[] | null = null;

/** The committed Drizzle migrations, read on the Node side by the harness. */
export async function harnessMigrations(): Promise<HarnessMigration[]> {
  if (cachedMigrations !== null) return cachedMigrations;

  const response = await fetch(HARNESS_MIGRATIONS_URL);
  if (!response.ok) {
    throw new Error(`Access harness migrations unavailable (HTTP ${String(response.status)})`);
  }

  cachedMigrations = (await response.json()) as HarnessMigration[];
  return cachedMigrations;
}

let counter = 0;

export interface CertsEndpoint {
  profile: CertsProfile;
  nonce: string;
  url: string;
  /** How many times the mock origin has actually served this URL. */
  fetches(): Promise<number>;
}

export function certsEndpoint(profile: CertsProfile): CertsEndpoint {
  counter += 1;
  const nonce = `${String(counter)}-${crypto.randomUUID()}`;

  return {
    profile,
    nonce,
    url: certsUrlFor(profile, nonce),
    async fetches(): Promise<number> {
      const response = await fetch(statsUrlFor(profile, nonce));
      if (!response.ok) {
        throw new Error(`Access harness stats unavailable (HTTP ${String(response.status)})`);
      }
      const stats = (await response.json()) as HarnessStatsResponse;
      return stats.fetches;
    },
  };
}
