<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  // TODO(build order step 15): the app shell.
  //
  // Built from shadcn-svelte REGISTRY components -- nothing on this list is
  // hand-rolled: sidebar, separator, breadcrumb, button, dropdown-menu, avatar,
  // tooltip, sonner, command, kbd, scroll-area, skeleton, badge.
  // Dark mode via `mode-watcher`.
  //
  // Also belongs here: the banner shown for as long as any admin is implicit
  // via BOOTSTRAP_ADMINS rather than a real grant.
</script>

<div class="app-shell">
  {@render children()}
</div>

<style>
  .app-shell {
    min-height: 100vh;
  }
</style>
