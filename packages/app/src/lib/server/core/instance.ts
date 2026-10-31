import type { Database } from "../db/index.js";
import { instance } from "../db/schema.js";

/**
 * THE DEPLOYMENT'S INSTANCE ID: the permanent, random value a CLI profile pins.
 *
 * The URL cannot identify a deployment and neither can the Access issuer: two
 * deployments can sit behind the same Access organisation with identical
 * project, environment and key names, and a hostname can be repointed at a
 * different database. The `instance` row is written into D1 by a migration, so
 * it names the DATA -- a restored backup answers with the id it had, and a fresh
 * database answers with a new one.
 *
 * READ ONLY. Nothing in the application writes the table. Minting a row lazily
 * here would be a mutation with no audit row and no actor to attribute it to,
 * so a database without one reports `null` and the transports omit the id.
 *
 * AUTHENTICATED CALLERS ONLY. The id is a fingerprint: it tells whoever holds it
 * which deployment answered. `/health` is the one unauthenticated route and must
 * reveal nothing beyond "a prick server is listening here", so the transports
 * serve this from `whoami` and the `Prick-Instance` response header, both behind
 * authentication.
 */

/**
 * One read per D1 binding, then free.
 *
 * Keyed by the binding object rather than held in a module-scope variable: an
 * isolate can serve requests for more than one `env`, and a single cached value
 * would answer one database's id for another. A `WeakMap` lets the entry go with
 * the binding.
 *
 * The PROMISE is cached, so concurrent first requests share one query. A `null`
 * answer is not cached -- a database that gains its row (the migration applied
 * after this isolate started) reports it on the next request rather than at the
 * next isolate. A rejected read is evicted, so a transient D1 failure is retried
 * rather than remembered.
 */
const cache = new WeakMap<object, Promise<string | null>>();

/** This deployment's instance id, or `null` when the database holds none. */
export function readInstanceId(db: Database): Promise<string | null> {
  const key = db.$client;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const pending = db
    .select({ id: instance.id })
    .from(instance)
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);

  cache.set(key, pending);

  pending.then(
    (id) => {
      if (id === null) cache.delete(key);
    },
    () => {
      cache.delete(key);
    },
  );

  return pending;
}
