/**
 * The one-time secret the reveal panel shows, straight from a create or a
 * rotate response.
 *
 * It lives in the service tokens page's own `$state` and is handed down as a
 * bindable prop, so the panel clearing it is the page forgetting it. It is
 * never written to a store, the URL, `localStorage` or anything else that
 * outlives the component: Cloudflare returns a client secret exactly once and
 * prick keeps no copy, so this object is the only place it exists.
 */
export interface OneTimeSecret {
  /** What happened, for the panel's title. */
  kind: "created" | "rotated";
  /** The token's display name, or its client id when it has none. */
  label: string;
  clientId: string;
  clientSecret: string;
  /** Rotation only: when the previous secret stops working, `null` if it already has. */
  previousSecretExpiresAt: number | null;
}
