import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import { createApi } from "../../src/lib/server/http/app.js";
import type { Database } from "../../src/lib/server/db/client.js";
import {
  freshDatabase,
  seedGrant,
  seedGroup,
  seedGroupGrant,
  seedGroupMember,
  seedIdentity,
} from "../auth/fixtures.js";
import { certsEndpoint, harnessKeys } from "../auth/harness/client.js";
import { mintServiceToken, mintUserToken } from "../auth/harness/mint.js";
import { TEST_MASTER_KEY } from "../core/fixtures.js";

/**
 * Drive the REAL Hono application over HTTP.
 *
 * ---------------------------------------------------------------------------
 * EVERY TEST IN `test/http/` GOES THROUGH `api.fetch`
 * ---------------------------------------------------------------------------
 * Never through a handler called directly, and never through `core` with a
 * hand-built context. The whole value of this suite is the layers a direct call
 * skips: the request-id middleware, the fail-closed key ring, the REAL Access
 * JWT verifier, the identity upsert, the bootstrap self-heal, `@hono/zod-
 * validator` and its redacting hook, the router's parameter extraction across
 * two mount paths, `onError`'s mapping of a `PrickError` onto a status, and the
 * response headers. A test that calls a handler asserts that the handler is
 * right and says nothing about whether it is reachable, authenticated, or
 * validated -- which is where a transport bug actually lives.
 *
 * ---------------------------------------------------------------------------
 * THE TOKENS ARE REAL
 * ---------------------------------------------------------------------------
 * A fresh RS256 keypair is generated per run and served as a real JWKS at a real
 * URL through miniflare's `outboundService`; `ACCESS_CERTS_URL` points the
 * Worker at it. So `verifyAccessJwt` runs unmodified against tokens signed with
 * the matching private half. Nothing about authentication is stubbed, which is
 * the point: JWT verification is exactly where a security bug would live, so it
 * is the last thing that should be replaced by a fake.
 *
 * The clock is the REAL one, deliberately. `test/auth/fixtures.ts` pins `NOW` to
 * a fixed instant so grant expiry is deterministic, but the Worker under test
 * calls `Date.now()` -- a token minted against the pinned instant carries an
 * `nbf` months in the future and is refused as "not valid yet". Tests that need
 * an expired grant compute the expiry from `Date.now()` instead.
 */

/** A certs URL that no other test shares, so the JWKS cache cannot leak. */
const certs = certsEndpoint("primary");

/**
 * The baseline global administrator.
 *
 * Seeded by default, and it has to be: `assertAdminsConfigured` runs on EVERY
 * authenticated request and answers 503 `NO_ADMINS_CONFIGURED` when neither
 * `BOOTSTRAP_ADMINS` nor a usable global admin grant exists. `freshDatabase()`
 * truncates `grants`, so without this row every test in this directory would be
 * asserting that 503 by accident -- including the ones that believe they are
 * testing a reader's permissions.
 *
 * It is a real grants row rather than a `BOOTSTRAP_ADMINS` entry so that the
 * bootstrap self-heal path stays untaken except in the tests that are about it.
 */
export const OWNER = "owner@example.com";

export interface ApiHarness {
  db: Database;
  /** Issue a request as `token`. Set `token` to `null` for anonymous. */
  fetch(path: string, init?: RequestInit & { token?: string | null }): Promise<Response>;
  /** `fetch`, parsed, with a status assertion left to the caller. */
  json<T = unknown>(
    path: string,
    init?: RequestInit & { token?: string | null },
  ): Promise<{ status: number; body: T; headers: Headers }>;
  /** A verified Access token for a human subject. */
  userToken(email: string): Promise<string>;
  /** A verified Access token for a service token's `common_name`. */
  serviceToken(commonName: string): Promise<string>;
  /** Create the identity row and a grant in one step. */
  grant(input: {
    subject: string;
    kind?: "user" | "service";
    role: "reader" | "writer" | "admin";
    scopeType: "global" | "project" | "environment";
    projectId?: string | null;
    environmentId?: string | null;
    expiresAt?: number | null;
    disabled?: boolean;
  }): Promise<{ identityId: string; grantId: string }>;
  /**
   * The same thing, one level of indirection further out: create the identity,
   * a group, put one in the other, and grant the GROUP the role.
   *
   * Signature-identical to `grant` on purpose. Every assertion that a
   * group-derived role behaves exactly like a direct one is then a matter of
   * swapping one call for the other, which is the cheapest possible way to be
   * sure the two paths are not quietly different.
   */
  groupGrant(input: {
    subject: string;
    kind?: "user" | "service";
    role: "reader" | "writer" | "admin";
    scopeType: "global" | "project" | "environment";
    projectId?: string | null;
    environmentId?: string | null;
    expiresAt?: number | null;
    disabled?: boolean;
    /** Defaults to a slug derived from the subject. */
    group?: string;
  }): Promise<{ identityId: string; groupId: string; grantId: string }>;
  /** A token for the baseline global administrator. */
  ownerToken(): Promise<string>;
  /** The bindings the app is invoked with, so a test can vary one. */
  bindings(overrides?: Record<string, unknown>): Env;
}

export interface HarnessOptions {
  /** Passed through as the `BOOTSTRAP_ADMINS` var. */
  bootstrapAdmins?: string;
  /**
   * Seed the baseline global admin. Default `true`.
   *
   * Set `false` only when the test is ABOUT an installation with no
   * administrator -- every other test needs one to exist or it will be
   * measuring `NO_ADMINS_CONFIGURED` rather than whatever it meant to measure.
   */
  seedOwner?: boolean;
}

export async function apiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const db = await freshDatabase();
  const keys = await harnessKeys();

  // ONE app per harness, not one per request. It is stateless, and building it
  // per call would re-generate the OpenAPI document on every documented route.
  const api = createApi();

  const baseBindings = {
    ...env,
    MASTER_KEY: TEST_MASTER_KEY,
    ACCESS_CERTS_URL: certs.url,
    // Empty unless a test is exercising the bootstrap path. `NO_ADMINS_
    // CONFIGURED` would otherwise fire on a database whose grants were just
    // truncated, and every test would be asserting the 503 by accident.
    BOOTSTRAP_ADMINS: options.bootstrapAdmins ?? "",
  } as unknown as Env;

  const bindings = (overrides: Record<string, unknown> = {}): Env =>
    ({ ...baseBindings, ...overrides }) as unknown as Env;

  const mint = (subject: string, kind: "user" | "service"): Promise<string> => {
    const now = Date.now();
    const common = {
      privateJwk: keys.primary.privateJwk,
      kid: keys.primary.kid,
      team: "test-team",
      aud: "test-aud",
      now,
    };

    return kind === "user"
      ? mintUserToken({ ...common, claims: { email: subject } })
      : mintServiceToken({ ...common, claims: { common_name: subject } });
  };

  const fetchWith = async (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ): Promise<Response> => {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);

    if (token !== null && token !== undefined) {
      headers.set("Cf-Access-Jwt-Assertion", token);
    }
    /*
     * A body implies `application/json`, unless the caller asked for silence.
     *
     * `Content-Type: ""` is the escape hatch, and `csrf.test.ts` is what needs
     * it: a request with a body and NO media type is the shape workerd hands the
     * Worker for a bodiless `DELETE` that crossed a socket, and reproducing it
     * in-process is the only way this directory can see the class of bug that
     * shipped once already. The default below would put the header back on.
     *
     * An empty string is not a media type any client can send, so it is free to
     * mean "send none" rather than being a value some other test might rely on.
     *
     * NOTE that the header must be suppressed AND the body must imply nothing:
     * the `Request` constructor supplies `text/plain;charset=UTF-8` for a STRING
     * body regardless of what is deleted here. See `undeclaredBody`.
     */
    if (headers.get("Content-Type") === "") {
      headers.delete("Content-Type");
    } else if (rest.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const ctx = createExecutionContext();
    const response = await api.fetch(
      new Request(`https://prick.test${path}`, { ...rest, headers }),
      baseBindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    return response;
  };

  if (options.seedOwner !== false) {
    const ownerId = await seedIdentity(db, { kind: "user", subject: OWNER });
    await seedGrant(db, { identityId: ownerId, role: "admin", scopeType: "global" });
  }

  return {
    db,
    fetch: fetchWith,
    ownerToken: () => mint(OWNER, "user"),
    async json<T>(path: string, init: RequestInit & { token?: string | null } = {}) {
      const response = await fetchWith(path, init);
      const text = await response.text();

      return {
        status: response.status,
        headers: response.headers,
        body: (text === "" ? undefined : JSON.parse(text)) as T,
      };
    },
    userToken: (email) => mint(email, "user"),
    serviceToken: (commonName) => mint(commonName, "service"),
    async grant(input) {
      const identityId = await seedIdentity(db, {
        kind: input.kind ?? "user",
        subject: input.subject,
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      });

      const grantId = await seedGrant(db, {
        identityId,
        role: input.role,
        scopeType: input.scopeType,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
        expiresAt: input.expiresAt ?? null,
      });

      return { identityId, grantId };
    },
    async groupGrant(input) {
      const identityId = await seedIdentity(db, {
        kind: input.kind ?? "user",
        subject: input.subject,
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      });

      const groupId = await seedGroup(
        db,
        input.group ?? `grp-${input.subject.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      );

      await seedGroupMember(db, groupId, identityId);

      const grantId = await seedGroupGrant(db, {
        groupId,
        role: input.role,
        scopeType: input.scopeType,
        projectId: input.projectId ?? null,
        environmentId: input.environmentId ?? null,
        expiresAt: input.expiresAt ?? null,
      });

      return { identityId, groupId, grantId };
    },
    bindings,
  };
}

/** JSON body helper: `{ ...body(x) }` spreads into a `RequestInit`. */
export function body(value: unknown): { body: string } {
  return { body: JSON.stringify(value) };
}
