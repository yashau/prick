<script lang="ts">
  import { mode, ModeWatcher } from 'mode-watcher';
  import type { Snippet } from 'svelte';

  import { writeAppearance } from '$lib/client/theme';
  import CommandPalette from '$lib/components/command-palette.svelte';
  import IdleDialog from '$lib/components/idle-dialog.svelte';
  import { Toaster } from '$lib/components/ui/sonner/index.js';

  import '../app.css';

  // Svelte 5 runes throughout. No `export let` anywhere in this app.
  let { children }: { children: Snippet } = $props();

  /**
   * Mirror the RESOLVED appearance into a cookie, so the next response can put
   * the class on `<html>` before a single byte of body is parsed.
   *
   * `mode` is mode-watcher's DERIVED mode -- already `light` or `dark`, with
   * "system" resolved against the OS. That is deliberately not the same thing
   * as the preference, and it is why this lives here rather than inside
   * `ThemeToggle`: a toggle can only report what was clicked, whereas this also
   * catches the two cases nobody clicks. A first-time visitor whose preference
   * is "system" writes a cookie on their first render, and a user who flips
   * their OS to dark at dusk while a tab is open writes one then.
   *
   * `$effect` and not `$derived`, because writing a cookie is a genuine side
   * effect. It is a no-op on the server, which is correct: there is nothing to
   * mirror until a browser has resolved it.
   */
  $effect(() => {
    const resolved = mode.current;
    if (resolved !== undefined) writeAppearance(resolved);
  });
</script>

<svelte:head>
  <title>prick</title>
</svelte:head>

<!--
  `disableHeadScriptInjection` is deliberate, not an oversight. DO NOT REMOVE IT
  to "fix the flash" -- the flash is already fixed, server-side.

  mode-watcher's FOUC-prevention snippet is an INLINE <script>, and the CSP in
  svelte.config.js is `script-src 'self' 'strict-dynamic'` with SvelteKit-issued
  nonces. SvelteKit does not expose that nonce to components, so the snippet
  would be injected un-nonced and blocked -- a guaranteed console error on every
  page, in exchange for nothing. Weakening the CSP of a secrets manager to
  remove a flash is not a trade worth making.

  It does not have to be. The `$effect` above mirrors the resolved appearance
  into the `prick_theme` cookie, `hooks.server.ts` reads that cookie and stamps
  `class="dark"` onto `<html>` in `app.html`, and the correct palette is
  therefore in the first byte of the response with no script involved at all.

  ONE CASE REMAINS, and it is small: the very first page a browser is ever
  served from this origin, before any cookie exists, by a user whose preference
  is "system" and whose OS is dark. There is no cookie and no script, so the
  server cannot know -- it emits `color-scheme: light dark`, so the UA already
  paints the canvas, scrollbars and form controls dark, and only the token
  palette is light until hydration. The cookie written then means it never
  happens again on that browser. Closing it outright needs the dark token block
  in `app.css` -- `.dark`-only today -- to ALSO answer to
  `@media (prefers-color-scheme: dark)`, which is a change to the palette file
  rather than to this one.
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
