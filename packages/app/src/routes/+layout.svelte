<script lang="ts">
  import { ModeWatcher } from 'mode-watcher';
  import type { Snippet } from 'svelte';

  import CommandPalette from '$lib/components/command-palette.svelte';
  import IdleDialog from '$lib/components/idle-dialog.svelte';
  import { Toaster } from '$lib/components/ui/sonner/index.js';

  import '../app.css';

  // Svelte 5 runes throughout. No `export let` anywhere in this app.
  let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
  <title>prick</title>
</svelte:head>

<!--
  `disableHeadScriptInjection` is deliberate, not an oversight.

  mode-watcher's FOUC-prevention snippet is an INLINE <script>, and the CSP in
  svelte.config.js is `script-src 'self' 'strict-dynamic'` with SvelteKit-issued
  nonces. SvelteKit does not expose that nonce to components, so the snippet
  would be injected un-nonced and blocked -- a guaranteed console error on every
  page, in exchange for nothing. The cost of turning it off is a brief flash of
  the light palette before hydration on server-rendered pages. Weakening the CSP
  of a secrets manager to remove a flash is not a trade worth making.
-->
<ModeWatcher disableHeadScriptInjection />

<!--
  Toasts are the app's only transient surface, and they are used for API
  outcomes -- including the request id an operator pastes back to an admin.
  Never for a secret value.
-->
<Toaster position="bottom-right" richColors closeButton />

<CommandPalette />
<IdleDialog />

{@render children()}
