import type { CoreContext, RuntimeConfig } from "../core/context.js";

/**
 * First-admin bootstrap, without a race and without a bootstrap token.
 *
 * TODO(build order step 11): implement.
 *
 * `BOOTSTRAP_ADMINS` is a plain `vars` list of emails, evaluated LIVE on every
 * request rather than seeded once into the database. The honest justification:
 * the real root of trust is already "whoever can run `wrangler deploy`" -- that
 * person can read `MASTER_KEY` and decrypt every value in the database
 * regardless of what any grant says. Anchoring bootstrap to the same authority
 * therefore adds no exposure, and unlike a one-time token there is no window
 * during which a printed credential is valid and unrevoked.
 *
 * On the first authenticated request from a listed email it SELF-HEALS into a
 * real `grants` row and audits the fact, so the implicit path stops being used
 * as soon as it has been used once.
 *
 * Three guards, all of which need to exist:
 *
 *   - A UI banner for as long as any admin is implicit (`Actor.bootstrap`).
 *   - `503 NO_ADMINS_CONFIGURED` when BOTH the var is empty AND no global admin
 *     grant exists. Failing closed and loudly beats serving an install that
 *     nobody can administer.
 *   - `409 LAST_ADMIN` on revoking the last global admin grant while the var is
 *     empty. There is no recovery credential by design, so this must be refused
 *     rather than confirmed.
 */
export function isBootstrapAdmin(_config: RuntimeConfig, _subject: string): boolean {
  throw new Error("isBootstrapAdmin() is not implemented yet");
}

/** TODO(build order step 11): convert an implicit bootstrap admin into a real grant. */
export function selfHealBootstrapGrant(_ctx: CoreContext): Promise<void> {
  throw new Error("selfHealBootstrapGrant() is not implemented yet");
}

/** TODO(build order step 11): true when neither the var nor any global admin grant exists. */
export function hasNoAdmins(_ctx: CoreContext): Promise<boolean> {
  throw new Error("hasNoAdmins() is not implemented yet");
}
