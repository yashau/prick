import type { Role, ScopeType } from "@prick/shared";
import { eq, inArray } from "drizzle-orm";

import { resolveAuthorization } from "../auth/authorize.js";
import { isBootstrapAdmin } from "../auth/bootstrap.js";
import {
  environments,
  grants,
  groupGrants,
  groupMembers,
  groups,
  identities,
  projects,
} from "../db/schema.js";
import { ROLE_RANK, type CoreContext } from "./context.js";
import { notFound } from "./errors.js";
import { assertAnyAdmin, type IdentityRecord } from "./identities.js";

/**
 * The effective-permissions view, split out of `core/identities.ts`.
 *
 * Its own module rather than a section of that one for a mechanical reason with
 * a real justification behind it: `check-loc` caps a source file at 1000 lines,
 * `identities.ts` reached 995 with this appended, and a file five lines from a
 * build failure is a file whose next comment is deleted rather than written. The
 * cap exists because a file nobody reads end to end is where a subtle change
 * hides -- and an authorization explanation is exactly the code where that
 * matters.
 *
 * It is also a genuine seam. Everything in `identities.ts` answers "what is the
 * state of the access graph"; everything here answers "why", which is a
 * different question with a different query shape and a different reader.
 */

/**
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS, AND WHY THE OBVIOUS ANSWER IS USELESS
 * ---------------------------------------------------------------------------
 * An admin looking at an access review does not ask "what is Bob's role". They
 * ask "why does Bob have production, and what do I remove to stop that". An
 * endpoint that replies `"admin"` has answered the first question and left the
 * second one exactly as hard as it was -- and with groups in the model it is
 * genuinely hard, because the answer can be a grant on an environment, a grant
 * on its project, a global grant, any of those held by a group Bob is in, or the
 * `BOOTSTRAP_ADMINS` var, and none of those are visible from Bob's row.
 *
 * So every entry carries its SOURCES: the actual rows that confer it, each
 * naming the group it came through when it came through one, and one of them
 * marked `decisive`. "Remove this" is then a thing the response says rather than
 * a thing the reader derives.
 *
 * WHICH SCOPES ARE LISTED. Exactly those some grant NAMES -- never the full
 * cross product of projects and environments. A global admin's answer is one
 * row saying "global admin", not one row per project in the installation; the
 * inheritance rule is stated once in the source's own scope rather than
 * re-materialised into hundreds of rows the reader then has to deduplicate.
 *
 * SOURCES INCLUDE COVERING GRANTS. An entry for environment `acme/prod` lists
 * the global and project-scoped grants that reach it as well as the ones on the
 * environment itself, because "the platform group has admin on the project" IS
 * the answer to why Bob has the environment. Listing only exact-scope matches
 * would produce an entry with a role and no explanation -- the useless answer
 * this endpoint exists to avoid.
 *
 * A DISABLED IDENTITY reports `role: null` on every entry, with the sources
 * still listed and nothing marked decisive. That is the honest shape: the kill
 * switch outranks every grant, so Bob has nothing -- and an operator deciding
 * whether it is safe to re-enable him needs to see what he would get back.
 */
export interface GroupRef {
  id: string;
  slug: string;
  name: string;
}

export interface PermissionSource {
  /**
   * `direct` -- a `grants` row. `group` -- a `group_grants` row reached through
   * membership. `bootstrap` -- the `BOOTSTRAP_ADMINS` var, which confers global
   * admin with no row behind it at all and is therefore the one source an
   * operator cannot find by searching the database.
   */
  via: "direct" | "group" | "bootstrap";
  /** `grants.id` or `group_grants.id`; `null` for `via: "bootstrap"`. */
  grantId: string | null;
  role: Role;
  /** Where the GRANT sits, which may be broader than the scope it explains. */
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  /** The group this came through, or `null` for a direct or bootstrap source. */
  group: GroupRef | null;
  expiresAt: number | null;
  /** The source that set the effective role. Exactly one per entry, unless disabled. */
  decisive: boolean;
}

export interface EffectiveScopeEntry {
  scopeType: ScopeType;
  projectSlug: string | null;
  environmentSlug: string | null;
  /** The effective role here. `null` only for a disabled identity. */
  role: Role | null;
  /** Every live grant that reaches this scope, strongest first. Never empty. */
  sources: PermissionSource[];
}

export interface EffectivePermissions {
  identity: IdentityRecord;
  /** The groups this identity is in, whether or not they confer anything. */
  groups: GroupRef[];
  /** True when this subject is named in `BOOTSTRAP_ADMINS`. */
  bootstrap: boolean;
  /** One entry per scope any grant names. Empty means: no access anywhere. */
  scopes: EffectiveScopeEntry[];
}

/** A grant flattened out of either table, before it is attributed to a scope. */
interface SourceRow {
  via: "direct" | "group" | "bootstrap";
  grantId: string | null;
  role: Role;
  scopeType: ScopeType;
  projectId: string | null;
  environmentId: string | null;
  group: GroupRef | null;
  expiresAt: number | null;
}

function isLive(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || expiresAt > now;
}

/*
 * `role` and `scope_type` are TEXT columns, so they arrive as `string` and have
 * to be narrowed somewhere. Narrowing to the safest member rather than throwing
 * is deliberate: a row carrying a role this build does not recognise must render
 * as the WEAKEST thing it could be, never as the strongest, and never as a 500
 * on the screen an operator opened to find out what is wrong.
 */
function asRole(value: string): Role {
  return value === "admin" || value === "writer" ? value : "reader";
}

function asScopeType(value: string): ScopeType {
  return value === "global" || value === "environment" ? value : "project";
}

/**
 * Everything that confers a role on one identity, with provenance.
 *
 * FIVE QUERIES, deliberately, and deliberately NOT the one-statement union that
 * `loadSnapshot` uses. That function runs on every request and its shape is
 * dictated by that; this one runs when a human opens one screen, and needs
 * slugs, group names and grant ids that the hot path has no use for. Making the
 * hot query carry them so this one could reuse it would put the cost on every
 * request in the system to save four round-trips on a page view.
 */
export async function explainIdentityPermissions(
  ctx: CoreContext,
  identityId: string,
): Promise<EffectivePermissions> {
  await assertAnyAdmin(ctx);

  const identityRows = await ctx.db
    .select()
    .from(identities)
    .where(eq(identities.id, identityId))
    .limit(1);

  const identity = identityRows[0];
  if (identity === undefined) throw notFound("identity");

  const directRows = await ctx.db.select().from(grants).where(eq(grants.identityId, identityId));

  const groupRows = await ctx.db
    .select({
      id: groupGrants.id,
      role: groupGrants.role,
      scopeType: groupGrants.scopeType,
      projectId: groupGrants.projectId,
      environmentId: groupGrants.environmentId,
      expiresAt: groupGrants.expiresAt,
      groupId: groups.id,
      groupSlug: groups.slug,
      groupName: groups.name,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupGrants, eq(groupGrants.groupId, groupMembers.groupId))
    .where(eq(groupMembers.identityId, identityId));

  /*
   * The memberships themselves, INCLUDING groups that hold no grants.
   *
   * Written here rather than imported from `core/groups.ts`, which would make
   * the two modules mutually recursive -- `groups.ts` already imports the admin
   * guard and the scope resolver from this one. Six lines of query is a cheaper
   * price than a cycle that works today because both uses happen to be inside
   * function bodies.
   *
   * A group with no grants belongs in this list precisely because it confers
   * nothing: "Bob is in `contractors`, and `contractors` has no grants" is the
   * answer to a question an access review does ask.
   */
  const memberships = await ctx.db
    .select({ id: groups.id, slug: groups.slug, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.identityId, identityId))
    .orderBy(groups.slug);

  const sources: SourceRow[] = [];

  for (const row of directRows) {
    if (!isLive(row.expiresAt, ctx.now)) continue;
    sources.push({
      via: "direct",
      grantId: row.id,
      role: asRole(row.role),
      scopeType: asScopeType(row.scopeType),
      projectId: row.projectId,
      environmentId: row.environmentId,
      group: null,
      expiresAt: row.expiresAt,
    });
  }

  for (const row of groupRows) {
    if (!isLive(row.expiresAt, ctx.now)) continue;
    sources.push({
      via: "group",
      grantId: row.id,
      role: asRole(row.role),
      scopeType: asScopeType(row.scopeType),
      projectId: row.projectId,
      environmentId: row.environmentId,
      group: { id: row.groupId, slug: row.groupSlug, name: row.groupName },
      expiresAt: row.expiresAt,
    });
  }

  // The var, which has no row anywhere and is therefore the source an operator
  // will never find by looking in the database.
  if (isBootstrapAdmin(ctx.config, identity.subject)) {
    sources.push({
      via: "bootstrap",
      grantId: null,
      role: "admin",
      scopeType: "global",
      projectId: null,
      environmentId: null,
      group: null,
      expiresAt: null,
    });
  }

  const names = await resolveScopeNames(ctx, sources);

  return {
    identity: {
      id: identity.id,
      kind: identity.kind === "service" ? "service" : "user",
      subject: identity.subject,
      displayName: identity.displayName,
      disabled: identity.disabled,
      lastSeenAt: identity.lastSeenAt,
    },
    groups: memberships,
    bootstrap: isBootstrapAdmin(ctx.config, identity.subject),
    scopes: await narrowToAdministered(ctx, buildEntries(sources, names, identity.disabled)),
  };
}

interface ScopeNames {
  projectSlugs: Map<string, string>;
  /** environment id -> its slug and its project. */
  environments: Map<string, { slug: string; projectId: string; projectSlug: string | null }>;
}

/**
 * Slugs for every project and environment the sources name.
 *
 * The environment's project is read from the ENVIRONMENT ROW rather than from
 * `grants.project_id`, which is also populated for environment-scoped grants.
 * The two can disagree -- a grant seeded directly, or written before the column
 * was maintained, may carry NULL -- and the environment row is the one that
 * cannot be wrong about which project it is in.
 */
async function resolveScopeNames(
  ctx: CoreContext,
  sources: readonly SourceRow[],
): Promise<ScopeNames> {
  const environmentIds = [
    ...new Set(sources.map((s) => s.environmentId).filter((id): id is string => id !== null)),
  ];

  const environmentRows =
    environmentIds.length === 0
      ? []
      : await ctx.db
          .select({
            id: environments.id,
            slug: environments.slug,
            projectId: environments.projectId,
          })
          .from(environments)
          .where(inArray(environments.id, environmentIds));

  const projectIds = [
    ...new Set([
      ...sources
        .filter((s) => s.scopeType === "project")
        .map((s) => s.projectId)
        .filter((id): id is string => id !== null),
      ...environmentRows.map((row) => row.projectId),
    ]),
  ];

  const projectRows =
    projectIds.length === 0
      ? []
      : await ctx.db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, projectIds));

  const projectSlugs = new Map(projectRows.map((row) => [row.id, row.slug]));

  return {
    projectSlugs,
    environments: new Map(
      environmentRows.map((row) => [
        row.id,
        {
          slug: row.slug,
          projectId: row.projectId,
          projectSlug: projectSlugs.get(row.projectId) ?? null,
        },
      ]),
    ),
  };
}

/** A stable key for a scope, so two sources at the same scope group together. */
function scopeKey(source: SourceRow, names: ScopeNames): string {
  if (source.scopeType === "global") return "global";
  if (source.scopeType === "project") return `project:${source.projectId ?? ""}`;

  const environment = names.environments.get(source.environmentId ?? "");
  return `environment:${source.environmentId ?? ""}:${environment?.projectId ?? ""}`;
}

/**
 * Does `source` reach `scope`?
 *
 * DOWNWARDS ONLY, the same rule `resolveEffectiveRole` applies: global reaches
 * everything, a project grant reaches its own environments, an environment grant
 * reaches only itself. Written out here rather than shared with the resolver,
 * because the resolver answers "what is the role" from an already-merged map and
 * this answers "which row did it come from" -- the same rule over different
 * inputs, and merging them would mean the explain view could no longer be wrong
 * in a way the tests catch.
 */
function covers(
  source: SourceRow,
  target: { scopeType: ScopeType; projectId: string | null; environmentId: string | null },
): boolean {
  if (source.scopeType === "global") return true;

  if (source.scopeType === "project") {
    return source.projectId !== null && source.projectId === target.projectId;
  }

  return source.environmentId !== null && source.environmentId === target.environmentId;
}

function buildEntries(
  sources: readonly SourceRow[],
  names: ScopeNames,
  disabled: boolean,
): EffectiveScopeEntry[] {
  const targets = new Map<
    string,
    { scopeType: ScopeType; projectId: string | null; environmentId: string | null }
  >();

  for (const source of sources) {
    const environment =
      source.environmentId === null ? undefined : names.environments.get(source.environmentId);

    targets.set(scopeKey(source, names), {
      scopeType: source.scopeType,
      projectId:
        source.scopeType === "environment" ? (environment?.projectId ?? null) : source.projectId,
      environmentId: source.environmentId,
    });
  }

  const entries: EffectiveScopeEntry[] = [];

  for (const target of targets.values()) {
    const reaching = sources
      .filter((source) => covers(source, target))
      .sort((left, right) => ROLE_RANK[right.role] - ROLE_RANK[left.role]);

    /* istanbul ignore next -- a target exists only because a source produced it */
    if (reaching.length === 0) continue;

    const strongest = reaching[0] as SourceRow;
    const environment =
      target.environmentId === null ? undefined : names.environments.get(target.environmentId);

    entries.push({
      scopeType: target.scopeType,
      projectSlug:
        target.scopeType === "global"
          ? null
          : target.scopeType === "environment"
            ? (environment?.projectSlug ?? null)
            : (names.projectSlugs.get(target.projectId ?? "") ?? null),
      environmentSlug: target.scopeType === "environment" ? (environment?.slug ?? null) : null,
      // The kill switch outranks every grant, so a disabled identity's effective
      // role is null everywhere -- and no source is decisive, because none of
      // them are deciding anything.
      role: disabled ? null : strongest.role,
      sources: reaching.map((source) => ({
        via: source.via,
        grantId: source.grantId,
        role: source.role,
        scopeType: source.scopeType,
        projectSlug:
          source.scopeType === "global"
            ? null
            : source.scopeType === "environment"
              ? (names.environments.get(source.environmentId ?? "")?.projectSlug ?? null)
              : (names.projectSlugs.get(source.projectId ?? "") ?? null),
        environmentSlug:
          source.scopeType === "environment"
            ? (names.environments.get(source.environmentId ?? "")?.slug ?? null)
            : null,
        group: source.group,
        expiresAt: source.expiresAt,
        decisive: !disabled && source === strongest,
      })),
    });
  }

  return entries.sort((left, right) => SCOPE_ORDER[left.scopeType] - SCOPE_ORDER[right.scopeType]);
}

/** Broadest first, which is the order somebody reads an explanation in. */
const SCOPE_ORDER: Record<ScopeType, number> = { global: 0, project: 1, environment: 2 };

/**
 * Narrow the answer to what the CALLER administers.
 *
 * The same rule `listGrants` applies: a scoped admin sees the entries that touch
 * what they administer, not the whole organisation's access graph. A global
 * entry is global-admin-only, because "Bob is a global admin" is a fact about
 * every project at once.
 *
 * SOURCES INSIDE A VISIBLE ENTRY ARE NOT NARROWED, and that is deliberate. A
 * project admin who can see that Bob has admin on their project must be able to
 * see that it comes from a global grant on the `platform` group -- that is the
 * answer to their question, and the action it implies (ask somebody with global
 * authority) is one they can only take if they are told. Hiding it would leave
 * an entry with a role and no explanation.
 */
async function narrowToAdministered(
  ctx: CoreContext,
  entries: EffectiveScopeEntry[],
): Promise<EffectiveScopeEntry[]> {
  const snapshot = await resolveAuthorization(ctx);

  if (snapshot.bootstrap || snapshot.globalRole === "admin") return entries;

  const administeredProjects = new Set<string>();
  const administeredEnvironments = new Set<string>();

  for (const [id, role] of snapshot.byProject) if (role === "admin") administeredProjects.add(id);
  for (const [id, role] of snapshot.byEnvironment) {
    if (role === "admin") administeredEnvironments.add(id);
  }

  if (administeredProjects.size === 0 && administeredEnvironments.size === 0) return [];

  // Slugs, because that is what the entries carry -- the ids come from the
  // snapshot and the two have to be compared in one vocabulary.
  const projectRows =
    administeredProjects.size === 0
      ? []
      : await ctx.db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, [...administeredProjects]));

  const environmentRows =
    administeredEnvironments.size === 0
      ? []
      : await ctx.db
          .select({ slug: environments.slug, projectId: environments.projectId })
          .from(environments)
          .where(inArray(environments.id, [...administeredEnvironments]));

  const projectSlugs = new Set(projectRows.map((row) => row.slug));

  const environmentProjectRows =
    environmentRows.length === 0
      ? []
      : await ctx.db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, [...new Set(environmentRows.map((r) => r.projectId))]));

  const environmentProjectSlugs = new Map(environmentProjectRows.map((r) => [r.id, r.slug]));

  const environmentPairs = new Set(
    environmentRows.map((row) => `${environmentProjectSlugs.get(row.projectId) ?? ""}/${row.slug}`),
  );

  return entries.filter((entry) => {
    if (entry.scopeType === "global") return false;

    if (entry.scopeType === "project") {
      return entry.projectSlug !== null && projectSlugs.has(entry.projectSlug);
    }

    // An environment entry is visible to the admin of its project as well as to
    // its own admin -- grants inherit downwards, and so does oversight.
    return (
      (entry.projectSlug !== null && projectSlugs.has(entry.projectSlug)) ||
      environmentPairs.has(`${entry.projectSlug ?? ""}/${entry.environmentSlug ?? ""}`)
    );
  });
}
