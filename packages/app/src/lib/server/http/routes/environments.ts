import { CreateEnvironmentBody } from "@prick/shared";
import { Hono } from "hono";
import { z } from "zod";

import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
} from "../../core/environments.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import { EnvironmentParams, EnvironmentSummaryResponse, ProjectParams } from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Environment collection routes: list and create, under a project.
 *
 * The per-environment routes are NOT here -- they live in `secrets.ts`, in the
 * sub-application that is mounted at both `/projects/:project/environments/:env`
 * and the `/p/:project/e/:env` alias, because "get this environment" and "list
 * its secrets" have to be reachable at both spellings and there is no reason to
 * register them twice by hand.
 */
export function environmentCollectionRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/",
    describe({
      summary: "List a project's environments",
      description:
        "Visibility is re-checked per environment. A project-scoped grant covers all of them; an environment-scoped grant covers exactly one — and that caller reached this endpoint through a project made visible BY that grant, so listing the siblings would be the leak the scope exists to prevent. The loop issues no additional queries.",
      tags: ["environments"],
      operationId: "listEnvironments",
      responses: {
        200: jsonResponse(
          "The visible environments, ordered by slug.",
          z.array(EnvironmentSummaryResponse),
        ),
      },
    }),
    validate("param", ProjectParams),
    async (c) => c.json(await listEnvironments(core(c), c.req.valid("param").project)),
  );

  app.post(
    "/",
    describe({
      summary: "Create an environment",
      description: "Requires writer at the project scope.",
      tags: ["environments"],
      operationId: "createEnvironment",
      requestBody: jsonBody("The environment to create.", CreateEnvironmentBody),
      responses: { 201: jsonResponse("The created environment.", EnvironmentSummaryResponse) },
      errors: { 409: "`CONFLICT` — the slug is already in use within this project." },
    }),
    validate("param", ProjectParams),
    validate("json", CreateEnvironmentBody),
    async (c) =>
      c.json(
        await createEnvironment(core(c), c.req.valid("param").project, c.req.valid("json")),
        201,
      ),
  );

  return app;
}

/**
 * The two routes that address ONE environment.
 *
 * Registered on the shared environment router so they are served at both the
 * canonical path and the slug alias. Note what is missing and why: there is no
 * reparent operation and adding one is not a small change. `environments.
 * project_id` is contractually immutable because `project_id` is excluded from
 * the crypto AAD -- which is what makes a reparent cheap in the database and
 * catastrophic in practice, since nothing in the AAD would change and every row
 * would keep decrypting while belonging to the wrong project.
 */
export function registerEnvironmentRoutes(app: Hono<ApiEnv>): void {
  app.get(
    "/",
    describe({
      summary: "Get an environment",
      description:
        "Carries `rev`, the optimistic-concurrency token. It is the same number the secret collection returns as its `ETag`.",
      tags: ["environments"],
      operationId: "getEnvironment",
      responses: { 200: jsonResponse("The environment.", EnvironmentSummaryResponse) },
    }),
    validate("param", EnvironmentParams),
    async (c) => {
      const { project, env } = c.req.valid("param");
      return c.json(await getEnvironment(core(c), project, env));
    },
  );

  app.delete(
    "/",
    describe({
      summary: "Delete an environment",
      description:
        "Requires **admin** at the environment scope. One statement; the cascade is the database's. The audit row records how many secrets went with it.",
      tags: ["environments"],
      operationId: "deleteEnvironment",
      responses: { 204: { description: "Deleted." } },
    }),
    validate("param", EnvironmentParams),
    async (c) => {
      const { project, env } = c.req.valid("param");
      await deleteEnvironment(core(c), project, env);
      return c.body(null, 204);
    },
  );
}
