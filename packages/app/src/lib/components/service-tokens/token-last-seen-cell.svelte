<script lang="ts">
  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { absoluteTime, relativeTime } from '#lib/client/format.js';

  /**
   * When Cloudflare last saw the token in use.
   *
   * A missing time reads "Unknown", never "Never": Cloudflare does not document
   * the field, so its absence says nothing about whether the token was used.
   */

  let { token }: { token: ServiceTokenRecord } = $props();

  const lastSeenAt = $derived(token.cloudflare?.lastSeenAt ?? null);
</script>

{#if lastSeenAt !== null}
  <time
    class="text-sm"
    datetime={new Date(lastSeenAt).toISOString()}
    title={absoluteTime(lastSeenAt)}
  >
    {relativeTime(lastSeenAt)}
  </time>
{:else}
  <span class="text-muted-foreground text-sm">Unknown</span>
{/if}
