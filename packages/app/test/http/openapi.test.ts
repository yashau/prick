import { describe, expect, it } from "vitest";

import { SCALAR_CDN } from "../../src/lib/server/http/middleware.js";
import { apiHarness, type ApiHarness } from "./harness.js";

/**
 * The OpenAPI document and the reference viewer.
 *
 * The document is generated from the ROUTE TABLE, so these assertions are also
 * the cheapest available test that a route is mounted at the path everybody
 * believes it is. A typo in a path string produces a document that documents the
 * typo, and the `docs/openapi.json` staleness check in CI then makes that a
 * visible diff rather than a 404 somebody hits in a month.
 */

interface Document {
  openapi: string;
  info: { title: string; description: string };
  servers: { url: string }[];
  security: Record<string, string[]>[];
  components: {
    securitySchemes: Record<string, { type: string; in: string; name: string }>;
    schemas: Record<string, unknown>;
  };
  paths: Record<
    string,
    Record<string, { operationId: string; responses: Record<string, unknown> }>
  >;
}

async function document(api: ApiHarness): Promise<Document> {
  const response = await api.fetch("/api/v1/openapi.json", { token: null });
  expect(response.status).toBe(200);
  return (await response.json()) as Document;
}

describe("GET /api/v1/openapi.json", () => {
  it("is served unauthenticated, because it describes shape and carries no data", async () => {
    // It is generated from the route table and from zod schemas, both already
    // public in the repository. Putting it behind Access would mean an operator
    // cannot read the reference to work out how to authenticate.
    const api = await apiHarness();
    const doc = await document(api);

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("prick");
    expect(doc.servers[0]?.url).toBe("/api/v1");
  });

  it("documents the two Access service-token headers as one requirement", async () => {
    /*
     * `CF-Access-Client-Id` and `CF-Access-Client-Secret` are listed in a SINGLE
     * requirement object, which in OpenAPI means AND. One without the other is
     * not a credential, and documenting them as alternatives would tell a CI
     * integrator that either would do.
     *
     * The assertion header is a separate requirement object, which means OR.
     */
    const api = await apiHarness();
    const doc = await document(api);

    const schemes = doc.components.securitySchemes;

    expect(schemes["accessClientId"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "CF-Access-Client-Id",
    });
    expect(schemes["accessClientSecret"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "CF-Access-Client-Secret",
    });
    expect(schemes["accessAssertion"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "Cf-Access-Jwt-Assertion",
    });

    expect(doc.security).toEqual([
      { accessClientId: [], accessClientSecret: [] },
      { accessAssertion: [] },
    ]);
  });

  it("documents every mounted operation", async () => {
    const api = await apiHarness();
    const doc = await document(api);

    const operations = new Set(
      Object.values(doc.paths).flatMap((methods) =>
        Object.values(methods).map((operation) => operation.operationId),
      ),
    );

    for (const expected of [
      "health",
      "whoami",
      "listProjects",
      "createProject",
      "getProject",
      "updateProject",
      "deleteProject",
      "listEnvironments",
      "createEnvironment",
      "getEnvironment",
      "deleteEnvironment",
      "listSecrets",
      "writeSecrets",
      "importSecrets",
      "exportSecrets",
      "renameSecret",
      "rollbackSecret",
      "revealSecret",
      "listSecretVersions",
      "listIdentities",
      "updateIdentity",
      "listGrants",
      "createGrant",
      "revokeGrant",
      "explainIdentityPermissions",
      "listGroups",
      "createGroup",
      "getGroup",
      "updateGroup",
      "deleteGroup",
      "listGroupMembers",
      "addGroupMember",
      "removeGroupMember",
      "listGroupGrants",
      "createGroupGrant",
      "revokeGroupGrant",
      "listUnknownIdentities",
      "queryAudit",
      "getKeyringStatus",
      "rekeyPage",
    ]) {
      expect(operations, expected).toContain(expected);
    }
  });

  it("documents the canonical paths and omits the slug aliases", async () => {
    // The alias mounts are the SAME handlers under a second path. Documenting
    // them would double the document to say the same thing twice; the fact that
    // they exist belongs in `info.description`, which is where a statement about
    // the whole surface goes.
    const api = await apiHarness();
    const doc = await document(api);

    const paths = Object.keys(doc.paths);

    expect(paths).toContain("/api/v1/projects/{project}/environments/{env}/secrets");
    expect(paths.filter((path) => path.startsWith("/api/v1/p/"))).toEqual([]);
    expect(doc.info.description).toContain("/p/{project}/e/{env}");
  });

  it("does not document itself or the viewer", async () => {
    const api = await apiHarness();
    const paths = Object.keys((await document(api)).paths);

    expect(paths).not.toContain("/api/v1/openapi.json");
    expect(paths).not.toContain("/api/v1/docs");
  });

  it("gives every operation the shared error responses", async () => {
    const api = await apiHarness();
    const doc = await document(api);

    const batch =
      doc.paths["/api/v1/projects/{project}/environments/{env}/secrets:batch"]?.["post"];

    expect(Object.keys(batch?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "412",
      "413",
      "422",
      "500",
      "503",
    ]);
  });

  it("states the rules that are not visible from a route table", async () => {
    const api = await apiHarness();
    const { description } = (await document(api)).info;

    expect(description).toContain("no CORS");
    expect(description).toContain("404");
    expect(description).toContain("never echoes input");
  });

  it("carries the error envelope as a reusable component", async () => {
    const api = await apiHarness();
    const doc = await document(api);

    expect(doc.components.schemas["ApiError"]).toBeDefined();
  });
});

/**
 * The committed document is the served document.
 *
 * `scripts/openapi.mjs check` is the CI gate, and it runs under plain Node with
 * a module-resolution hook to load TypeScript source. This assertion is the
 * belt to that braces: it compares the file against what the ROUTER actually
 * serves, inside the same runtime the Worker uses, so the two generators cannot
 * quietly diverge -- and a stale document fails the ordinary test run rather
 * than only the job somebody remembered to wire.
 */
const COMMITTED = import.meta.glob("../../../../docs/openapi.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("docs/openapi.json", () => {
  it("is committed", () => {
    expect(Object.keys(COMMITTED)).toHaveLength(1);
  });

  it("matches what the router serves", async () => {
    const api = await apiHarness();
    const served = await document(api);

    const committed = JSON.parse(Object.values(COMMITTED)[0] ?? "{}") as Document;

    expect(committed).toEqual(served);
  });
});

describe("GET /api/v1/docs", () => {
  it("serves the Scalar reference", async () => {
    const api = await apiHarness();
    const response = await api.fetch("/api/v1/docs", { token: null });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("/api/v1/openapi.json");
  });

  it("pins the third-party bundle to an exact version", async () => {
    /*
     * Scalar's default `cdn` is an unversioned jsDelivr URL -- "whatever is
     * latest when a browser asks". That is a dependency of this deployment that
     * nothing in the repository governs: `minimumReleaseAge` constrains what
     * pnpm resolves at install time and has no reach over what a page fetches at
     * view time. jsDelivr serves versioned artefacts immutably, so pinning turns
     * it into a fixed set of bytes that moves only when somebody edits a line.
     */
    const api = await apiHarness();
    const html = await (await api.fetch("/api/v1/docs", { token: null })).text();

    expect(html).toContain(SCALAR_CDN);
    expect(SCALAR_CDN).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+$/);
  });

  it("confines the page with a content security policy", async () => {
    // `connect-src 'self'` is the clause that matters: the page fetches one
    // document from this origin and nothing else, so a compromised bundle has
    // no egress. `form-action` and `base-uri` close the two ways a script gets
    // data out without `fetch`.
    const api = await apiHarness();
    const csp = (await api.fetch("/api/v1/docs", { token: null })).headers.get(
      "Content-Security-Policy",
    );

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("does not put that policy on any other route", async () => {
    // It is wrong everywhere else: the API answers JSON to non-browser clients,
    // and the admin UI has its own policy from `svelte.config.js`.
    const api = await apiHarness();

    for (const path of ["/api/v1/health", "/api/v1/openapi.json"]) {
      const response = await api.fetch(path, { token: null });
      expect(response.headers.get("Content-Security-Policy"), path).toBeNull();
    }
  });
});
