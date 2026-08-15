import { Hono } from "hono";

import { queryAudit } from "../../core/audit.js";
import { assertRole } from "../../core/guards.js";
import { core } from "../context.js";
import type { ApiEnv } from "../env.js";
import { describe, jsonResponse } from "../openapi.js";
import { AuditPageResponse, AuditQueryParams } from "../schemas.js";
import { validate } from "../validate.js";

/**
 * The audit log.
 *
 * Keyset-paginated on the UUIDv7 primary key (`WHERE id < :cursor ORDER BY id
 * DESC`) and never on OFFSET. The log is append-only and grows under the reader,
 * so every insert between two OFFSET pages shifts the window by one and makes
 * the reader silently skip a row -- a paginator that loses audit entries only
 * while something is actively happening is worse than one that fails outright.
 * This is also the whole reason ids are v7 rather than `crypto.randomUUID()`:
 * v4 ids have no temporal order, so `id < cursor` would select an arbitrary
 * subset.
 *
 * A filter naming a project that does not exist -- or that this actor cannot see
 * -- yields an EMPTY PAGE rather than a 404, which is the same existence-oracle
 * rule the rest of the API follows from the other direction.
 */
export function auditRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get(
    "/audit",
    describe({
      summary: "Query the audit log",
      description:
        "Newest first. Pass the returned `cursor` back to page; `null` means the end of the log.\n\n`detail` is a structured blob whose shape is a closed union in the domain layer, chosen so that **no member has a field that could hold a secret value**. Key names appear throughout and are plaintext metadata by design.\n\nA `detail` written by an older build that this one cannot parse comes back as `null` rather than failing the page. That is the one place in this system where swallowing is right: the log is historical and append-only, and refusing a whole page because one old row is odd would make it unreadable exactly when it is being consulted.",
      tags: ["audit"],
      operationId: "queryAudit",
      responses: { 200: jsonResponse("One page of the log.", AuditPageResponse) },
      errors: {
        403: "`FORBIDDEN` — this endpoint currently requires **global admin**. The domain layer performs no scope narrowing on the log yet, so the transport fails closed rather than serving a project admin the whole installation's events.",
      },
    }),
    validate("query", AuditQueryParams),
    async (c) => {
      const ctx = core(c);

      /*
       * THE ONE AUTHORIZATION CHECK IN THIS ENTIRE TREE, AND IT IS A STOPGAP.
       *
       * Every other route in `http/` is a pure transport because the `core`
       * function behind it performs its own check -- `requireProject`,
       * `requireEnvironment`, `assertAnyAdmin`, `assertRole`. `queryAudit` is
       * the single exception: it performs NONE. It reads the log, it resolves a
       * `?project=` filter through a bare slug lookup with no visibility check,
       * and it returns.
       *
       * Mounted unguarded, that endpoint hands every authenticated subject --
       * including a service token that has just been refused everything else and
       * exists only as a denial row -- the project ids, environment ids, secret
       * KEY NAMES and actor email addresses of the entire installation. It is
       * the broadest read in the API and it was the only one with no gate.
       *
       * So this line exists, and it is deliberately the MOST restrictive reading
       * rather than the most useful one: global admin, nothing less. Being too
       * restrictive is a bug an operator reports; being too permissive is a
       * disclosure nobody reports because nobody notices.
       *
       * IT IS IN THE WRONG PLACE AND IT SHOULD BE DELETED. The check belongs
       * inside `queryAudit`, alongside the per-scope narrowing this cannot
       * express: a project admin ought to see their own project's events, which
       * requires filtering the query by the visible set the way `listProjects`
       * does, not a yes/no gate at the door. When that lands in `core`, this
       * call goes with it.
       */
      await assertRole(ctx, { type: "global" }, "admin");

      return c.json(await queryAudit(ctx, c.req.valid("query")));
    },
  );

  return app;
}
