/**
 * THE NAME, AND ONLY THE NAME.
 *
 * Cloudflare Access does not put a display name in the application JWT. The
 * token is a cookie, the cookie has a size limit, and what survives that limit
 * is the subset needed to decide WHO is calling: `email`, `sub`, `aud`, the
 * timestamps. A human's actual name is not part of an authorization decision,
 * so it is not in there, and no amount of re-reading the assertion will produce
 * one.
 *
 * It is available from `/cdn-cgi/access/get-identity` on the team domain, which
 * takes the same `CF_Authorization` cookie the browser already sent us and
 * answers with the full identity the provider handed Access -- `name`, `email`,
 * `groups`, the device posture. We want exactly one field of it.
 *
 * ---------------------------------------------------------------------------
 * THIS IS COSMETIC DATA AND IT IS TREATED AS SUCH.
 * ---------------------------------------------------------------------------
 * Nothing here may ever reach an authorization decision. `subject` -- the
 * verified `email` claim -- stays the only identifier this application
 * authenticates or authorises on, and it keeps coming from the JWT this Worker
 * verified itself. What comes back from here is a string to draw in a sidebar.
 *
 * That distinction is what makes the failure policy legitimate: every error
 * path below returns `null` rather than throwing. A secrets manager must not
 * fail a request because a decoration lookup timed out, and it must not fail
 * OPEN on anything that matters -- so the one thing this module is allowed to
 * influence, it is allowed to lose entirely.
 */

import { eq } from "drizzle-orm";

import type { CoreContext } from "../core/context.js";
import { identities } from "../db/schema.js";
import { resolveAuthorization } from "./authorize.js";

/** Longest name we will store. Long enough for a real one, short enough to bound a row. */
const MAX_NAME_BYTES = 128;

/** Give up well inside any reasonable request budget. The answer is optional. */
const DEFAULT_TIMEOUT_MS = 2_000;

export interface AccessDirectoryOptions {
  /** The `<team>` in `https://<team>.cloudflareaccess.com`. */
  team: string;
  /** The incoming request, read ONLY for its `cookie` header. */
  request: Request;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask Access for this caller's display name.
 *
 * Returns `null` for every outcome that is not "Access gave us a usable name":
 * no cookie, non-200, unparseable body, absent or blank `name`, timeout,
 * network error. The caller cannot distinguish them and does not need to --
 * see `displayNameSyncedAt` for why "asked and got nothing" is still recorded.
 *
 * ONLY THE COOKIE IS FORWARDED. The documented example pipes the whole inbound
 * request through, which would also hand Access this application's own
 * `Authorization` header and whatever else a client attached. `get-identity`
 * needs one credential, so it is sent one.
 */
export async function fetchAccessDisplayName(
  options: AccessDirectoryOptions,
): Promise<string | null> {
  const { team, request, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const cookie = request.headers.get("cookie");

  /*
   * No cookie means no browser session -- a service token, or the CLI holding
   * an Access token in a header. Neither has a name to look up, and issuing the
   * subrequest anyway would spend a round trip to be told so.
   */
  if (cookie === null || cookie === "" || team.trim() === "") return null;

  const url = `https://${team.trim()}.cloudflareaccess.com/cdn-cgi/access/get-identity`;

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { cookie, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return null;

    return nameFrom(await response.json());
  } catch {
    /*
     * Deliberately swallowed, and deliberately not logged as an error. A
     * provider being slow is not an incident in this application, and a log
     * line per request for a name we do not have would bury the ones that
     * matter -- this Worker's observability exists to answer "who read that
     * secret".
     */
    return null;
  }
}

/**
 * Pull `name` out of whatever came back, trusting none of its shape.
 *
 * The body crosses a trust boundary: it is assembled by Access from data an
 * identity provider supplied, and this application has no say in either. So it
 * is treated as unknown JSON -- not cast, not schema-parsed into something that
 * would throw, just narrowed field by field.
 *
 * Blank is normalised to `null` so that a provider sending `""` and one sending
 * nothing at all land in the same place. Anything else would put an empty
 * string in `display_name`, and every reader in this codebase renders that with
 * `displayName ?? subject` -- which shows a blank where an address belongs.
 */
function nameFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const name = (body as Record<string, unknown>)["name"];
  if (typeof name !== "string") return null;

  const trimmed = name.trim();
  if (trimmed === "") return null;

  return trimmed.slice(0, MAX_NAME_BYTES);
}

// ---------------------------------------------------------------------------
// Persisting it
// ---------------------------------------------------------------------------

/**
 * How long a fruitless lookup is respected before Access is asked again.
 *
 * The interval exists for the identities Access has no name for. Without it
 * they would re-ask on every request forever; with it they re-ask weekly, which
 * is also how a name that did not exist at first sign-in eventually arrives
 * once somebody fills it in at the provider.
 */
const RESYNC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fill in `identities.display_name` from Access, at most once per identity per
 * interval.
 *
 * CALL THIS OFF THE CRITICAL PATH. It performs a subrequest, and nothing that
 * depends on its result is rendered in the same response -- the name shows up
 * on the next navigation. Both transports hand it to `waitUntil` so a slow
 * provider costs a page load nothing.
 *
 * Reads the identity row from the authorization snapshot, which is memoised per
 * request and has already run by the time this is called, so the guard below
 * costs no query. Only the write costs anything, and only on the request that
 * actually resolves a name.
 */
export async function syncAccessDisplayName(ctx: CoreContext, request: Request): Promise<void> {
  /*
   * Service tokens have no name and never will. `common_name` IS the label, and
   * it is already what `subject` holds.
   */
  if (ctx.actor.kind !== "user") return;

  const snapshot = await resolveAuthorization(ctx);
  if (snapshot.identityId === null) return;

  /*
   * A NAME ALREADY SET IS NEVER OVERWRITTEN.
   *
   * `display_name` is editable by an administrator, and an operator who renamed
   * a row meant it. Letting a provider silently win that argument would make
   * the edit look like it did not save. The consequence -- a name changed at
   * the provider does not propagate -- is the correct trade: one is a
   * deliberate act by someone in this application, the other is upstream data
   * about a field nothing depends on.
   */
  if (snapshot.displayName !== null) return;

  if (
    snapshot.displayNameSyncedAt !== null &&
    ctx.now - snapshot.displayNameSyncedAt < RESYNC_AFTER_MS
  ) {
    return;
  }

  const name = await fetchAccessDisplayName({ team: ctx.config.accessTeam, request });

  /*
   * Written even when `name` is null. That is the entire point of the column:
   * "asked, got nothing" has to be distinguishable from "never asked", or the
   * guard above can never hold for an identity Access cannot name.
   */
  await ctx.db
    .update(identities)
    .set({ displayName: name, displayNameSyncedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(identities.id, snapshot.identityId));
}

/**
 * Hand the sync to the runtime and forget about it.
 *
 * Separate from `syncAccessDisplayName` so the transports do not each have to
 * remember the two things that make it safe: the `catch`, and that the result
 * is never awaited. Both matter -- an unhandled rejection from a decoration
 * lookup would surface as a Worker error on a request that otherwise succeeded.
 *
 * `waitUntil` is optional because the two transports disagree about whether one
 * exists: `platform.ctx` can be absent, and Hono's `c.executionCtx` THROWS when
 * the runtime supplied none. Without it the task is still started, and the
 * runtime may cancel it -- which costs a name that the next request resolves
 * anyway.
 */
export function scheduleAccessDisplayNameSync(
  ctx: CoreContext,
  request: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const task = syncAccessDisplayName(ctx, request).catch(() => {
    // Cosmetic to the last. Nothing about a name is worth a failed request.
  });

  waitUntil?.(task);
}
