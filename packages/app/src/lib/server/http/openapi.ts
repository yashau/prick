import type { Hono } from "hono";
import type { DescribeRouteOptions, GenerateSpecOptions } from "hono-openapi";
import { describeRoute, generateSpecs } from "hono-openapi";
import type { OpenAPIV3_1 } from "openapi-types";
import { z, type ZodType } from "zod";

import type { ApiEnv } from "./env.js";
import { ErrorResponse } from "./schemas.js";

/**
 * The OpenAPI document, and the helpers that keep it honest.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCHEMAS ARE CONVERTED HERE RATHER THAN BY `resolver()`
 * ---------------------------------------------------------------------------
 * `hono-openapi` ships a `resolver()` that defers schema conversion until the
 * document is generated. It resolves those deferred objects in exactly one
 * place -- inside `responses` -- and nowhere else, so a `resolver()` left in a
 * `requestBody` is serialised as the literal object `{"vendor":"zod"}` and the
 * document silently documents nothing.
 *
 * Rather than use it for half the document and something else for the other
 * half, everything goes through `jsonSchema()` below, which is zod v4's own
 * `z.toJSONSchema`. It is synchronous, so a route definition stays a plain
 * expression; it emits 2020-12, which is what OpenAPI 3.1 uses; and the output
 * is a pure value, which is what makes `docs/openapi.json` byte-stable enough
 * for a staleness check to mean something.
 *
 * `hono-openapi`'s own `validator()` is likewise unused: validation is
 * `@hono/zod-validator` through `http/validate.ts`, because the redacting error
 * hook is not optional here and that helper is the only place it is installed.
 * The consequence is that request shapes are DOCUMENTED here and ENFORCED there,
 * from the same schema object, imported once.
 */

/**
 * A zod schema as an OpenAPI 3.1 schema object.
 *
 * `io: "input"` is what a request body is: `BatchBody.mode` has a default, so
 * the OUTPUT type has it required and the INPUT type has it optional, and a
 * document generated from the output would tell every client that `mode` is
 * mandatory when the server is perfectly happy without it.
 *
 * `unrepresentable: "any"` covers the handful of refinements JSON Schema cannot
 * express -- `SecretValue`'s UTF-8 BYTE bound, most importantly, which is a
 * predicate rather than a `maxLength`. Throwing instead would mean the document
 * could not be generated at all because one field's constraint is only
 * checkable in code; emitting the field without that one keyword is the honest
 * degradation, and the constraint is still enforced, still returns 422, and is
 * written down in the route description.
 */
export function jsonSchema(
  schema: ZodType,
  io: "input" | "output" = "input",
): OpenAPIV3_1.SchemaObject {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as OpenAPIV3_1.SchemaObject;
}

/** A JSON response body, documented from its zod schema. */
export function jsonResponse(description: string, schema: ZodType): OpenAPIV3_1.ResponseObject {
  return {
    description,
    content: { "application/json": { schema: jsonSchema(schema, "output") } },
  };
}

/** A JSON request body, documented from its zod schema. */
export function jsonBody(description: string, schema: ZodType): OpenAPIV3_1.RequestBodyObject {
  return {
    description,
    required: true,
    content: { "application/json": { schema: jsonSchema(schema, "input") } },
  };
}

/**
 * The error envelope, as a reusable response.
 *
 * Attached to every documented route, because every route can produce all of
 * these: the keyring middleware can answer 500 before routing, the
 * authentication middleware 401 or 503, and `core` 403/404/409/412/413/422 from
 * inside any handler. Listing them per route from one constant is what keeps
 * them from drifting into "the ones the author remembered".
 */
const ERROR_SCHEMA = { $ref: "#/components/schemas/ApiError" } as const;

function errorResponse(description: string): OpenAPIV3_1.ResponseObject {
  return { description, content: { "application/json": { schema: ERROR_SCHEMA } } };
}

/** Errors any authenticated route may return. */
const COMMON_ERRORS: Record<string, OpenAPIV3_1.ResponseObject> = {
  400: errorResponse(
    "`BAD_REQUEST` — a malformed `If-Match`, or a precondition this API cannot express.",
  ),
  401: errorResponse("`UNAUTHENTICATED` — no valid Cloudflare Access assertion was presented."),
  403: errorResponse(
    "`FORBIDDEN` — authenticated, but no grant covers this scope. The denial is audited.",
  ),
  404: errorResponse(
    "`NOT_FOUND` — absent **or** invisible, deliberately indistinguishable. Returning 403 for one and 404 for the other would turn this API into an oracle for which slugs are in use.",
  ),
  422: errorResponse(
    "`VALIDATION_FAILED` — schema rejection, including an unknown field. `issues` carries `{path, message}` and never the submitted value.",
  ),
  500: errorResponse("`INTERNAL`, `DECRYPT_FAILED`, `UNKNOWN_KID` or `SERVER_MISCONFIGURED`."),
  503: errorResponse("`NO_ADMINS_CONFIGURED` or `IDENTITY_PROVIDER_UNAVAILABLE`."),
};

export interface RouteSpec {
  summary: string;
  description: string;
  tags: string[];
  operationId: string;
  /** Extra non-error responses, keyed by status. */
  responses: Record<string, OpenAPIV3_1.ResponseObject>;
  requestBody?: OpenAPIV3_1.RequestBodyObject;
  parameters?: OpenAPIV3_1.ParameterObject[];
  /** Statuses beyond the common set, e.g. 409 / 412 / 413 on a write. */
  errors?: Record<string, string>;
}

/**
 * Document one operation.
 *
 * A wrapper over `describeRoute` rather than a direct call, so that the common
 * error responses and the security requirement are attached to every route by
 * construction. A route documented without them would advertise an endpoint that
 * appears to be unauthenticated.
 */
export function describe(spec: RouteSpec) {
  const extraErrors: Record<string, OpenAPIV3_1.ResponseObject> = {};
  for (const [status, description] of Object.entries(spec.errors ?? {})) {
    extraErrors[status] = errorResponse(description);
  }

  const options: DescribeRouteOptions = {
    summary: spec.summary,
    description: spec.description,
    tags: spec.tags,
    operationId: spec.operationId,
    responses: { ...spec.responses, ...COMMON_ERRORS, ...extraErrors },
  };

  if (spec.requestBody !== undefined) options.requestBody = spec.requestBody;
  if (spec.parameters !== undefined) options.parameters = spec.parameters;

  return describeRoute(options);
}

/** A `no-store` response, documented so the caching contract is discoverable. */
export const NO_STORE_HEADERS: Record<string, OpenAPIV3_1.HeaderObject> = {
  "Cache-Control": {
    description: "`no-store, no-cache, must-revalidate, private`.",
    schema: { type: "string" },
  },
  "Cloudflare-CDN-Cache-Control": {
    description:
      "`no-store`. Cloudflare's edge cache does not necessarily honour `Cache-Control`, so it is told separately.",
    schema: { type: "string" },
  },
  Vary: {
    description:
      "`Cf-Access-Jwt-Assertion`, so a cached entry can never be served across identities.",
    schema: { type: "string" },
  },
};

export const ETAG_HEADER: Record<string, OpenAPIV3_1.HeaderObject> = {
  ETag: {
    description:
      "The environment's revision, as a strong entity tag. Send it back as `If-Match` on a write to make that write conditional.",
    schema: { type: "string" },
  },
};

export const IF_MATCH_PARAMETER: OpenAPIV3_1.ParameterObject = {
  in: "header",
  name: "If-Match",
  required: false,
  description:
    "The `ETag` from the most recent `GET` of this environment's secrets. A mismatch is `412` and the environment is left byte-for-byte unchanged. Equivalent to `expected_rev` in the body; sending both is allowed only when they agree.",
  schema: { type: "string" },
};

/**
 * The document's static half.
 *
 * ---------------------------------------------------------------------------
 * THE SECURITY SCHEMES ARE THE PART WORTH READING
 * ---------------------------------------------------------------------------
 * Three schemes, in two alternatives:
 *
 *   accessServiceToken   `CF-Access-Client-Id` + `CF-Access-Client-Secret`,
 *                        REQUIRED TOGETHER. They are listed in a single
 *                        requirement object, which in OpenAPI means AND -- one
 *                        without the other is not a credential, and documenting
 *                        them as alternatives would tell a CI integrator that
 *                        either would do.
 *   accessAssertion      `Cf-Access-Jwt-Assertion`, in its own requirement
 *                        object, which means OR.
 *
 * All three are `apiKey`/`header` rather than `http`/`bearer`, because that is
 * what they are: raw header values, not an `Authorization: Bearer` scheme. And
 * all three are consumed at the EDGE -- the two service-token headers never
 * reach this Worker at all; Access exchanges them for the assertion the Worker
 * actually verifies. Documenting them anyway is what makes the machine flow
 * discoverable to somebody reading the reference rather than the CLI source.
 */
export const DOCUMENT: GenerateSpecOptions["documentation"] = {
  openapi: "3.1.0",
  info: {
    title: "prick",
    version: "0.0.0-dev",
    description: [
      "A self-hosted secrets manager on Cloudflare Workers and D1.",
      "",
      "**Slug alias routes.** Every environment-scoped route is served at two paths:",
      "the canonical `/projects/{project}/environments/{env}/…` and the shorter",
      "`/p/{project}/e/{env}/…` for CLI ergonomics. Only the canonical form appears",
      "below; the alias is byte-identical in behaviour, matches **exactly** and never",
      "as a prefix.",
      "",
      "**There is no CORS.** This API emits no `Access-Control-Allow-Origin` and never",
      "will. Omitting it is what stops another site reading a response in a victim's",
      "browser. The admin UI is same-origin and needs nothing.",
      "",
      "**`404` is used for absent and invisible alike.** A resource you cannot see is",
      "reported exactly as one that does not exist. The alternative leaks which project",
      "names are in use to a caller with no grants at all.",
      "",
      "**Validation never echoes input.** A `422` body carries `issues` of",
      "`{path, message}`. The rejected value is dropped before the body is built, so a",
      "failed secret write cannot put a plaintext value in a response, a log line or an",
      "audit row.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1", description: "This deployment." }],
  tags: [
    { name: "meta", description: "Liveness and identity." },
    { name: "projects", description: "Projects." },
    { name: "environments", description: "Environments within a project." },
    { name: "secrets", description: "Secret metadata, values, history and bulk writes." },
    { name: "access", description: "Identities and grants." },
    {
      name: "groups",
      description:
        "Named sets of identities that can hold grants. Purely additive and flat: effective role is the max over an identity's own grants and its groups', there is no deny rule, and a group never contains another group.",
    },
    { name: "audit", description: "The append-only audit log." },
    { name: "admin", description: "Key ring status and rekeying." },
  ],
  components: {
    schemas: { ApiError: jsonSchema(ErrorResponse, "output") },
    securitySchemes: {
      accessAssertion: {
        type: "apiKey",
        in: "header",
        name: "Cf-Access-Jwt-Assertion",
        description:
          "The signed Access JWT. Set by Cloudflare Access at the edge; the Worker verifies it itself rather than trusting that Access ran. Browsers may instead present the `CF_Authorization` cookie, which Cloudflare documents as not guaranteed to be passed in every context — the header is primary.",
      },
      accessClientId: {
        type: "apiKey",
        in: "header",
        name: "CF-Access-Client-Id",
        description:
          "An Access **service token** id. Presented with `CF-Access-Client-Secret`; Access exchanges the pair at the edge, so this header never reaches the Worker.",
      },
      accessClientSecret: {
        type: "apiKey",
        in: "header",
        name: "CF-Access-Client-Secret",
        description:
          "The matching Access service token secret. Required together with `CF-Access-Client-Id`.",
      },
    },
  },
  security: [
    // AND: both headers, or neither.
    { accessClientId: [], accessClientSecret: [] },
    // OR: a browser or a logged-in CLI presenting the assertion directly.
    { accessAssertion: [] },
  ],
};

/**
 * Generator options.
 *
 * `exclude` drops the `/p/{project}/e/{env}/…` alias mounts. They are the SAME
 * handlers registered under a second path, so documenting them would double the
 * document to say the same thing twice, and a reader diffing two identical
 * operation trees learns nothing. The alias is described in `info.description`
 * instead, which is where a fact about the whole surface belongs.
 *
 * The docs viewer and the document itself are excluded for the same reason a
 * route table does not list itself.
 */
export const GENERATOR_OPTIONS: Partial<GenerateSpecOptions> = {
  documentation: DOCUMENT,
  exclude: [/^\/api\/v1\/p\//, "/api/v1/openapi.json", "/api/v1/docs"],
  // `excludeStaticFile` treats any final segment containing a period as a file
  // and drops it. Harmless for this surface -- no route has one -- but left at
  // its default rather than turned off, because turning it off is how
  // `/openapi.json` ends up documenting itself.
};

/**
 * The document, as a value.
 *
 * Exists so that `scripts/openapi.mjs` can write `docs/openapi.json` without
 * resolving `hono-openapi` itself. The script lives at the repository root,
 * whose `node_modules` holds only the toolchain; the dependency belongs to
 * `packages/app`, and reaching into another package's `node_modules` by path is
 * exactly the kind of thing that works until somebody changes a hoisting
 * setting.
 *
 * Re-exporting the generator through the module that already configures it also
 * means there is one place that knows which options produce the committed
 * document -- the endpoint and the file cannot be generated differently.
 */
export function generateDocument(app: Hono<ApiEnv>): Promise<unknown> {
  return generateSpecs(app, GENERATOR_OPTIONS);
}
