<script lang="ts">
  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { absoluteTime, relativeTime } from '#lib/client/format.js';

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
  <span class="text-muted-foreground text-sm">{token.cloudflare === null ? 'Unknown' : 'Never'}</span>
{/if}
