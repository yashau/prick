import type { CreateProjectBody, UpdateProjectBody } from "@prick/shared";

import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  environmentCount: number;
  updatedAt: number;
}

/**
 * TODO(build order step 13): list projects visible to `ctx.actor`.
 *
 * Visibility is not a post-filter over "all projects": resolve the actor's
 * grants once, then scope the query. A reader with one environment-scoped grant
 * must see exactly one project, and must not be able to infer the existence of
 * the others from a count or a pagination cursor.
 */
export function listProjects(_ctx: CoreContext): Promise<ProjectSummary[]> {
  return notImplemented("listProjects");
}

/** TODO(build order step 13): resolve a project by slug -- EXACT match, never a prefix. */
export function getProjectBySlug(_ctx: CoreContext, _slug: string): Promise<ProjectSummary> {
  return notImplemented("getProjectBySlug");
}

/** TODO(build order step 13): create a project. Requires global `writer`. Audited. */
export function createProject(
  _ctx: CoreContext,
  _input: CreateProjectBody,
): Promise<ProjectSummary> {
  return notImplemented("createProject");
}

export function updateProject(
  _ctx: CoreContext,
  _slug: string,
  _input: UpdateProjectBody,
): Promise<ProjectSummary> {
  return notImplemented("updateProject");
}

/**
 * TODO(build order step 13): delete a project.
 *
 * ONE statement. D1 enforces foreign keys, so `ON DELETE CASCADE` removes the
 * environments, secrets, versions and grants by itself. Do not hand-roll the
 * cascade -- that is four sequential non-atomic statements and a half-deleted
 * project when the third one fails.
 */
export function deleteProject(_ctx: CoreContext, _slug: string): Promise<void> {
  return notImplemented("deleteProject");
}
