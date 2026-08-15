import { defineConfig } from "drizzle-kit";

/**
 * Migrations are EXPAND/CONTRACT ONLY.
 *
 * Release N adds a nullable column and backfills it, N+1 makes it NOT NULL,
 * N+2 drops the old one. Code and destructive DDL never ship together, because
 * `wrangler d1 migrations apply` and `wrangler deploy` are two separate steps
 * with a window between them during which both the old and the new code are
 * live.
 *
 * GOTCHA, and it will bite on the first column change: drizzle-kit emits
 * `PRAGMA foreign_keys=OFF` around table rebuilds, and D1 REJECTS a pragma
 * change mid-transaction. Every generated migration must be read before it is
 * committed, and any such line rewritten to `defer_foreign_keys`.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/server/db/schema.ts",
  out: "./drizzle/migrations",
  strict: true,
  verbose: true,
});
