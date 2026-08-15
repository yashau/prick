import { beforeEach, describe, expect, it } from "vitest";

import { apiHarness, body, type ApiHarness } from "./harness.js";

let api: ApiHarness;
let owner: string;

beforeEach(async () => {
  api = await apiHarness();
  owner = await api.ownerToken();
});

/**
 * The key ring routes.
 *
 * Both currently answer 501, because `core/keyring.ts` is a pair of stubs. They
 * are mounted anyway: `501 NOT_IMPLEMENTED` is a truthful answer a client can
 * branch on, whereas a `404` from an unmounted route is indistinguishable from a
 * typo -- and fixing the paths now means the settings screen and the cron
 * trigger are written against the surface they will keep.
 *
 * These tests are deliberately written so that IMPLEMENTING the domain functions
 * makes them fail. That is the intended signal: the day `getKeyringStatus`
 * returns a ring, this file has to be rewritten to assert its contents, and the
 * authorization note below has to be discharged.
 */
describe("admin/keyring", () => {
  it("answers 501 until the domain function exists", async () => {
    const response = await api.fetch("/api/v1/admin/keyring", { token: owner });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("is behind authentication like everything else", async () => {
    expect((await api.fetch("/api/v1/admin/keyring", { token: null })).status).toBe(401);
  });

  it("performs NO authorization check, which is a gap in the domain layer", async () => {
    /*
     * DOCUMENTING A KNOWN HOLE RATHER THAN HIDING IT.
     *
     * `getKeyringStatus` and `rekeyPage` throw `NOT_IMPLEMENTED` without calling
     * `assertRole`, so every authenticated caller reaches the same 501 -- a
     * grantless service token included. That leaks nothing today, because the
     * response is identical for everyone and contains no data.
     *
     * It stops being harmless the moment either function does something. Both
     * need `assertRole(ctx, { type: "global" }, "admin")` as their first
     * statement, in `core`, before they return a ring or re-encrypt a row. This
     * test exists so that requirement is impossible to lose: it will start
     * failing at exactly the right moment.
     */
    const stranger = await api.serviceToken("nobody.access");

    expect((await api.fetch("/api/v1/admin/keyring", { token: stranger })).status).toBe(501);
  });
});

describe("admin/rekey", () => {
  it("answers 501 until the domain function exists", async () => {
    const response = await api.fetch("/api/v1/admin/rekey", {
      method: "POST",
      token: owner,
      ...body({ limit: 100 }),
    });

    expect(response.status).toBe(501);
  });

  it("validates the page size before it gets there", async () => {
    // The bound is not decorative: a rekey re-encrypts row by row inside one
    // invocation, and `batch()` has a documented 30 s ceiling. An unbounded
    // `limit` is a request that either finishes or times out having done an
    // unknown amount of work.
    for (const payload of [{ limit: 0 }, { limit: 100_000 }, { limit: "100" }, { pages: 1 }]) {
      const response = await api.fetch("/api/v1/admin/rekey", {
        method: "POST",
        token: owner,
        ...body(payload),
      });

      expect(response.status, JSON.stringify(payload)).toBe(422);
    }
  });

  it("defaults the page size when the field is omitted", async () => {
    const response = await api.fetch("/api/v1/admin/rekey", {
      method: "POST",
      token: owner,
      ...body({}),
    });

    // 501 rather than 422: the body validated, the default applied, and the
    // domain function is what refused.
    expect(response.status).toBe(501);
  });
});
