<script lang="ts">
  import type { Snippet } from 'svelte';

  // Svelte 5 runes throughout. No `export let` anywhere in this app.
  let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
  <title>prick</title>
</svelte:head>

{@render children()}
