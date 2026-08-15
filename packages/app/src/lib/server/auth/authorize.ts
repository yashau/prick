import type { Role } from "@prick/shared";

import type { CoreContext, Scope } from "../core/context.js";

/**
 * Authorization. One resolution per request, one code path, no exceptions.
 *
 * TODO(build order step 11): implement, with the full permission-matrix table
 * test -- every (role x scope x operation) cell, plus expired grants and
 * disabled identities.
 *
 * THERE IS NO GOD MODE. The upstream shortcut this replaces was
 * `if (auth.keyType === 'user') return true`, which meant every human
 * credential bypassed every scope check in the system. A global admin here is
 * an ordinary `grants` row with `scope_type = 'global'`: same query, same audit
 * trail, revocable.
 *
 * Effective role = MAX over all matching, non-expired grants, resolved ONCE and
 * cached on the request context. A 200-secret operation must perform one
 * authorization query, not two hundred.
 */
export function resolveEffectiveRole(_ctx: CoreContext, _scope: Scope): Promise<Role | null> {
  throw new Error("resolveEffectiveRole() is not implemented yet");
}

/**
 * Throw `PrickError('FORBIDDEN')` unless the actor holds at least `required`
 * at `scope`.
 *
 * TODO(build order step 11): implement. EVERY denial is audited with
 * `outcome: 'denied'` before it throws -- that is what populates the "Seen but
 * not granted" screen, and it is the only way an operator ever learns that a
 * service token exists.
 */
export function assertCan(_ctx: CoreContext, _scope: Scope, _required: Role): Promise<void> {
  throw new Error("assertCan() is not implemented yet");
}
