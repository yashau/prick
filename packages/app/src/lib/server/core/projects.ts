import type { CreateProjectBody, UpdateProjectBody } from "@prick/shared";
import { count, eq, inArray } from "drizzle-orm";

import { resolveAuthorization } from "../auth/authorize.js";
import { uuidv7 } from "../db/ids.js";
import { environments, projects, type Project } from "../db/schema.js";
import { auditStatement } from "./audit.js";
import type { CoreContext } from "./context.js";
import { PrickError, notFound } from "./errors.js";
import { assertRole, assertVisible } from "./guards.js";
import { runBatch } from "./sql.js";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  environmentCount: number;
  updatedAt: number;
}

/**
 * Which project ids this actor can see at all.
 *
 * `null` means "everything" -- a global grant, which is deliberately NOT
 * expanded into a list of ids. Expanding it would mean the visible-set query
 * grew with the number of projects and would eventually exceed the bound
 * parameter limit on an install that is working perfectly.
 *
 * The set is built from the authorization snapshot that has ALREADY been
 * resolved for this request, plus at most one query mapping environment-scoped
 * grants to their projects. An environment grant makes its project visible --
 * you cannot navigate to an environment whose project you cannot see -- but it
 * confers no role at the project scope, which is `resolveEffectiveRole`'s job
 * and is checked separately.
 */
async function visibleProjectIds(ctx: CoreContext): Promise<Set<string> | null> {
  const snapshot = await resolveAuthorization(ctx);

  if (snapshot.disabled) return new Set();
  if (snapshot.globalRole !== null || snapshot.bootstrap) return null;

  const visible = new Set(snapshot.byProject.keys());

  const environmentIds = [...snapshot.byEnvironment.keys()];
  if (environmentIds.length > 0) {
    const rows = await ctx.db
      .select({ projectId: environments.projectId })
      .from(environments)
      .where(inArray(environments.id, environmentIds));

    for (const row of rows) visible.add(row.projectId);
  }

  return visible;
}

/**
 * List projects visible to `ctx.actor`.
 *
 * SCOPED IN THE QUERY, not filtered afterwards. The difference is not
 * performance: a post-filter over "all projects" has, at the moment it runs,
 * already loaded rows the actor may not see, and every subsequent addition to
 * this function -- a count, a cursor, a "total" field -- is then computed over
 * the wrong set by default. A reader with one environment-scoped grant must see
 * exactly one project and must not be able to infer the existence of the others
 * from anything in the response.
 */
export async function listProjects(ctx: CoreContext): Promise<ProjectSummary[]> {
  const visible = await visibleProjectIds(ctx);

  if (visible !== null && visible.size === 0) return [];

  const rows = await ctx.db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      description: projects.description,
      updatedAt: projects.updatedAt,
      environmentCount: count(environments.id),
    })
    .from(projects)
    .leftJoin(environments, eq(environments.projectId, projects.id))
    .where(visible === null ? undefined : inArray(projects.id, [...visible]))
    .groupBy(projects.id)
    .orderBy(projects.slug);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    environmentCount: row.environmentCount,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Resolve a project by slug. EXACT match, never a prefix.
 *
 * The upstream defect this avoids was a 12-bit key-prefix lookup that could
 * resolve to a different record than the one asked for. The same class of
 * mistake here would authorize against one project and then operate on another
 * -- and both would look correct in every test that used distinct first
 * characters.
 *
 * Does NOT check visibility: it is the raw row, used by callers that go on to
 * check the scope themselves. Nothing outside `core` should call it.
 */
export async function findProjectBySlug(ctx: CoreContext, slug: string): Promise<Project | null> {
  const rows = await ctx.db.select().from(projects).where(eq(projects.slug, slug)).limit(1);

  return rows[0] ?? null;
}

/**
 * The project row, or a 404 that does not distinguish absent from invisible.
 *
 * Both branches end at the SAME `notFound("project")`, built by the same
 * zero-argument constructor, so the two responses are identical down to the
 * hint. Only the invisible branch records a denial -- there is nothing to be
 * denied about a project that does not exist, and recording one would fill
 * "Seen but not granted" with the noise of mistyped slugs.
 */
export async function requireProject(ctx: CoreContext, slug: string): Promise<Project> {
  const project = await findProjectBySlug(ctx, slug);

  if (project === null) throw notFound("project");

  await assertProjectVisible(ctx, project.id);

  return project;
}

/**
 * Project visibility is NOT `can(projectScope, 'reader')`, and the difference
 * matters.
 *
 * Grants inherit DOWNWARDS only: an environment-scoped reader holds no role at
 * the project scope, and `resolveEffectiveRole` correctly returns `null` there.
 * But they must still be able to open the project -- there is no way to reach an
 * environment except through it, and `listProjects` already shows it to them for
 * exactly that reason.
 *
 * Using the role check here would produce a project that appears in the list and
 * 404s when opened, which is the worst of both: it leaks the project's existence
 * (via the list) AND breaks the only workflow the grant was issued for.
 *
 * So visibility is the same set `listProjects` scopes to, and a role at the
 * project scope remains a separate question that `assertRole` answers.
 */
export async function assertProjectVisible(ctx: CoreContext, projectId: string): Promise<void> {
  const visible = await visibleProjectIds(ctx);

  if (visible === null || visible.has(projectId)) return;

  await assertVisible(ctx, { type: "project", projectId }, "project");

  /* istanbul ignore next -- assertVisible always throws for an invisible id */
  throw notFound("project");
}

export async function getProjectBySlug(ctx: CoreContext, slug: string): Promise<ProjectSummary> {
  const project = await requireProject(ctx, slug);

  const rows = await ctx.db
    .select({ value: count() })
    .from(environments)
    .where(eq(environments.projectId, project.id));

  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    environmentCount: rows[0]?.value ?? 0,
    updatedAt: project.updatedAt,
  };
}

/**
 * Create a project. Requires GLOBAL writer.
 *
 * Global, because a project has no parent to be scoped to -- there is nothing
 * narrower for the permission to mean. It is the one operation in the system
 * where "may create" and "may create anywhere" are the same sentence.
 */
export async function createProject(
  ctx: CoreContext,
  input: CreateProjectBody,
): Promise<ProjectSummary> {
  await assertRole(ctx, { type: "global" }, "writer");

  const id = uuidv7(ctx.now);

  const row = {
    id,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.actor.subject,
  };

  // The insert and its audit row, in ONE batch. Not because a single insert
  // needs a transaction, but because "every mutation carries its audit row in
  // the same batch" is a rule with no exceptions -- an exception here is what
  // makes the next one arguable.
  try {
    await runBatch(ctx.db, [
      ctx.db.insert(projects).values(row),
      auditStatement(ctx, {
        action: "project.create",
        outcome: "success",
        projectId: id,
        detail: { kind: "resource", slug: input.slug },
      }),
    ]);
  } catch (error) {
    throw slugConflict(error, "project", input.slug);
  }

  return {
    id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    environmentCount: 0,
    updatedAt: row.updatedAt,
  };
}

export async function updateProject(
  ctx: CoreContext,
  slug: string,
  input: UpdateProjectBody,
): Promise<ProjectSummary> {
  const project = await requireProject(ctx, slug);
  await assertRole(ctx, { type: "project", projectId: project.id }, "writer");

  const fields: string[] = [];
  const patch: { name?: string; description?: string | null; updatedAt: number } = {
    updatedAt: ctx.now,
  };

  if (input.name !== undefined) {
    patch.name = input.name;
    fields.push("name");
  }
  if (input.description !== undefined) {
    patch.description = input.description;
    fields.push("description");
  }

  await runBatch(ctx.db, [
    ctx.db.update(projects).set(patch).where(eq(projects.id, project.id)),
    auditStatement(ctx, {
      action: "project.update",
      outcome: "success",
      projectId: project.id,
      // The names of the fields that changed. Never their contents -- a project
      // description is not a secret, but "audit detail carries field names, not
      // field values" is a rule that stays true as things get added to it.
      detail: { kind: "resource", slug: project.slug, fields },
    }),
  ]);

  return getProjectBySlug(ctx, slug);
}

/**
 * Delete a project.
 *
 * ONE STATEMENT. D1 enforces foreign keys, so `ON DELETE CASCADE` removes the
 * environments, their secrets, their version history and every grant scoped to
 * them, in the same transaction, by itself.
 *
 * The alternative -- and what upstream did -- is four sequential DELETEs across
 * four round-trips, which is not atomic, and whose third failure leaves a
 * project whose environments are gone and whose grants still point at them.
 * There is no version of hand-rolled cascade that is better than the one the
 * database already implements correctly.
 */
export async function deleteProject(ctx: CoreContext, slug: string): Promise<void> {
  const project = await requireProject(ctx, slug);
  await assertRole(ctx, { type: "project", projectId: project.id }, "admin");

  // Counted BEFORE the delete, for the audit row. After it they are zero.
  const environmentRows = await ctx.db
    .select({ value: count() })
    .from(environments)
    .where(eq(environments.projectId, project.id));

  await runBatch(ctx.db, [
    ctx.db.delete(projects).where(eq(projects.id, project.id)),
    auditStatement(ctx, {
      action: "project.delete",
      outcome: "success",
      projectId: project.id,
      detail: {
        kind: "resource",
        slug: project.slug,
        cascade: { environments: environmentRows[0]?.value ?? 0 },
      },
    }),
  ]);
}

/**
 * Turn a unique-index violation into a 409 that names the slug.
 *
 * Naming the slug is safe and necessary here: the caller supplied it in this
 * request, so telling them it is taken reveals nothing they did not just assert,
 * and "slug already in use" is the only message that lets them fix it.
 */
export function slugConflict(error: unknown, kind: string, slug: string): unknown {
  const message = error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed/i.test(message)) {
    return new PrickError("CONFLICT", `A ${kind} with the slug "${slug}" already exists.`, {
      hint: "Slugs are unique. Choose another, or open the existing one.",
      cause: error,
    });
  }

  return error;
}
