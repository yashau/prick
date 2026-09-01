import { beforeEach, describe, expect, it } from "vitest";

import { auditLog, environments } from "../../src/lib/server/db/schema.js";
import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, type ApiHarness } from "./harness.js";
import { HTTP_SOURCES, stripComments } from "./sources.js";

/**
 * THE OTHER HALF OF "THERE IS NO CORS".
 *
 * `validation.test.ts` asserts that no other site can READ this API, which the
 * browser enforces for free because no `Access-Control-Allow-Origin` is ever
 * emitted. That says nothing about WRITES, and the two are not symmetric:
 *
 *   - An auto-submitting `<form method=post>` needs no response, so a policy
 *     about who may read one does not stop it.
 *   - Its media type is one of the three a form can produce, so it is exempt
 *     from preflight -- there is no OPTIONS for the missing CORS headers to
 *     fail.
 *   - `extractAssertion` falls back to the `CF_Authorization` cookie, so if the
 *     Access application is configured `SameSite=None` -- a dashboard setting
 *     this repository cannot see, let alone assert -- the browser attaches the
 *     victim's credential and the API authenticates the attacker's request as
 *     them.
 *   - And the body is not rejected on the way in. Hono's `json` validator hands
 *     the schema `{}` on a media-type mismatch rather than failing, so a schema
 *     whose fields are all optional or defaulted -- `RekeyBody` is one --
 *     validates a form post as a legitimate call and the handler runs.
 *
 * Everything below is that request, in each shape a browser can produce it, plus
 * the shapes the CLI, the MCP server and the composite action actually send --
 * because a guard that refuses those is a worse outcome than the hole it closes.
 * That is not hypothetical: the first version of this guard 415'd every bodiless
 * `DELETE` that crossed a socket while every test in this directory passed. See
 * `describe("body presence is never consulted")`, which is the shape of request
 * this file was missing.
 */

let api: ApiHarness;
let token: string;

beforeEach(async () => {
  api = await apiHarness();
  const projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
  token = await api.ownerToken();
});

/** Our own origin, as the Worker sees it in this harness. */
const SELF_ORIGIN = "https://prick.test";
const ATTACKER = "https://evil.example";

/**
 * The route the attack actually lands on, and it is not `secrets:batch`.
 *
 * `BatchBody`'s first refine ("a merge batch must specify at least one of set or
 * delete") rejects the `{}` a media-type mismatch produces, so the secrets write
 * path is incidentally covered. `RekeyBody` is `{ limit: number.default(...) }`
 * and has no such refine: `{}` parses, `limit` becomes the maximum page, and a
 * global admin's browser re-encrypts a page of rows and writes an audit row
 * attributed to them. That is the endpoint to prove closed.
 */
const REKEY = "/api/v1/admin/rekey";

/** A cross-site form post, credentialed exactly the way a browser would do it. */
function crossSiteForm(init: { origin?: string; contentType?: string } = {}): RequestInit & {
  token: null;
} {
  return {
    method: "POST",
    // No `Cf-Access-Jwt-Assertion`: the whole premise is the AMBIENT cookie,
    // which is the one credential an attacker's page can cause to be sent.
    token: null,
    headers: {
      Cookie: `CF_Authorization=${token}`,
      Origin: init.origin ?? ATTACKER,
      "Content-Type": init.contentType ?? "application/x-www-form-urlencoded",
    },
    body: "limit=1",
  };
}

async function auditCount(): Promise<number> {
  return (await api.db.select().from(auditLog)).length;
}

/**
 * A body that declares NO media type, in-process.
 *
 * A string body is no use for this: the `Request` constructor supplies
 * `text/plain;charset=UTF-8` for one, so a test that thought it was sending an
 * undeclared body was really sending `text/plain` and asserting the wrong
 * branch. A `Blob` whose `type` is empty implies nothing, so the header is
 * genuinely absent -- and the body is a live, non-null stream, which is exactly
 * the shape workerd presents for a request that crossed a socket.
 *
 * Pair it with the harness's `Content-Type: ""` marker, or the harness will put
 * `application/json` back on.
 */
function undeclaredBody(json: string): Blob {
  return new Blob([json], { type: "" });
}

describe("a cross-site write is refused", () => {
  it("blocks the credentialed form post, and writes nothing", async () => {
    const before = await auditCount();

    const response = await api.fetch(REKEY, crossSiteForm());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });

    // The point of the finding: not merely a non-2xx, but no side effect. The
    // handler never ran, so there is no audit row under the victim's identity.
    expect(await auditCount()).toBe(before);
  });

  it("blocks it whatever a form is able to encode", async () => {
    for (const contentType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=----x",
      "text/plain",
    ]) {
      const response = await api.fetch(REKEY, crossSiteForm({ contentType }));
      expect(response.status).toBe(403);
    }
  });

  it("treats an opaque Origin as somebody else's", async () => {
    // `Origin: null` is what a sandboxed frame and a cross-origin redirect
    // send. It is a browser declining to name the initiator, not an absent
    // header, and reading it as "no browser involved" would hand an attacker
    // the bypass in one hop.
    const response = await api.fetch(REKEY, crossSiteForm({ origin: "null" }));

    expect(response.status).toBe(403);
  });

  it("blocks a cross-origin request that carries no body at all", async () => {
    // A `<form>` can only issue GET and POST, so this needs `fetch`, which
    // always sets `Origin` -- and a bodiless request has no media type to be
    // wrong about, so the origin check is the only thing standing here.
    const response = await api.fetch("/api/v1/projects/acme", {
      method: "DELETE",
      token: null,
      headers: { Cookie: `CF_Authorization=${token}`, Origin: ATTACKER },
    });

    expect(response.status).toBe(403);

    // And the project is still there.
    const rows = await api.db.select().from(environments);
    expect(rows.length).toBe(1);
  });

  it("blocks a cross-origin write even where the credential is a real header", async () => {
    // The cookie is the realistic vector, but the guard is about the INITIATOR
    // rather than about which credential was used. A page that could set the
    // assertion header would still be a page on another origin.
    const response = await api.fetch(REKEY, {
      method: "POST",
      token,
      headers: { Origin: ATTACKER },
      ...body({ limit: 1 }),
    });

    expect(response.status).toBe(403);
  });
});

describe("a body that is not JSON is refused rather than read as {}", () => {
  it("answers 415, naming what it was given", async () => {
    // No `Origin`: this is the OTHER half of the finding, independent of CSRF.
    // Hono's validator would hand `RekeyBody` an empty object here and the page
    // would be rekeyed by a request whose body said something else entirely.
    const { status, body: envelope } = await api.json<{ code: string; message: string }>(REKEY, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "limit=1",
    });

    expect(status).toBe(415);
    expect(envelope.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(envelope.message).toContain("application/x-www-form-urlencoded");
  });

  it("does not echo a media type that is not one", async () => {
    // The header is still a string an attacker controls, and it reaches a
    // response body and a log line -- so it is pattern-checked and replaced
    // rather than interpolated, the same way `requestId` handles a supplied id.
    const junk = `text/plain, ${"z".repeat(300)} <script>`;
    const { status, body: envelope } = await api.json<{ message: string }>(REKEY, {
      method: "POST",
      token,
      headers: { "Content-Type": junk },
      body: "{}",
    });

    expect(status).toBe(415);
    expect(envelope.message).not.toContain("zzz");
    expect(envelope.message).toContain("something else");
  });

  it("still allows a bodiless state-changing request to declare nothing", async () => {
    // The distinction that keeps the CLI working: no body means nothing to
    // parse, so there is no wrong way to have labelled it.
    const response = await api.fetch("/api/v1/projects/acme", {
      method: "DELETE",
      token,
      headers: { "Content-Type": "" },
    });

    expect(response.status).toBe(204);
  });

  it("lets a body with no declared media type reach the schema, which rejects it", async () => {
    // The guard no longer refuses an undeclared body -- see `crossSiteGuard`
    // for why, and `describe("body presence is never consulted")` below for
    // what forced it. The schema is what answers now, and for every route with
    // a required field that answer is a 422 rather than a write.
    const response = await api.fetch("/api/v1/projects", {
      method: "POST",
      token,
      headers: { "Content-Type": "" },
      body: undeclaredBody('{"slug":"new","name":"New"}'),
    });

    expect(response.status).toBe(422);
  });

  it("PINS THE RESIDUAL: on a fully-defaulted schema an undeclared body runs", async () => {
    /*
     * `RekeyBody` is `{ limit: number.default(REKEY_MAX_PAGE) }`, so the `{}`
     * Hono hands it parses and the handler runs. This is the one belt-and-braces
     * case dropped along with the body-presence check, and it is pinned here
     * rather than left as a surprise.
     *
     * Why it is acceptable: reaching this needs a VALID CREDENTIAL and no
     * `Origin`, i.e. a non-browser client that sent a body and labelled it with
     * nothing. A stranger's page cannot get here -- a browser sets `Origin` on
     * every non-GET/HEAD request and the test above proves that is refused. So
     * this is a broken client, not an attacker.
     *
     * If that ever stops being true -- a state-changing route appears whose
     * every field is defaulted AND whose effect is destructive -- the fix is a
     * per-route `Content-Type` assertion on that route, not a body-presence
     * check here. Change this assertion deliberately, with that reasoning.
     */
    const response = await api.fetch(REKEY, {
      method: "POST",
      token,
      headers: { "Content-Type": "" },
      body: undeclaredBody('{"limit":1}'),
    });

    expect(response.status).toBe(200);
  });

  it("refuses a form post to the secrets write path too", async () => {
    // Covered incidentally by `BatchBody`'s refine before this guard existed --
    // "incidentally" being the problem. It is now refused at the transport, so
    // it stays refused if a field ever becomes optional.
    const before = (await api.db.select().from(environments))[0]?.rev;

    const response = await api.fetch("/api/v1/p/acme/e/prod/secrets:batch", {
      method: "POST",
      token,
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });

    expect(response.status).toBe(415);
    expect((await api.db.select().from(environments))[0]?.rev).toBe(before);
  });
});

describe("the guard cannot be bypassed by a route registered later", () => {
  /*
   * Mounted on the ROOT app with `"*"`, ahead of every mount, which is what
   * these two assert from the outside: a path with no route at all is still
   * refused by the guard rather than by the router, so a route added tomorrow
   * inherits it without anybody remembering to.
   */
  it("refuses a cross-origin post to a path that has no route", async () => {
    const response = await api.fetch("/api/v1/nope", {
      method: "POST",
      token,
      headers: { Origin: ATTACKER },
      ...body({}),
    });

    // 403, not the 401 an unknown path under /api/v1 otherwise answers and not
    // a 404 -- the guard ran before routing and before authentication.
    expect(response.status).toBe(403);
  });

  it("refuses one outside the versioned prefix as well", async () => {
    const response = await api.fetch("/nope", {
      method: "POST",
      token: null,
      headers: { Origin: ATTACKER },
      ...body({}),
    });

    expect(response.status).toBe(403);
  });
});

describe("body presence is never consulted, because it is not one fact", () => {
  /*
   * THE REGRESSION THIS DIRECTORY COULD NOT SEE, AND NOW CAN.
   *
   * `crossSiteGuard` briefly refused a body that declared no media type, and
   * framed "is there a body" on `c.req.raw.body !== null`. In-process that
   * expression is `null` for a bodiless DELETE, so every test here passed. Over
   * a real socket workerd hands the Worker a non-null EMPTY stream for the same
   * request, so it answered 415 -- breaking `prk access revoke`, group deletion
   * and group member removal in the shipped product. Four e2e specs caught it;
   * nothing at this level could, because nothing at this level was producing the
   * wire shape.
   *
   * `undeclaredBody` produces it: a non-null body stream and no `Content-Type`.
   * Both tests below fail with a 415 against the version that framed on
   * `raw.body`, which is the property that was missing.
   */
  it("a DELETE with a live body stream and no media type is still allowed", async () => {
    const response = await api.fetch("/api/v1/projects/acme", {
      method: "DELETE",
      token,
      headers: { "Content-Type": "" },
      body: undeclaredBody(""),
    });

    expect(response.status).toBe(204);
  });

  it("so is a nested one, on the routes the four e2e specs exercised", async () => {
    // `DELETE /grants/:id`, `/groups/:id` and `/groups/:id/members/:id` are the
    // three the wrangler-dev log showed answering 415. A 404 here is fine and is
    // the point: it means the request reached the ROUTER rather than being
    // refused by the transport.
    for (const path of [
      "/api/v1/grants/0199e2e0-0000-7000-8000-000000000000",
      "/api/v1/groups/0199e2e0-0000-7000-8000-000000000000",
      "/api/v1/groups/0199e2e0-0000-7000-8000-000000000000/members/0199e2e0-0000-7000-8000-000000000001",
    ]) {
      const response = await api.fetch(path, {
        method: "DELETE",
        token,
        headers: { "Content-Type": "" },
        body: undeclaredBody(""),
      });

      expect(response.status).not.toBe(415);
      expect(response.status).toBe(404);
    }
  });

  it("names raw.body nowhere in the http tree", () => {
    /*
     * A grep, deliberately, and scoped to the one expression rather than to
     * `.body`: `c.req.raw` itself is legitimate (`context.ts` hands the whole
     * Request to the Access verifier, which reads headers), and it is only
     * BODY PRESENCE that differs between the two runtimes.
     *
     * This is the sentinel form `validation.test.ts` already uses for the
     * zod-validator confinement rule: the behavioural tests above are the real
     * check, and this is what stops the assumption being reintroduced in a diff
     * that looks entirely reasonable.
     */
    const offenders = Object.entries(HTTP_SOURCES)
      .filter(([, source]) => /\braw\s*\.\s*body\b/.test(stripComments(source)))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe("every real client still works", () => {
  /*
   * WHAT EACH ONE ACTUALLY SENDS, checked against the source rather than
   * assumed:
   *
   *   prk (Rust)   `crates/prick-api/src/client.rs` -- every API body goes
   *                through reqwest's `.json()`, which sets the header exactly.
   *                `Body::Form` exists for Access's OAuth token endpoint and
   *                never reaches `/api`. No `Origin` on any request.
   *   MCP          `packages/mcp/src/api.ts` sets `Content-Type:
   *                application/json` whenever there is a body. No `Origin`.
   *   the action   `action/cli.mjs` spawns `prk`, so it is the Rust client.
   *   the admin UI `src/lib/client/api.ts` sets the header and is same-origin,
   *                so the browser sends `Origin: <us>` on every write.
   */

  it("accepts a non-browser client: a header credential, JSON, no Origin", async () => {
    const response = await api.fetch(REKEY, { method: "POST", token, ...body({ limit: 1 }) });

    expect(response.status).toBe(200);
  });

  it("accepts a media type with parameters", async () => {
    // `application/json; charset=utf-8` is what several HTTP stacks send by
    // default. Comparing the raw header would refuse it.
    const response = await api.fetch(REKEY, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ limit: 1 }),
    });

    expect(response.status).toBe(200);
  });

  it("accepts the admin UI: the cookie, a same-origin Origin, and JSON", async () => {
    const response = await api.fetch(REKEY, {
      method: "POST",
      token: null,
      headers: {
        Cookie: `CF_Authorization=${token}`,
        Origin: SELF_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 1 }),
    });

    expect(response.status).toBe(200);
  });

  it("accepts a bodiless DELETE, which declares no media type and need not", async () => {
    const response = await api.fetch("/api/v1/projects/acme", { method: "DELETE", token });

    expect(response.status).toBe(204);
  });

  it("leaves reads alone, cross-origin Origin and all", async () => {
    // A GET changes nothing, and refusing one here would only duplicate what
    // the absence of CORS already does -- less well, since the browser enforces
    // that without this Worker getting a check right.
    const response = await api.fetch("/api/v1/projects", {
      token,
      headers: { Origin: ATTACKER },
    });

    expect(response.status).toBe(200);
  });

  it("leaves the unauthenticated GETs alone", async () => {
    for (const path of ["/api/v1/health", "/api/v1/openapi.json"]) {
      const response = await api.fetch(path, { token: null, headers: { Origin: ATTACKER } });
      expect(response.status).toBe(200);
    }
  });
});
