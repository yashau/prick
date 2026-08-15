import type { CreateEnvironmentBody } from "@prick/shared";

import type { CoreContext } from "./context.js";
import { notImplemented } from "./errors.js";

export interface EnvironmentSummary {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Optimistic-concurrency token. Round-tripped as `expected_rev`. */
  rev: number;
  secretCount: number;
  updatedAt: number;
}

export function listEnvironments(
  _ctx: CoreContext,
  _projectSlug: string,
): Promise<EnvironmentSummary[]> {
  return notImplemented("listEnvironments");
}

/**
 * TODO(build order step 13): resolve `project/environment` by slug pair.
 *
 * EXACT match on both, never a prefix. The upstream bug this avoids was a
 * 12-bit key prefix lookup that could resolve to the wrong record entirely;
 * the same class of mistake here would authorize against one environment and
 * read from another.
 */
export function getEnvironment(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
): Promise<EnvironmentSummary> {
  return notImplemented("getEnvironment");
}

export function createEnvironment(
  _ctx: CoreContext,
  _projectSlug: string,
  _input: CreateEnvironmentBody,
): Promise<EnvironmentSummary> {
  return notImplemented("createEnvironment");
}

/**
 * TODO(build order step 13): delete an environment (cascades to secrets,
 * versions and environment-scoped grants).
 *
 * NOTE: there is deliberately no `moveEnvironment` / reparent operation, and
 * adding one is not a small change. `environments.project_id` is contractually
 * immutable; see the AAD design -- `project_id` is excluded from the additional
 * data precisely so that a reparent would not require re-encrypting every value,
 * and the price of that choice is this missing operation.
 */
export function deleteEnvironment(
  _ctx: CoreContext,
  _projectSlug: string,
  _envSlug: string,
): Promise<void> {
  return notImplemented("deleteEnvironment");
}
