import type { CreateEnvironmentBody } from "@prick/shared";
import { and, count, eq } from "drizzle-orm";

import { can } from "../auth/authorize.js";
import { uuidv7 } from "../db/ids.js";
import { environments, secrets, type Environment } from "../db/schema.js";
import { auditStatement } from "./audit.js";
import type { CoreContext, Scope } from "./context.js";
import { notFound } from "./errors.js";
import { assertRole, assertVisible } from "./guards.js";
import { requireProject, slugConflict } from "./projects.js";
import { runBatch } from "./sql.js";

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

/**
 * The scope for an environment, carrying its project.
 *
 * ALWAYS built through this helper, never as an object literal at a call site.
 * Passing `projectId` is what lets `resolveEffectiveRole` honour a
 * project-scoped grant without a lookup; omitting it is not wrong, merely a
 * query per check, and "merely a query" repeated across a 200-key operation is
 * how the once-per-request promise quietly stops being true.
 */
export function environmentScope(environment: {
  id: string;
  projectId: string;
}): Extract<Scope, { type: "environment" }> {
  return { type: "environment", environmentId: environment.id, projectId: environment.projectId };
}

/**
 * Resolve `project/environment` by slug PAIR. Exact match on both.
 *
 * Never a prefix and never a LIKE. The environment is looked up scoped to the
 * project id rather than by slug alone, because environment slugs are unique
 * only WITHIN a project -- `environments_project_slug_uniq` is a composite
 * index. A global `WHERE slug = 'prod'` would find some other project's
 * production environment, authorize against the one the caller named, and
 * operate on the one it found.
 *
 * ---------------------------------------------------------------------------
 * WHY A SLUG CANNOT CONTAIN A COLON, and why the CLI still splits carefully.
 * ---------------------------------------------------------------------------
 *
 * The `Slug` grammar (`packages/shared/src/primitives.ts`) is lowercase
 * alphanumerics with single interior hyphens. Two characters are excluded on
 * purpose, and both exclusions are load-bearing HERE, at the point a pair is
 * resolved:
 *
 *   `:`  because the CLI addresses a scope as `project:environment`. With
 *        colons outside the grammar, that string has exactly one valid parse,
 *        for every project and environment name that can exist. The
 *        alternative -- permitting colons and escaping them -- means every
 *        producer and consumer of a scope string has to agree on an escaping
 *        scheme, and the first one that does not silently addresses a
 *        different environment.
 *
 *   `/`  because the alias routes are `/p/:slug/e/:slug`. A slug containing a
 *        slash would add path segments and change which route matched.
 *
 * So ambiguity is removed by the GRAMMAR rather than by parsing cleverness --
 * the same reason the crypto AAD next door is length-prefixed instead of
 * separator-delimited. A separator scheme is ambiguous the moment a field
 * contains the separator; the fix is to make that state unrepresentable.
 *
 * DEFENCE IN DEPTH, on the CLI side: `prick-core` splits a scope on the FIRST
 * colon only, never on all of them. Given the grammar this can never matter,
 * which is exactly why it is worth writing down -- it is the behaviour that
 * holds if the grammar is ever relaxed, or if a row reaches D1 by some route
 * that did not validate it (a hand-run `wrangler d1 execute`, a v0 import).
 * Splitting on every colon and taking element [1] loses everything after the
 * second one, so `acme:eu:prod` resolves to the environment `eu` -- a
 * DIFFERENT, possibly existing environment, addressed silently. First-colon
 * splitting instead yields `acme` / `eu:prod`, which either resolves to the
 * environment the user named or 404s. Wrong-and-loud, never wrong-and-quiet.
 *
 * (The grammar itself lives in `@prick/shared` and is not editable from here;
 * this comment is the record of the decision at the place that depends on it.)
 */
export async function findEnvironment(
  ctx: CoreContext,
  projectId: string,
  slug: string,
): Promise<Environment | null> {
  const rows = await ctx.db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.slug, slug)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The environment row for a slug pair, with the same absent/invisible collapse
 * `requireProject` performs.
 *
 * This is the entry point every secrets operation begins with, and the row it
 * returns carries `rev` -- which is why the write path does not need a separate
 * read for the optimistic-concurrency check. Resolving the environment is
 * unavoidable (the caller addresses it by slug) and the revision comes along for
 * free.
 */
export async function requireEnvironment(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
): Promise<Environment> {
  const project = await requireProject(ctx, projectSlug);

  const environment = await findEnvironment(ctx, project.id, envSlug);
  if (environment === null) throw notFound("environment");

  await assertVisible(ctx, environmentScope(environment), "environment");

  return environment;
}

export async function listEnvironments(
  ctx: CoreContext,
  projectSlug: string,
): Promise<EnvironmentSummary[]> {
  const project = await requireProject(ctx, projectSlug);

  const rows = await ctx.db
    .select({
      id: environments.id,
      projectId: environments.projectId,
      slug: environments.slug,
      name: environments.name,
      description: environments.description,
      rev: environments.rev,
      updatedAt: environments.updatedAt,
      secretCount: count(secrets.id),
    })
    .from(environments)
    .leftJoin(secrets, eq(secrets.environmentId, environments.id))
    .where(eq(environments.projectId, project.id))
    .groupBy(environments.id)
    .orderBy(environments.slug);

  // Visibility is re-checked per environment: a project-scoped grant covers all
  // of them, but an environment-scoped grant covers exactly one, and that actor
  // reached this function through a project made visible BY that grant. Listing
  // the project's other environments to them would be the leak the scope exists
  // to prevent.
  //
  // The loop issues no queries: `can()` reads the per-request authorization
  // snapshot, and every scope here carries its `projectId`, so nothing has to be
  // looked up. That is the entire reason `environmentScope()` exists.
  const visible: EnvironmentSummary[] = [];

  for (const row of rows) {
    if (await can(ctx, environmentScope(row), "reader")) visible.push(row);
  }

  return visible;
}

export async function getEnvironment(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
): Promise<EnvironmentSummary> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);

  const rows = await ctx.db
    .select({ value: count() })
    .from(secrets)
    .where(eq(secrets.environmentId, environment.id));

  return {
    id: environment.id,
    projectId: environment.projectId,
    slug: environment.slug,
    name: environment.name,
    description: environment.description,
    rev: environment.rev,
    secretCount: rows[0]?.value ?? 0,
    updatedAt: environment.updatedAt,
  };
}

export async function createEnvironment(
  ctx: CoreContext,
  projectSlug: string,
  input: CreateEnvironmentBody,
): Promise<EnvironmentSummary> {
  const project = await requireProject(ctx, projectSlug);
  await assertRole(ctx, { type: "project", projectId: project.id }, "writer");

  const id = uuidv7(ctx.now);

  const row = {
    id,
    projectId: project.id,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    rev: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.actor.subject,
  };

  try {
    await runBatch(ctx.db, [
      ctx.db.insert(environments).values(row),
      auditStatement(ctx, {
        action: "environment.create",
        outcome: "success",
        projectId: project.id,
        environmentId: id,
        detail: { kind: "resource", slug: input.slug },
      }),
    ]);
  } catch (error) {
    throw slugConflict(error, "environment", input.slug);
  }

  return {
    id,
    projectId: project.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    rev: 0,
    secretCount: 0,
    updatedAt: row.updatedAt,
  };
}

/**
 * Delete an environment. One statement; the cascade is the database's.
 *
 * NOTE: there is deliberately no `moveEnvironment` / reparent operation, and
 * adding one is not a small change. `environments.project_id` is contractually
 * immutable -- `project_id` is excluded from the crypto AAD precisely so that a
 * reparent would not require re-encrypting every value, and the price of that
 * choice is this missing operation. A reparent that skipped the re-encryption
 * would appear to work, because nothing in the AAD would have changed.
 */
export async function deleteEnvironment(
  ctx: CoreContext,
  projectSlug: string,
  envSlug: string,
): Promise<void> {
  const environment = await requireEnvironment(ctx, projectSlug, envSlug);
  await assertRole(ctx, environmentScope(environment), "admin");

  const secretRows = await ctx.db
    .select({ value: count() })
    .from(secrets)
    .where(eq(secrets.environmentId, environment.id));

  await runBatch(ctx.db, [
    ctx.db.delete(environments).where(eq(environments.id, environment.id)),
    auditStatement(ctx, {
      action: "environment.delete",
      outcome: "success",
      projectId: environment.projectId,
      environmentId: environment.id,
      detail: {
        kind: "resource",
        slug: environment.slug,
        cascade: { secrets: secretRows[0]?.value ?? 0 },
      },
    }),
  ]);
}
