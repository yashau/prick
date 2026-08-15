<script lang="ts">
  import HistoryIcon from '@lucide/svelte/icons/history';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import type { Snippet } from 'svelte';

  import { page } from '$app/state';
  import { reveal } from '$lib/client/reveal.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';

  let { children }: { children: Snippet } = $props();

  const project = $derived(page.params.project ?? '');
  const environment = $derived(page.params.env ?? '');
  const onHistory = $derived(page.url.pathname.endsWith('/history'));

  /**
   * Leaving the subtree drops every revealed value.
   *
   * The 30-second expiry would get there on its own, but not immediately, and
   * "I navigated away" is a clear signal that nothing on the previous screen
   * is still wanted. The teardown of an `$effect` is the right hook for this:
   * it is a side effect tied to this layout being mounted, not derived state.
   */
  $effect(() => () => reveal.wipe());
</script>

<div class="flex flex-wrap items-center gap-2">
  <h1 class="text-2xl font-semibold tracking-tight">
    <span class="text-muted-foreground font-normal">{project}</span>
    <span class="text-muted-foreground font-normal" aria-hidden="true">/</span>
    {environment}
  </h1>

  <div class="ml-auto flex items-center gap-1">
    <Button
      href="/p/{project}/{environment}"
      size="sm"
      variant={onHistory ? 'ghost' : 'secondary'}
      aria-current={onHistory ? undefined : 'page'}
    >
      <KeyRoundIcon aria-hidden="true" />
      Secrets
    </Button>
    <Button
      href="/p/{project}/{environment}/history"
      size="sm"
      variant={onHistory ? 'secondary' : 'ghost'}
      aria-current={onHistory ? 'page' : undefined}
    >
      <HistoryIcon aria-hidden="true" />
      History
    </Button>
  </div>
</div>

<Separator />

{@render children()}
