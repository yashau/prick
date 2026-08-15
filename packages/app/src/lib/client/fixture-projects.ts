/**
 * The project and environment half of `PrickApi`, against the fixture store.
 *
 * Part of the seam described in `./fixtures.ts`, and deleted with it.
 */

import type { PrickApi } from "./api.js";
import {
  auditLog,
  auditRow,
  delay,
  environment,
  fail,
  findEnvironment,
  findProject,
  fixtureId,
  projects,
  summarise,
  type FixtureProject,
} from "./fixture-store.js";

type ProjectApi = Pick<
  PrickApi,
  | "listProjects"
  | "getProject"
  | "createProject"
  | "updateProject"
  | "deleteProject"
  | "listEnvironments"
  | "getEnvironment"
  | "createEnvironment"
  | "deleteEnvironment"
>;

export const fixtureProjectApi: ProjectApi = {
  listProjects: () => delay(projects.map(summarise)),

  getProject: (project) => delay(summarise(findProject(project))),

  createProject: (input) => {
    if (projects.some((project) => project.slug === input.slug)) {
      fail("CONFLICT", `A project with the slug "${input.slug}" already exists.`, 409);
    }
    const created: FixtureProject = {
      id: fixtureId(),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      updatedAt: Date.now(),
      environments: [],
    };
    projects.push(created);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.create",
        projectSlug: input.slug,
        detail: { kind: "resource", slug: input.slug },
      }),
    );
    return delay(summarise(created));
  },

  updateProject: (project, input) => {
    const found = findProject(project);
    if (input.name !== undefined) found.name = input.name;
    if (input.description !== undefined) found.description = input.description;
    found.updatedAt = Date.now();
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.update",
        projectSlug: project,
        detail: { kind: "resource", slug: project, fields: Object.keys(input) },
      }),
    );
    return delay(summarise(found));
  },

  deleteProject: (project) => {
    const index = projects.findIndex((entry) => entry.slug === project);
    if (index === -1) fail("NOT_FOUND", "No such project.", 404);
    const removed = projects.splice(index, 1)[0];
    if (!removed) fail("NOT_FOUND", "No such project.", 404);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "project.delete",
        projectSlug: project,
        detail: {
          kind: "resource",
          slug: project,
          cascade: { environments: removed.environments.length },
        },
      }),
    );
    return delay(undefined);
  },

  listEnvironments: (project) =>
    delay(
      findProject(project).environments.map(({ secrets: _secrets, ...rest }) => ({
        ...rest,
        secretCount: _secrets.length,
      })),
    ),

  getEnvironment: (project, environment_) => {
    const { secrets: _secrets, ...rest } = findEnvironment(project, environment_);
    return delay({ ...rest, secretCount: _secrets.length });
  },

  createEnvironment: (project, input) => {
    const found = findProject(project);
    if (found.environments.some((entry) => entry.slug === input.slug)) {
      fail("CONFLICT", `"${input.slug}" already exists in this project.`, 409);
    }
    const created = environment({
      id: fixtureId(),
      projectId: found.id,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      rev: 0,
      ageDays: 0,
      secrets: [],
    });
    created.updatedAt = Date.now();
    found.environments.push(created);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "environment.create",
        projectSlug: project,
        environmentSlug: input.slug,
        detail: { kind: "resource", slug: input.slug },
      }),
    );
    const { secrets: _secrets, ...rest } = created;
    return delay({ ...rest, secretCount: 0 });
  },

  deleteEnvironment: (project, environment_) => {
    const found = findProject(project);
    const index = found.environments.findIndex((entry) => entry.slug === environment_);
    if (index === -1) fail("NOT_FOUND", "No such environment.", 404);
    found.environments.splice(index, 1);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "environment.delete",
        projectSlug: project,
        environmentSlug: environment_,
        detail: { kind: "resource", slug: environment_ },
      }),
    );
    return delay(undefined);
  },
};
