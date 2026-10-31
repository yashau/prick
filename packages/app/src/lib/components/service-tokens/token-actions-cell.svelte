<script lang="ts">
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

  /**
   * A revoked token offers no actions: its identity is disabled and Cloudflare
   * has deleted it, so there is nothing left to rotate, refresh or revoke.
   */

  let {
    token,
    onRotate,
    onRefresh,
    onRevoke
  }: {
    token: ServiceTokenRecord;
    onRotate: (token: ServiceTokenRecord) => void;
    onRefresh: (token: ServiceTokenRecord) => void;
    onRevoke: (token: ServiceTokenRecord) => void;
  } = $props();

  const label = $derived(token.name ?? token.clientId);
</script>

{#if token.status !== 'revoked'}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon-sm">
          <MoreHorizontalIcon aria-hidden="true" />
          <span class="sr-only">Actions for {label}</span>
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item onSelect={() => onRotate(token)} disabled={token.status === 'missing'}>
        Rotate secret…
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={() => onRefresh(token)} disabled={token.status === 'missing'}>
        Extend expiry
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item variant="destructive" onSelect={() => onRevoke(token)}>
        Revoke…
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
