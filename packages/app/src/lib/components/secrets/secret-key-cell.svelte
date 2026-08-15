<script lang="ts">
  import type { SecretListEntry } from '$lib/client/api';
  import CopyButton from '$lib/components/copy-button.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let { row }: { row: SecretListEntry } = $props();
</script>

<div class="flex flex-col gap-0.5">
  <div class="flex items-center gap-1">
    <!--
      Key names are stored in PLAINTEXT and are safe to show, copy and search.
      Only the value is encrypted. Copying a key name goes through the plain
      clipboard helper, not the audited one -- it is not a reveal.
    -->
    <code class="font-mono text-sm font-medium break-all">{row.key}</code>
    <CopyButton text={row.key} label="Copy the name {row.key}" size="icon-xs" />
    <Badge variant="outline" class="font-mono">v{row.version}</Badge>
  </div>
  {#if row.description}
    <p class="text-muted-foreground max-w-prose text-xs">{row.description}</p>
  {/if}
</div>
