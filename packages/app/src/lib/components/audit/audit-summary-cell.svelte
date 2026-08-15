<script lang="ts">
  import type { AuditEntryView } from '$lib/client/api';
  import { actionLabel, summariseDetail } from '$lib/client/audit';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let { entry }: { entry: AuditEntryView } = $props();

  const summary = $derived(summariseDetail(entry));
</script>

<div class="flex flex-col gap-0.5">
  <span class="flex flex-wrap items-center gap-1.5 text-sm">
    {actionLabel(entry.action)}
    {#if entry.projectSlug}
      <Badge variant="outline" class="font-mono">
        {entry.projectSlug}{entry.environmentSlug ? `/${entry.environmentSlug}` : ''}
      </Badge>
    {/if}
    {#if entry.targetKey}
      <Badge variant="secondary" class="font-mono">{entry.targetKey}</Badge>
    {/if}
  </span>
  {#if summary}
    <span class="text-muted-foreground text-xs">{summary}</span>
  {/if}
</div>
