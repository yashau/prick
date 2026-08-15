<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';

  import type { SecretListEntry } from '$lib/client/api';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';

  let { row }: { row: SecretListEntry } = $props();

  /** A service token's subject is an opaque hex string; mark it as one. */
  const isService = $derived(row.updatedBy.endsWith('.access'));
</script>

<div class="flex flex-col gap-0.5 text-xs">
  <time datetime={new Date(row.updatedAt).toISOString()} title={absoluteTime(row.updatedAt)}>
    {relativeTime(row.updatedAt)}
  </time>
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <span {...props} class="text-muted-foreground flex items-center gap-1 truncate">
            {#if isService}
              <KeyRoundIcon class="size-3" aria-hidden="true" />
            {/if}
            <span class="max-w-40 truncate font-mono">{row.updatedBy}</span>
          </span>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        {isService ? 'Service token' : 'User'}: {row.updatedBy}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
</div>
