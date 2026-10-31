import { describe, expect, it, vi } from "vitest";

import {
  CloudflareApiError,
  createAccessServiceTokens,
} from "../../src/lib/server/cloudflare/access.js";

/**
 * The Cloudflare client in isolation.
 *
 * The property that matters most is negative: a response body can carry a
 * client secret, so no failure may echo one. Every error path below is driven
 * with a body containing a sentinel secret, and the sentinel must appear in no
 * thrown message and no console call.
 */

const SECRET = "cfast_SENTINEL0000000000000000000000000000000000000000";

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch) {
  return createAccessServiceTokens({
    apiToken: "api-token",
    accountId: "a".repeat(32),
    baseUrl: "https://api.example.test/client/v4/",
    fetchImpl,
  });
}

const secretBearing = {
  success: false,
  errors: [{ code: 1234, message: `leaked ${SECRET}` }],
  messages: [{ message: SECRET }],
  result: { client_secret: SECRET },
};

describe("failures never carry a response body", () => {
  const cases: [string, typeof fetch, CloudflareApiError["kind"]][] = [
    ["401", respond(401, secretBearing), "refused"],
    ["403", respond(403, secretBearing), "refused"],
    ["404", respond(404, secretBearing), "not_found"],
    ["429", respond(429, secretBearing), "unavailable"],
    ["500", respond(500, secretBearing), "unavailable"],
    ["400", respond(400, secretBearing), "rejected"],
    ["200 with success: false", respond(200, secretBearing), "rejected"],
    ["200 with an unparseable body", respond(200, `not json ${SECRET}`), "rejected"],
    [
      "200 with a result missing its secret",
      respond(200, { success: true, result: { id: "x", client_id: "y.access", note: SECRET } }),
      "malformed",
    ],
    [
      "network failure",
      vi.fn(async () => {
        throw new Error(`socket closed ${SECRET}`);
      }) as unknown as typeof fetch,
      "unavailable",
    ],
  ];

  for (const [label, fetchImpl, kind] of cases) {
    it(`${label} → ${kind}, without the secret`, async () => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );

      const error = await client(fetchImpl)
        .create({ name: "n", duration: "8760h" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).kind).toBe(kind);
      expect(String((error as Error).message)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    });
  }
});

describe("requests", () => {
  it("sends the bearer token to the account's service-token collection", async () => {
    const fetchImpl = respond(200, {
      success: true,
      result: { id: "id-1", client_id: "abc.access", client_secret: SECRET, name: "n" },
    });

    const issued = await client(fetchImpl).create({ name: "n", duration: "720h" });

    expect(issued.clientSecret).toBe(SECRET);
    expect(issued.expiresAt).toBeNull();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://api.example.test/client/v4/accounts/${"a".repeat(32)}/access/service_tokens`,
    );
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer api-token");
    expect(JSON.parse(String(init.body))).toEqual({ name: "n", duration: "720h" });
  });

  it("treats a delete of an unknown token as already gone", async () => {
    expect(await client(respond(404, { success: false, errors: [] })).remove("x")).toBe("absent");
  });

  it("follows pagination to the last page", async () => {
    const page = (n: number, count: number) => ({
      success: true,
      result: Array.from({ length: count }, (_, index) => ({
        id: `${String(n)}-${String(index)}`,
        client_id: `${String(n)}${String(index)}.access`,
        name: "t",
      })),
      result_info: { page: n, per_page: 1000, total_pages: 2 },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page(1, 1000))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(2, 3)))) as unknown as typeof fetch;

    const tokens = await client(fetchImpl).list();

    expect(tokens).toHaveLength(1003);
  });

  it("sends the grace period as an RFC 3339 timestamp, and nothing for an immediate cut", async () => {
    const ok = { success: true, result: { id: "i", client_id: "c.access", client_secret: SECRET } };
    const graceful = respond(200, ok);
    const immediate = respond(200, ok);

    await client(graceful).rotate("i", Date.UTC(2030, 0, 1));
    await client(immediate).rotate("i", null);

    const sent = (impl: typeof fetch) =>
      JSON.parse(
        String(
          ((impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
            .body,
        ),
      ) as unknown;
    expect(sent(graceful)).toEqual({
      previous_client_secret_expires_at: "2030-01-01T00:00:00.000Z",
    });
    expect(sent(immediate)).toEqual({});
  });
});

describe("pagination", () => {
  const page = (start: number, count: number, info: Record<string, number>) =>
    new Response(
      JSON.stringify({
        success: true,
        result: Array.from({ length: count }, (_, index) => ({
          id: `t-${String(start + index)}`,
          client_id: `${String(start + index)}.access`,
          name: "t",
        })),
        result_info: info,
      }),
    );

  it("keeps going past a page shorter than asked for when Cloudflare caps per_page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(0, 50, { page: 1, per_page: 50 }))
      .mockResolvedValueOnce(page(50, 50, { page: 2, per_page: 50 }))
      .mockResolvedValueOnce(page(100, 7, { page: 3, per_page: 50 })) as unknown as typeof fetch;

    expect(await client(fetchImpl).list()).toHaveLength(107);
  });

  it("stops at total_count when Cloudflare reports one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(0, 20, { page: 1, per_page: 20, total_count: 30 }))
      .mockResolvedValueOnce(
        page(20, 10, { page: 2, per_page: 20, total_count: 30 }),
      ) as unknown as typeof fetch;

    expect(await client(fetchImpl).list()).toHaveLength(30);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
