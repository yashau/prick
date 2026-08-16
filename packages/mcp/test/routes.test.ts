import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { routes } from "../src/routes.ts";

/**
 * ROUTE DRIFT GUARD.
 *
 * `src/routes.ts` names five paths on a server this package never builds. The
 * README used to say they were assumed, because when it was written the router
 * served only `/api/v1/health`; the router is mounted now, so the honest thing
 * is to check rather than to restate the assumption.
 *
 * `docs/openapi.json` is generated from the Hono router and `mise run
 * openapi:check` fails when it is stale, so it is the server's own account of
 * itself rather than a second hand-written list. Reading it here means a route
 * that stops existing fails this package's suite instead of a user's first tool
 * call.
 *
 * NORMALISATION. Two shapes have to be reconciled, and neither is a workaround.
 *
 *   Path parameters. The spec writes `{project}` where these functions
 *   interpolate a slug. Both sides are reduced to `{}` before comparison: a
 *   parameter is positional, so the server reads the third segment whatever the
 *   spec called it.
 *
 *   The slug alias. Environment-scoped routes are served at both
 *   `/projects/{project}/environments/{env}/...` and `/p/{project}/e/{env}/...`,
 *   by the same handlers. Only the canonical spelling appears in the generated
 *   document, deliberately -- documenting both would double it to say the same
 *   thing twice -- so the alias is rewritten to its canonical form here.
 */

const SPEC_PATH = fileURLToPath(new URL("../../../docs/openapi.json", import.meta.url));

/** Sentinels that satisfy the grammars the API validates against. */
const PROJECT = "zzproject";
const ENVIRONMENT = "zzenvironment";
const KEY = "ZZKEY";

/** Every path this package can produce, with the function that produced it. */
const CALLS: readonly { readonly op: string; readonly path: string }[] = [
  { op: "routes.projects", path: routes.projects() },
  { op: "routes.environments", path: routes.environments(PROJECT) },
  { op: "routes.secrets", path: routes.secrets(PROJECT, ENVIRONMENT) },
  { op: "routes.secretsBatch", path: routes.secretsBatch(PROJECT, ENVIRONMENT) },
  { op: "routes.secretReveal", path: routes.secretReveal(PROJECT, ENVIRONMENT, KEY) },
];

/** Empties every `{parameter}` in a spec path, leaving `{}`. */
function normaliseTemplate(path: string): string {
  return path.replaceAll(/\{[^}]*\}/g, "{}");
}

/**
 * Reduces a path this package built to the shape the spec would write.
 *
 * The alias rewrite is first: `/p/{}/e/{}` and
 * `/projects/{}/environments/{}` are the same mount, and the spec only carries
 * the second.
 */
function normaliseCall(path: string): string {
  const withPlaceholders = path
    .split("/")
    .map((segment) =>
      ([PROJECT, ENVIRONMENT, KEY] as string[]).includes(segment) ? "{}" : segment,
    )
    .join("/");

  return withPlaceholders.replace("/p/{}/e/{}", "/projects/{}/environments/{}");
}

/** Every path the generated document serves, normalised. */
function specPaths(): Set<string> {
  const spec: unknown = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  const paths = (spec as { paths?: Record<string, unknown> }).paths;
  assert.ok(paths, "docs/openapi.json has a `paths` object");
  return new Set(Object.keys(paths).map(normaliseTemplate));
}

describe("routes", () => {
  test("every path this package builds is one the API serves", () => {
    const served = specPaths();

    const missing = CALLS.filter((call) => !served.has(normaliseCall(call.path))).map(
      (call) => `  ${call.op} builds ${call.path}, i.e. ${normaliseCall(call.path)}`,
    );

    assert.deepEqual(
      missing,
      [],
      `${String(missing.length)} route(s) go somewhere docs/openapi.json does not serve:\n${missing.join("\n")}\n\n` +
        "Either the path is wrong, or the router changed and `mise run openapi` has not been run.",
    );
  });

  test("the comparison read a spec with routes in it", () => {
    // Without this the test above passes vacuously against an empty set, which
    // is the shape of failure a drift guard must not have.
    assert.ok(specPaths().size > 10, "the spec should serve a few dozen routes");
    assert.equal(CALLS.length, 5, "every function in `routes` is exercised here");
  });

  test("an interpolated segment is percent-encoded", () => {
    // A slug is `[a-z0-9-]` and a key is a POSIX name, so neither can contain a
    // character that needs escaping today. Encoding anyway is what stops that
    // being something this file depends on.
    assert.match(routes.secrets("a/b", "c d"), /a%2Fb/);
    assert.match(routes.secretReveal("p", "e", "K/../admin"), /K%2F\.\.%2Fadmin/);
  });
});
