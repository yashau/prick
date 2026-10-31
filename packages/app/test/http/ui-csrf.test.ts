import { describe, expect, it } from "vitest";

import { crossSiteFormRefusal, isCrossSiteFormSubmission } from "../../src/lib/server/csrf.js";

/**
 * The admin UI's cross-site form guard, the one `hooks.server.ts` applies to
 * every path outside `/api`. The rule is SvelteKit's own; these pin it, so the
 * move from the framework into the hook cannot quietly loosen it.
 */

const SELF = "https://prick.example.com";
const EVIL = "https://evil.example.net";

function request(method: string, headers: Record<string, string>): Request {
  return new Request(`${SELF}/projects?/create`, { method, headers });
}

describe("a cross-site form submission to the admin UI", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("is refused for %s from another origin", (method) => {
    const forged = request(method, {
      origin: EVIL,
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(isCrossSiteFormSubmission(forged, SELF)).toBe(true);
  });

  it.each([
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "text/plain;charset=UTF-8",
    "application/x-sveltekit-formdata",
  ])("is refused when it declares %s", (contentType) => {
    const forged = request("POST", { origin: EVIL, "content-type": contentType });
    expect(isCrossSiteFormSubmission(forged, SELF)).toBe(true);
  });

  it("is refused when it declares no media type at all", () => {
    expect(isCrossSiteFormSubmission(request("POST", { origin: EVIL }), SELF)).toBe(true);
  });

  it("is refused when it carries no Origin", () => {
    const anonymous = request("POST", { "content-type": "multipart/form-data; boundary=x" });
    expect(isCrossSiteFormSubmission(anonymous, SELF)).toBe(true);
  });

  it("answers 403, as JSON when JSON was asked for", async () => {
    const plain = crossSiteFormRefusal(request("POST", { origin: EVIL }));
    expect(plain.status).toBe(403);
    expect(await plain.text()).toBe("Cross-site POST form submissions are forbidden");

    const json = crossSiteFormRefusal(
      request("POST", { origin: EVIL, accept: "application/json" }),
    );
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({
      message: "Cross-site POST form submissions are forbidden",
    });
  });
});

describe("a request the guard lets through", () => {
  it("is a form action posted from this app", () => {
    const own = request("POST", {
      origin: SELF,
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(isCrossSiteFormSubmission(own, SELF)).toBe(false);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("is any %s", (method) => {
    expect(isCrossSiteFormSubmission(request(method, { origin: EVIL }), SELF)).toBe(false);
  });

  it("is a JSON body, which no form can produce", () => {
    const json = request("POST", { origin: EVIL, "content-type": "application/json" });
    expect(isCrossSiteFormSubmission(json, SELF)).toBe(false);
  });
});
