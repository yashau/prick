import { beforeEach, describe, expect, it } from "vitest";

import { seedEnvironment, seedProject } from "../auth/fixtures.js";
import { apiHarness, body, OWNER, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let owner: string;
let projectId: string;

beforeEach(async () => {
  api = await apiHarness();
  projectId = await seedProject(api.db, "acme");
  await seedEnvironment(api.db, projectId, "prod");
  owner = await api.ownerToken();
});

describe("identities", () => {
  it("lists every subject that has ever authenticated", async () => {
    const stranger = await api.serviceToken("stranger.access");
    await api.fetch("/api/v1/whoami", { token: stranger });

    const listed = await api.json<{ subject: string; kind: string; disabled: boolean }[]>(
      "/api/v1/identities",
      { token: owner },
    );

    expect(listed.body.map((row) => row.subject).sort()).toEqual([OWNER, "stranger.access"]);
  });

  it("names a service token, which is the only thing that makes it revocable", async () => {
    // `e367826f93b8d71185e03fe518aff3b4.access` in an access list is how a stale
    // token survives three audits.
    const stranger = await api.serviceToken("e367826f93b8d71185e03fe518aff3b4.access");
    await api.fetch("/api/v1/whoami", { token: stranger });

    const listed = await api.json<{ id: string; subject: string }[]>("/api/v1/identities", {
      token: owner,
    });
    const id = listed.body.find((row) => row.subject.endsWith(".access"))?.id ?? "";

    const patched = await api.json<{ displayName: string }>(`/api/v1/identities/${id}`, {
      method: "PATCH",
      token: owner,
      ...body({ display_name: "staging deploy" }),
    });

    expect(patched.status).toBe(200);
    expect(patched.body.displayName).toBe("staging deploy");
  });

  it("disables an identity, and the kill switch takes effect immediately", async () => {
    const { identityId } = await api.grant({
      subject: "goodbye@example.com",
      role: "admin",
      scopeType: "global",
    });

    const token = await api.userToken("goodbye@example.com");
    expect((await api.fetch("/api/v1/identities", { token })).status).toBe(200);

    await api.fetch(`/api/v1/identities/${identityId}`, {
      method: "PATCH",
      token: owner,
      ...body({ disabled: true }),
    });

    expect((await api.fetch("/api/v1/identities", { token })).status).toBe(403);
  });

  it("404s for an identity that does not exist, and 422s for a non-uuid", async () => {
    const missing = "01920000-0000-7000-8000-000000000000";

    expect(
      (
        await api.fetch(`/api/v1/identities/${missing}`, {
          method: "PATCH",
          token: owner,
          ...body({ disabled: true }),
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await api.fetch("/api/v1/identities/not-a-uuid", {
          method: "PATCH",
          token: owner,
          ...body({ disabled: true }),
        })
      ).status,
    ).toBe(422);
  });
});

describe("grants", () => {
  it("creates one at each scope, and refuses a duplicate", async () => {
    const { identityId } = await api.grant({
      subject: "target@example.com",
      role: "reader",
      scopeType: "project",
      // A grant on a DIFFERENT project, so the ones created below are the first
      // at their own scopes.
      projectId: await seedProject(api.db, "other"),
    });

    const created = await api.json<{ scopeType: string; projectSlug: string | null }>(
      "/api/v1/grants",
      {
        method: "POST",
        token: owner,
        ...body({
          scope_type: "environment",
          project: "acme",
          environment: "prod",
          identity_id: identityId,
          role: "writer",
        }),
      },
    );

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ scopeType: "environment", projectSlug: "acme" });

    // A duplicate is a CONFLICT, not an upsert. Silently upgrading an existing
    // reader grant to admin because somebody re-submitted a form is precisely
    // the change nobody would notice.
    const again = await api.fetch("/api/v1/grants", {
      method: "POST",
      token: owner,
      ...body({
        scope_type: "environment",
        project: "acme",
        environment: "prod",
        identity_id: identityId,
        role: "admin",
      }),
    });

    expect(again.status).toBe(409);
  });

  it("rejects a scope field that does not belong to the scope type", async () => {
    // The body is a discriminated union, so `{scope_type: "global", project:
    // "acme"}` is a 422 rather than something the server has to guess about --
    // and guessing is how an over-broad grant gets created and nobody notices.
    const { identityId } = await api.grant({
      subject: "target@example.com",
      role: "reader",
      scopeType: "project",
      projectId,
    });

    const response = await api.fetch("/api/v1/grants", {
      method: "POST",
      token: owner,
      ...body({ scope_type: "global", project: "acme", identity_id: identityId, role: "reader" }),
    });

    expect(response.status).toBe(422);
  });

  it("refuses to revoke the last global administrator", async () => {
    /*
     * There is no recovery credential in this design, so "are you sure?" is not
     * a question a dialog can be trusted to ask. The only way back from an
     * accidental lockout is editing a var and redeploying.
     */
    const listed = await api.json<{ id: string; subject: string; scopeType: string }[]>(
      "/api/v1/grants",
      { token: owner },
    );
    const ownerGrant = listed.body.find(
      (row) => row.subject === OWNER && row.scopeType === "global",
    );

    const response = await api.fetch(`/api/v1/grants/${ownerGrant?.id ?? ""}`, {
      method: "DELETE",
      token: owner,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "LAST_ADMIN" });
  });

  it("allows it once a second global admin exists", async () => {
    await api.grant({ subject: "successor@example.com", role: "admin", scopeType: "global" });

    const listed = await api.json<{ id: string; subject: string; scopeType: string }[]>(
      "/api/v1/grants",
      { token: owner },
    );
    const ownerGrant = listed.body.find(
      (row) => row.subject === OWNER && row.scopeType === "global",
    );

    expect(
      (
        await api.fetch(`/api/v1/grants/${ownerGrant?.id ?? ""}`, {
          method: "DELETE",
          token: owner,
        })
      ).status,
    ).toBe(204);
  });

  it("hides expired grants from the listing", async () => {
    await api.grant({
      subject: "lapsed@example.com",
      role: "reader",
      scopeType: "project",
      projectId,
      expiresAt: Date.now() - 1,
    });

    const listed = await api.json<{ subject: string }[]>("/api/v1/grants", { token: owner });

    expect(listed.body.map((row) => row.subject)).not.toContain("lapsed@example.com");
  });

  it("404s when the scope names a project the caller cannot see", async () => {
    // The scope is resolved -- and refused -- before the role is considered, so
    // `POST /grants` is as much of a non-oracle as `GET /projects/{slug}`.
    const { identityId } = await api.grant({
      subject: "target@example.com",
      role: "reader",
      scopeType: "global",
    });
    const nobody = await api.userToken("nobody@example.com");

    const response = await api.fetch("/api/v1/grants", {
      method: "POST",
      token: nobody,
      ...body({
        scope_type: "project",
        project: "acme",
        identity_id: identityId,
        role: "reader",
      }),
    });

    expect(response.status).toBe(404);
  });
});
