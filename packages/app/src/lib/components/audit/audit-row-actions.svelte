<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

  import type { AuditEntryView } from '$lib/client/api';
  import { Button } from '$lib/components/ui/button/index.js';

  let {
    entry,
    onOpen
  }: {
    entry: AuditEntryView;
    onOpen: (entry: AuditEntryView) => void;
  } = $props();
</script>

<Button variant="ghost" size="icon-sm" onclick={() => onOpen(entry)}>
  <ChevronRightIcon aria-hidden="true" />
  <span class="sr-only">Open details for this {entry.action} entry</span>
</Button>
