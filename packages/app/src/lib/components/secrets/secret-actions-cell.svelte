<script lang="ts">
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

  import type { SecretListEntry } from '$lib/client/api';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

  let {
    row,
    controller,
    onRename,
    onDelete
  }: {
    row: SecretListEntry;
    controller: SecretsController;
    onRename: (row: SecretListEntry) => void;
    onDelete: (keys: string[]) => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon-sm">
        <MoreHorizontalIcon aria-hidden="true" />
        <span class="sr-only">Actions for {row.key}</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    <DropdownMenu.Item onSelect={() => onRename(row)}>Rename…</DropdownMenu.Item>
    <DropdownMenu.Item>
      {#snippet child({ props })}
        <a
          {...props}
          href="/p/{controller.project}/{controller.environment}/history?key={encodeURIComponent(
            row.key
          )}"
        >
          Versions and rollback
        </a>
      {/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item variant="destructive" onSelect={() => onDelete([row.key])}>
      Delete…
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
