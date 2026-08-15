/**
 * The handoff between `globalSetup` and the worker processes that run the
 * specs.
 *
 * Playwright runs specs in separate processes, so nothing `globalSetup` holds
 * in memory reaches them. A JSON file under `e2e/.playwright/` is the whole
 * mechanism -- an environment variable would do for the base URL and would stop
 * being enough the moment the payload includes a token per role.
 *
 * The tokens ARE in this file. They are one-hour Access assertions for a
 * throwaway team, signed by a keypair generated at the start of the run, valid
 * only against a Worker whose D1 is deleted at the end of it, and written to a
 * gitignored directory that already holds that database.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Role } from "./constants";
import { PATHS } from "./paths";

export interface Handoff {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  /** A minted Access assertion per role. */
  tokens: Record<Role, string>;
  /** Absolute paths to the per-role Playwright storage state files. */
  storageState: Record<Role, string>;
  /** The certs URL the Worker was configured with. Asserted against in a spec. */
  certsUrl: string;
}

export function writeHandoff(handoff: Handoff): void {
  mkdirSync(dirname(PATHS.handoff), { recursive: true });
  writeFileSync(PATHS.handoff, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
}

let cached: Handoff | null = null;

/**
 * The handoff, read once per process.
 *
 * Synchronous, because fixtures and `test.describe` bodies need it before their
 * first `await`. A missing file means the specs were started without global
 * setup, so the error says exactly that rather than letting every spec fail on
 * an `undefined` base URL.
 */
export function readHandoff(): Handoff {
  if (cached !== null) return cached;

  let source: string;
  try {
    source = readFileSync(PATHS.handoff, "utf8");
  } catch {
    throw new Error(
      `No harness state at ${PATHS.handoff}. Run the suite through its own Playwright ` +
        "config so that global setup builds, seeds and starts the Worker first.",
    );
  }

  cached = JSON.parse(source) as Handoff;
  return cached;
}
