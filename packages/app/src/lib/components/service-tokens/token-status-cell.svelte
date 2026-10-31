<script lang="ts">
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';

  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { absoluteTime, relativeTime } from '#lib/client/format.js';
  import { Badge } from '#lib/components/ui/badge/index.js';

  /**
   * The status word is always spelled out; colour only reinforces it.
   *
   * A leak report is the loudest thing a row can carry: Cloudflare sets it when
   * a secret scanner found this token's secret somewhere public, and the answer
   * is a rotation with no grace period.
   */

  let { token }: { token: ServiceTokenRecord } = $props();

  const leakedAt = $derived(token.cloudflare?.leakReportedAt ?? null);
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#if token.status === 'active'}
    <Badge variant="secondary">active</Badge>
  {:else if token.status === 'revoked'}
    <Badge
      variant="outline"
      title={token.revokedAt ? `Revoked ${absoluteTime(token.revokedAt)} by ${token.revokedBy ?? 'unknown'}` : undefined}
    >
      revoked
    </Badge>
  {:else}
    <Badge
      variant="destructive"
      title="Cloudflare no longer has this token. Check with Cloudflare to retire the record."
    >
      missing
    </Badge>
  {/if}

  {#if leakedAt !== null}
    <Badge variant="destructive" title="Reported {absoluteTime(leakedAt)}">
      <ShieldAlertIcon aria-hidden="true" />
      leak reported {relativeTime(leakedAt)}
    </Badge>
  {/if}

  {#if token.cloudflare && !token.cloudflare.enabled && token.status === 'active'}
    <Badge variant="outline">disabled in Cloudflare</Badge>
  {/if}
</div>
