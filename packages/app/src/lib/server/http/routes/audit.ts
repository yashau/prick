import { Hono } from "hono";

import { queryAudit } from "../../core/audit.js";
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
 * -- answers 404, exactly as a resource-addressed route would, and for the same
 * reason: absent and invisible must be indistinguishable. It is deliberately
 * NOT an empty page. An empty page is a wrong answer that looks like a right
 * one, and somebody auditing an incident who mistypes a slug would read "no
 * events" and stop looking.
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
        403: "`FORBIDDEN` — the caller holds no admin grant at any scope. Admins see the log narrowed to what they administer: global admins see everything, a project or environment admin sees only rows within their own scope.",
      },
    }),
    validate("query", AuditQueryParams),
    async (c) => {
      // A pure transport, like every other route here: `queryAudit` resolves
      // its own view and narrows the query to it. A global admin sees the whole
      // log; an admin of a project or environment sees only rows within it; an
      // actor with no admin grant anywhere is refused through the standard
      // denial path, so the attempt is audited and the subject shows up under
      // "Seen but not granted".
      return c.json(await queryAudit(core(c), c.req.valid("query")));
    },
  );

  return app;
}
