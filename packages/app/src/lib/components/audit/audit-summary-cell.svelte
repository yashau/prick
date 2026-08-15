<script lang="ts">
  import type { AuditEntryView } from '$lib/client/api';
  import { actionLabel, scopeLabel, summariseDetail, type ScopeNames } from '$lib/client/audit';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let {
    entry,
    /**
     * id -> slug, from the lists the screen already loaded. An audit row
     * carries ids and no slugs, on purpose: the log is append-only, and a name
     * frozen into a row at write time can be re-pointed at a different id by a
     * delete and a re-create. Omitting this renders the ids, which is worse to
     * read and never wrong.
     */
    scopes
  }: { entry: AuditEntryView; scopes?: ScopeNames } = $props();

  const summary = $derived(summariseDetail(entry));
  const scope = $derived(scopeLabel(entry, scopes));
</script>

<div class="flex flex-col gap-0.5">
  <span class="flex flex-wrap items-center gap-1.5 text-sm">
    {actionLabel(entry.action)}
    {#if scope}
      <Badge variant="outline" class="font-mono">{scope}</Badge>
    {/if}
    {#if entry.targetKey}
      <Badge variant="secondary" class="font-mono">{entry.targetKey}</Badge>
    {/if}
  </span>
  {#if summary}
    <span class="text-muted-foreground text-xs">{summary}</span>
  {/if}
</div>
