/**
 * Where the harness puts the things it makes.
 *
 * EVERYTHING generated lands under `e2e/.playwright/`, which the repository
 * root `.gitignore` already covers, and which is deleted and recreated on every
 * run. Two consequences worth stating:
 *
 *   1. `packages/app` is never written to. In particular the harness does NOT
 *      create `packages/app/.dev.vars`, so running the suite cannot clobber a
 *      developer's local Worker configuration, and cannot leave a `MASTER_KEY`
 *      behind that makes the next `pnpm dev` decrypt a database it did not
 *      write.
 *   2. D1 is genuinely cold. `--persist-to` points inside this directory, so
 *      "it passed for me" cannot mean "it passed against rows I created by hand
 *      three days ago".
 *
 * The generated Wrangler configuration is DERIVED from
 * `packages/app/wrangler.jsonc` rather than copied, so the two cannot drift --
 * see `worker-config.ts`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** `e2e/` */
export const E2E_ROOT = resolve(here, "..");

/** The repository root. */
export const REPO_ROOT = resolve(E2E_ROOT, "..");

/** `packages/app` -- read from, never written to. */
export const APP_ROOT = join(REPO_ROOT, "packages", "app");

/** Everything this harness generates. Deleted at the start of every run. */
export const WORK_ROOT = join(E2E_ROOT, ".playwright");

export const PATHS = {
  /** The Wrangler config the dev server runs from. */
  workerConfig: join(WORK_ROOT, "wrangler.json"),
  /** Loaded by Wrangler because it sits beside the config, and cwd is here. */
  devVars: join(WORK_ROOT, ".dev.vars"),
  /** D1, KV and cache state. Wiped per run. */
  persist: join(WORK_ROOT, "state"),
  /** The TLS material for the mock Access origin. */
  certificate: join(WORK_ROOT, "access-ca.pem"),
  certificateKey: join(WORK_ROOT, "access-ca.key.pem"),
  /** Per-role Playwright storage state, holding the `CF_Authorization` cookie. */
  storage: join(WORK_ROOT, "storage"),
  /** The handoff between `globalSetup` and the workers that run the specs. */
  handoff: join(WORK_ROOT, "harness.json"),
  /** `wrangler dev` stdout and stderr, so a boot failure is readable. */
  devLog: join(WORK_ROOT, "wrangler-dev.log"),
  /** The seed applied before the Worker starts. */
  seedSql: join(E2E_ROOT, "seed.sql"),
  /** The built Worker and its assets. */
  workerEntry: join(APP_ROOT, ".svelte-kit", "cloudflare", "_worker.js"),
  assetsDirectory: join(APP_ROOT, ".svelte-kit", "cloudflare"),
  migrations: join(APP_ROOT, "drizzle", "migrations"),
  appWranglerConfig: join(APP_ROOT, "wrangler.jsonc"),
  /** Resolved from `packages/app`, so the pinned Wrangler is the one that runs. */
  wranglerBin: join(APP_ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
  /** Likewise for Vite: the version the lockfile pinned, not one on PATH. */
  viteBin: join(APP_ROOT, "node_modules", "vite", "bin", "vite.js"),
} as const;

export function storageStatePath(role: string): string {
  return join(PATHS.storage, `${role}.json`);
}
