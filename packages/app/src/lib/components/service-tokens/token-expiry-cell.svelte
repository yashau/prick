<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { absoluteTime, relativeTime } from '#lib/client/format.js';

  /**
   * Cloudflare's expiry, with a warning inside the last 30 days.
   *
   * An expired service token fails every job that uses it at once, so the
   * warning arrives while a refresh is still a routine click.
   */

  let { token }: { token: ServiceTokenRecord } = $props();

  const WARN_WITHIN_MS = 30 * 24 * 3_600_000;

  const expiresAt = $derived(token.cloudflare?.expiresAt ?? null);
  const now = Date.now();
  const expired = $derived(expiresAt !== null && expiresAt <= now);
  const soon = $derived(expiresAt !== null && !expired && expiresAt - now < WARN_WITHIN_MS);
</script>

{#if token.status === 'revoked'}
  <span class="text-muted-foreground text-sm">—</span>
{:else if token.cloudflare === null}
  <span class="text-muted-foreground text-sm">Unknown</span>
{:else if expiresAt === null}
  <span class="text-muted-foreground text-sm">Never expires</span>
{:else}
  <time
    class="flex items-center gap-1 text-sm {expired || soon ? 'text-destructive font-medium' : ''}"
    datetime={new Date(expiresAt).toISOString()}
    title={absoluteTime(expiresAt)}
  >
    {#if expired || soon}<TriangleAlertIcon class="size-3.5" aria-hidden="true" />{/if}
    {expired ? `Expired ${relativeTime(expiresAt)}` : `Expires ${relativeTime(expiresAt)}`}
  </time>
{/if}
