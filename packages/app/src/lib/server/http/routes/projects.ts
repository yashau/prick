import { CreateProjectBody, UpdateProjectBody } from "@prick/shared";
import { Hono } from "hono";
import { z } from "zod";

import {
  createProject,
  deleteProject,
  getProjectBySlug,
  listProjects,
  updateProject,
} from "../../core/projects.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonBody, jsonResponse } from "../openapi.js";
import { ProjectParams, ProjectSummaryResponse } from "../schemas.js";
import { validate } from "../validate.js";

/**
 * Projects.
 *
 * Five thin transports. Every one of them is `core(c)` in, a `core/projects`
 * call, and `c.json` out -- there is no branch in this file that decides who may
 * do what, and there is deliberately nothing here that could grow one: a handler
 * never sees the actor, only the context that carries it.
 *
 * `listProjects` is the one worth knowing about: it scopes IN THE QUERY rather
 * than filtering afterwards, so a reader holding a single environment-scoped
 * grant receives exactly one project and cannot infer the existence of the
 * others from a count, a total, or a page boundary that skips.
 */
export function projectRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/",
    describe({
      summary: "List projects",
      description:
        "The projects visible to the caller. Scoping happens in the query, so the response cannot reveal the existence of a project the caller has no grant for. An environment-scoped grant makes its project visible, because there is no way to reach an environment except through one — but it confers no role AT the project scope.",
      tags: ["projects"],
      operationId: "listProjects",
      responses: {
        200: jsonResponse(
          "The visible projects, ordered by slug.",
          z.array(ProjectSummaryResponse),
        ),
      },
    }),
    async (c) => c.json(await listProjects(core(c))),
  );

  app.post(
    "/",
    describe({
      summary: "Create a project",
      description:
        "Requires **global** writer. Global because a project has no parent to be scoped to — there is nothing narrower the permission could mean. The insert and its audit row are one `batch()`.",
      tags: ["projects"],
      operationId: "createProject",
      requestBody: jsonBody("The project to create.", CreateProjectBody),
      responses: { 201: jsonResponse("The created project.", ProjectSummaryResponse) },
      errors: { 409: "`CONFLICT` — the slug is already in use." },
    }),
    validate("json", CreateProjectBody),
    async (c) => c.json(await createProject(core(c), c.req.valid("json")), 201),
  );

  app.get(
    "/:project",
    describe({
      summary: "Get a project",
      description:
        "A project that does not exist and one the caller cannot see produce the identical `404`, down to the hint.",
      tags: ["projects"],
      operationId: "getProject",
      responses: { 200: jsonResponse("The project.", ProjectSummaryResponse) },
    }),
    validate("param", ProjectParams),
    async (c) => c.json(await getProjectBySlug(core(c), c.req.valid("param").project)),
  );

  app.patch(
    "/:project",
    describe({
      summary: "Update a project",
      description:
        "Requires writer at the project scope. The audit row records which FIELDS changed, by name, and never their contents.",
      tags: ["projects"],
      operationId: "updateProject",
      requestBody: jsonBody(
        "The fields to change. An omitted field is left alone; `description: null` clears it.",
        UpdateProjectBody,
      ),
      responses: { 200: jsonResponse("The updated project.", ProjectSummaryResponse) },
    }),
    validate("param", ProjectParams),
    validate("json", UpdateProjectBody),
    async (c) =>
      c.json(await updateProject(core(c), c.req.valid("param").project, c.req.valid("json"))),
  );

  app.delete(
    "/:project",
    describe({
      summary: "Delete a project",
      description:
        "Requires **admin** at the project scope. One statement: D1 enforces foreign keys, so `ON DELETE CASCADE` removes the environments, their secrets, the whole version history and every grant scoped to them inside the same transaction. The audit row records how many rows the cascade took.",
      tags: ["projects"],
      operationId: "deleteProject",
      responses: { 204: { description: "Deleted." } },
    }),
    validate("param", ProjectParams),
    async (c) => {
      await deleteProject(core(c), c.req.valid("param").project);
      return c.body(null, 204);
    },
  );

  return app;
}
