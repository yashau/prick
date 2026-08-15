<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    actions
  }: {
    title: string;
    description?: string;
    /** Primary controls for the screen. Rendered right-aligned, wraps first. */
    actions?: Snippet;
  } = $props();
</script>

<div class="flex flex-wrap items-start justify-between gap-3">
  <div class="space-y-1">
    <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
    {#if description}
      <p class="text-muted-foreground text-sm">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</div>
