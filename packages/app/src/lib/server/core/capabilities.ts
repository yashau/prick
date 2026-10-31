import { APP_VERSION } from "../../version.js";
import { resolveAuthorization } from "../auth/authorize.js";
import type { CoreContext } from "./context.js";
import { readInstanceId } from "./instance.js";

/**
 * What this server can do, and what the caller may do with it.
 *
 * Service tokens are the first feature that depends on how a deployment is
 * CONFIGURED rather than on which release it runs, so a client cannot infer it
 * from a version number. The server says so instead, through one route that
 * later features add keys to.
 *
 * NOT A SECURITY BOUNDARY. Every route still enforces its own authorization in
 * `core`; this exists so a client can stop early with a useful message. A client
 * that ignores it gets the same 403 or 503 it would have got anyway.
 *
 * WHO LEARNS WHAT. Whether the Worker holds a Cloudflare API token is
 * operational detail about the deployment, so `reason` and `hint` are filled in
 * for global administrators only. Everyone else sees `unavailable` for a feature
 * they cannot use, whatever the configuration.
 *
 * Computed, never stored: from the runtime config and the authorization snapshot
 * this request already resolved, so it costs no query beyond the instance id,
 * which is cached per binding.
 */

export interface FeatureCapability {
  state: "enabled" | "unavailable";
  /** Whether THIS caller may use the feature. */
  allowed: boolean;
  /** Global administrators only: why it is unavailable. */
  reason: "unconfigured" | null;
  /** Global administrators only: what to set to enable it. */
  hint: string | null;
}

export interface Capabilities {
  /** Bumped only by a breaking change to the HTTP API. */
  api: 1;
  /** The web app's CalVer, as on `/health`. */
  version: string;
  /** The deployment's instance id, as in the `Prick-Instance` header. */
  instance: string | null;
  limits: {
    secretMaxBytes: number;
    envMaxSecrets: number;
    bodyMaxBytes: number;
  };
  features: {
    serviceTokens: FeatureCapability;
  };
}

export async function getCapabilities(ctx: CoreContext): Promise<Capabilities> {
  const snapshot = await resolveAuthorization(ctx);
  const globalAdmin = !snapshot.disabled && (snapshot.bootstrap || snapshot.globalRole === "admin");

  const cloudflare = ctx.config.cloudflare;
  const serviceTokens: FeatureCapability = globalAdmin
    ? cloudflare.state === "enabled"
      ? { state: "enabled", allowed: true, reason: null, hint: null }
      : { state: "unavailable", allowed: false, reason: "unconfigured", hint: cloudflare.problem }
    : { state: "unavailable", allowed: false, reason: null, hint: null };

  return {
    api: 1,
    version: APP_VERSION,
    instance: await readInstanceId(ctx.db),
    limits: {
      secretMaxBytes: ctx.config.secretMaxBytes,
      envMaxSecrets: ctx.config.envMaxSecrets,
      bodyMaxBytes: ctx.config.bodyMaxBytes,
    },
    features: { serviceTokens },
  };
}
