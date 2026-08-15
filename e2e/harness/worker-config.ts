/**
 * The Wrangler configuration the suite runs against, DERIVED from the real one.
 *
 * ---------------------------------------------------------------------------
 * WHY DERIVED RATHER THAN COPIED
 * ---------------------------------------------------------------------------
 * A second hand-written `wrangler.jsonc` under `e2e/` would be a second
 * statement of the deployment, and it would be wrong within a month: a new
 * binding, a changed compatibility date or a new `var` would be added to the
 * real file and the suite would keep passing against the old shape. So the real
 * file is read, its comments are stripped, and exactly four things are changed:
 *
 *   main / assets.directory / migrations_dir  ->  absolute paths, because the
 *       generated config does not live next to the package it describes.
 *   vars                                      ->  the Access team, AUD and
 *       certs URL the harness actually mints against.
 *
 * Everything else -- compatibility flags, the D1 binding name, observability --
 * arrives from the deployed configuration unchanged.
 *
 * `workers_dev` and `preview_urls` are asserted to be `false` on the way past.
 * They are non-negotiable in the real file, and a suite that reads that file is
 * the cheapest possible place to notice if they ever stop being.
 */

import { readFile } from "node:fs/promises";

import { ACCESS_AUD, ACCESS_TEAM } from "./constants";
import { PATHS } from "./paths";

export interface WorkerConfigInput {
  /** The HTTPS URL of the mock Access origin. */
  certsUrl: string;
}

/**
 * Strip JSONC comments.
 *
 * String-aware, because `wrangler.jsonc` contains URLs, and a naive `//`
 * stripper would truncate `"https://…"` into invalid JSON. Escapes are tracked
 * so a `\"` inside a string does not end it.
 */
export function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}

/** Remove trailing commas, which JSONC allows and `JSON.parse` does not. */
export function stripTrailingCommas(source: string): string {
  return source.replace(/,(\s*[}\]])/g, "$1");
}

interface RawWorkerConfig {
  workers_dev?: unknown;
  preview_urls?: unknown;
  main?: unknown;
  assets?: { directory?: unknown; binding?: unknown };
  d1_databases?: { binding?: string; database_name?: string; migrations_dir?: unknown }[];
  vars?: Record<string, string>;
  [key: string]: unknown;
}

export async function buildWorkerConfig(input: WorkerConfigInput): Promise<string> {
  const source = await readFile(PATHS.appWranglerConfig, "utf8");
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source))) as RawWorkerConfig;

  /*
   * THE DEPLOYMENT GUARD, re-asserted here.
   *
   * A `*.workers.dev` hostname -- or a per-version preview URL -- that Access is
   * not attached to serves this Worker with no authentication at all. CI greps
   * the resolved config for both; this is the same check, run by the suite that
   * would otherwise be the one place a regression looked harmless.
   */
  if (parsed.workers_dev !== false || parsed.preview_urls !== false) {
    throw new Error(
      "packages/app/wrangler.jsonc must set workers_dev:false and preview_urls:false. " +
        "A hostname Access is not in front of is a complete bypass of the authorization model.",
    );
  }

  const forwardSlash = (value: string): string => value.replaceAll("\\", "/");

  parsed.main = forwardSlash(PATHS.workerEntry);

  if (parsed.assets && typeof parsed.assets === "object") {
    parsed.assets.directory = forwardSlash(PATHS.assetsDirectory);
  }

  for (const database of parsed.d1_databases ?? []) {
    database.migrations_dir = forwardSlash(PATHS.migrations);
  }

  parsed.vars = {
    ...parsed.vars,
    ACCESS_TEAM,
    ACCESS_AUD,
    ACCESS_CERTS_URL: input.certsUrl,
    /*
     * EMPTY ON PURPOSE.
     *
     * `seed.sql` installs a real `scope_type = 'global'` admin GRANT instead of
     * naming an address here. Two reasons: the bootstrap path is a different
     * code path (it self-heals a grant and flags the actor `bootstrap: true`),
     * so leaning on it would mean the role fixtures never exercise the ordinary
     * one; and `NO_ADMINS_CONFIGURED` is only reachable when both this var and
     * every global grant are empty, which is a state a spec can then construct
     * deliberately rather than one the whole suite sits in.
     */
    BOOTSTRAP_ADMINS: "",
    REQUIRE_CTX_ACCESS: "false",
  };

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** The `.dev.vars` beside the generated config. Holds the test master key. */
export function buildDevVars(masterKey: string): string {
  return [
    "# Generated by e2e/global-setup.ts. Deleted and rewritten on every run.",
    "# This master key protects a database that exists for the length of one",
    "# test run and is deleted afterwards.",
    `MASTER_KEY="${masterKey}"`,
    "",
  ].join("\n");
}
