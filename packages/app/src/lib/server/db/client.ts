import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Wrap a D1 binding in a Drizzle client.
 *
 * Constructed per request. There is no module-scope singleton: a Worker
 * isolate can serve requests for more than one `env`, and caching a binding
 * across them is how a test database ends up serving production traffic.
 */
export function createDatabase(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };
