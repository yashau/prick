import { beforeEach, describe, expect, it } from "vitest";

import { auditLog, secretVersions } from "../../src/lib/server/db/schema.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, OWNER, type ApiHarness } from "./harness.js";

/**
 * THE FRAMEWORK-LEVEL RULE: a validation failure never echoes what was sent.
 *
 * A `VALIDATION_FAILED` on a secret write is, by definition, a request whose
 * body carried a plaintext secret value. `@hono/zod-validator`'s DEFAULT error
 * hook answers with zod's own flattened error, and that structure contains
 * `issue.input` -- so the out-of-the-box configuration publishes the rejected
 * secret to the HTTP response, to whatever logs the response body, and to the
 * audit detail if anyone ever copied it there. Three plaintext copies produced
 * by the error path of a request that was REFUSED.
 *
 * Everything below is an attempt to get a submitted value back out of this API
 * through a rejection.
 */

/**
 * A value that could not occur by accident.
 *
 * Long, unique and grep-able, so `expect(text).not.toContain(SENTINEL)` cannot
 * pass because of a coincidence, and so a failure names itself in the diff.
 */
const SENTINEL = "PLAINTEXT-SENTINEL-c7f19a04-do-not-echo";

let api: ApiHarness;

beforeEach(async () => {
  api = await apiHarness();
  const projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
});

async function reject(payload: unknown): Promise<{ status: number; text: string }> {
  const token = await api.ownerToken();
  const response = await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
    method: "POST",
    token,
    ...body(payload),
  });

  return { status: response.status, text: await response.text() };
}

describe("a rejected secret write does not put the value in the response", () => {
  it("an invalid KEY name reports the key and swallows the value", async () => {
    // The path segment for a `SecretsMap` entry IS the key name, and key names
    // are plaintext metadata -- stored unencrypted, listed in the UI, printed in
    // the audit log. Reporting it is what makes the error actionable. It is the
    // SIBLING field that holds the value.
    const { status, text } = await reject({ mode: "merge", set: { "not-a-posix-name": SENTINEL } });

    expect(status).toBe(422);
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("not-a-posix-name");

    const parsed = JSON.parse(text) as { code: string; issues: { path: string }[] };
    expect(parsed.code).toBe("VALIDATION_FAILED");
    expect(parsed.issues[0]?.path).toContain("set.not-a-posix-name");
  });

  it("an oversized value is refused without being quoted", async () => {
    // `SecretValue` bounds UTF-8 BYTES rather than `String.length`, so this is
    // the real limit rather than a proxy for it.
    const oversized = `${SENTINEL}${"x".repeat(70_000)}`;
    const { status, text } = await reject({ mode: "merge", set: { API_TOKEN: oversized } });

    expect(status).toBe(422);
    expect(text).not.toContain(SENTINEL);
  });

  it("a value of the wrong TYPE is refused without being rendered", async () => {
    // zod's `invalid_type` message says "expected string, received number" --
    // the CATEGORY, never the datum. Asserted rather than assumed, because a
    // formatter that interpolated the received value would look equally
    // reasonable in review.
    const { status, text } = await reject({ mode: "merge", set: { API_TOKEN: 8675309 } });

    expect(status).toBe(422);
    expect(text).not.toContain("8675309");
  });

  it("an unknown field's VALUE is refused without being echoed", async () => {
    const { status, text } = await reject({
      mode: "merge",
      set: { API_TOKEN: "fine" },
      // A misspelling is the realistic case; a client that sends its secret in
      // the wrong field is the one that hurts.
      expectedRev: SENTINEL,
    });

    expect(status).toBe(422);
    expect(text).not.toContain(SENTINEL);
    // The FIELD NAME is reported, because that is the only thing that tells the
    // caller what to fix.
    expect(text).toContain("expectedRev");
  });

  it("an unrecognised enum member is refused without being repeated", async () => {
    const { status, text } = await reject({ mode: SENTINEL, set: { API_TOKEN: "fine" } });

    expect(status).toBe(422);
    expect(text).not.toContain(SENTINEL);
  });

  it("a rejected import does not echo the file it was given", async () => {
    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/p/acme/e/prod/secrets:import", {
      method: "POST",
      token,
      ...body({ format: "env", content: `API_TOKEN=${SENTINEL}\n`, mode: "merge", extra: 1 }),
    });

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(SENTINEL);
  });
});

describe("a rejected write leaves no trace of the value anywhere else", () => {
  it("writes no audit row and no version row containing it", async () => {
    await reject({ mode: "merge", set: { "not-a-posix-name": SENTINEL } });

    // The audit log is the other place a formatter could deposit a value: a
    // `detail` blob built from the error would carry `issue.input` just as
    // happily as a response body would.
    const audits = await api.db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain(SENTINEL);

    // And nothing was stored. A 422 is refused BEFORE the handler runs, so the
    // write path never sees the body at all.
    const versions = await api.db.select().from(secretVersions);
    expect(versions).toEqual([]);
  });

  it("audits nothing at all for a request the validator refused", async () => {
    const before = (await api.db.select().from(auditLog)).length;
    await reject({ mode: "merge", set: { "not-a-posix-name": SENTINEL } });
    const after = (await api.db.select().from(auditLog)).length;

    // Not even a denial: the request was well-authenticated and refused on
    // shape, which is not an access event.
    expect(after).toBe(before);
  });
});

describe("every object schema is strict", () => {
  it("rejects a misspelled expected_rev rather than writing without a guard", async () => {
    /*
     * THE FAILURE THIS PREVENTS IS CONCRETE.
     *
     * A client sending `expectedRev` instead of `expected_rev` against a
     * permissive schema would receive a 200 and a write with NO concurrency
     * guard at all -- exactly the request it believed it was making, minus the
     * safety, and with nothing anywhere to indicate the difference.
     */
    const { status } = await reject({ mode: "replace", set: {}, expectedRev: 0 });
    expect(status).toBe(422);
  });

  it("rejects an unknown query parameter", async () => {
    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/audit?limit=10&whoops=1", { token });

    expect(response.status).toBe(422);
  });

  it("rejects an unknown field on a project create", async () => {
    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/projects", {
      method: "POST",
      token,
      ...body({ slug: "new", name: "New", owner: OWNER }),
    });

    expect(response.status).toBe(422);
  });
});

describe("query strings are coerced at the transport and nowhere else", () => {
  it("accepts numeric audit parameters as the strings a URL carries", async () => {
    // `AuditQuery` in `@prick/shared` declares these as numbers, which is right
    // for the JavaScript callers that build the object and wrong for a URL. The
    // coercion lives in `http/schemas.ts`, at the one boundary that needs it.
    const token = await api.ownerToken();
    const response = await api.fetch("/api/v1/audit?limit=5&since=0", { token });

    expect(response.status).toBe(200);
  });

  it("still enforces the bounds after coercing", async () => {
    const token = await api.ownerToken();

    expect((await api.fetch("/api/v1/audit?limit=0", { token })).status).toBe(422);
    expect((await api.fetch("/api/v1/audit?limit=201", { token })).status).toBe(422);
    expect((await api.fetch("/api/v1/audit?limit=notanumber", { token })).status).toBe(422);
  });
});

/**
 * The redacting hook is installed in exactly ONE place, and this is what keeps
 * it that way.
 *
 * `zValidator` with no hook is a one-line change that reintroduces the leak and
 * looks completely ordinary in a diff. Rather than rely on a reviewer noticing,
 * the import itself is confined: `http/validate.ts` is the only module in the
 * shipped tree allowed to name `@hono/zod-validator`.
 */
const HTTP_SOURCES = import.meta.glob(
  ["../../src/lib/server/http/**/*.ts", "!../../src/lib/server/http/**/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * Comments are stripped before the greps below run.
 *
 * Both rules are about what the CODE does, and both names appear in prose all
 * over this tree precisely because they are the things being explained. A
 * sentinel that fires on its own documentation is a sentinel somebody deletes.
 *
 * Deliberately a heuristic rather than a parser: block comments go, and a `//`
 * goes unless it is preceded by `:` or a quote, which is what keeps `https://`
 * inside a string intact. It can in principle drop code that follows a URL on
 * the same line -- a false NEGATIVE, never a false positive -- and the rules it
 * guards are also enforced by the behavioural tests above.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}

describe("nothing validates outside http/validate.ts", () => {
  it("finds the http source tree", () => {
    const paths = Object.keys(HTTP_SOURCES);

    expect(paths.length).toBeGreaterThan(8);
    expect(paths.some((path) => path.endsWith("/http/validate.ts"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/http/routes/secrets.ts"))).toBe(true);
  });

  it("imports @hono/zod-validator from validate.ts alone", () => {
    const offenders = Object.entries(HTTP_SOURCES)
      .filter(
        ([path, source]) =>
          !path.endsWith("/http/validate.ts") &&
          /from\s+["']@hono\/zod-validator["']/.test(stripComments(source)),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("never reads issue.input, in any module", () => {
    // The formatter's contract is `issue.path` and `issue.message`. A grep is a
    // blunt instrument and it is the right one here: there is no legitimate
    // reason for executable code in this tree to touch the field at all.
    const offenders = Object.entries(HTTP_SOURCES)
      .filter(([, source]) => /issue\s*\.\s*input/.test(stripComments(source)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("imports no CORS middleware", () => {
    /*
     * Omitting `Access-Control-Allow-Origin` is the single mechanism that stops
     * another site reading a response from this API in a logged-in victim's
     * browser, and the browser enforces it for free. It is also the control
     * most likely to be "fixed" by somebody debugging a cross-origin fetch, so
     * it is asserted rather than left as a convention.
     *
     * The grep covers the import; `describe("there is no CORS")` below covers
     * the wire, which is what actually matters and which a hand-rolled header
     * would slip past a grep for the package name.
     */
    const offenders = Object.entries(HTTP_SOURCES)
      .filter(([, source]) => /from\s+["']hono\/cors["']/.test(stripComments(source)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe("there is no CORS, on any response", () => {
  const PATHS = [
    "/api/v1/health",
    "/api/v1/projects",
    "/api/v1/p/acme/e/prod/secrets",
    "/api/v1/openapi.json",
    "/api/v1/nope",
  ];

  for (const path of PATHS) {
    it(`${path} emits no Access-Control-* header`, async () => {
      const token = await api.ownerToken();

      // With an `Origin`, which is what a browser sends and what a CORS
      // middleware keys off. Asserted on the HEADERS rather than the source, so
      // a hand-written `c.header("Access-Control-Allow-Origin", "*")` is caught
      // as surely as an imported middleware would be.
      const response = await api.fetch(path, {
        token,
        headers: { Origin: "https://evil.example" },
      });

      const emitted = [...response.headers.keys()].filter((name) =>
        name.toLowerCase().startsWith("access-control-"),
      );

      expect(emitted).toEqual([]);
    });
  }

  it("does not answer a preflight either", async () => {
    // No `OPTIONS` handler and no allow-headers response: a preflight that
    // fails is a cross-origin request that never happens.
    const response = await api.fetch("/api/v1/projects", {
      method: "OPTIONS",
      token: null,
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });
});
