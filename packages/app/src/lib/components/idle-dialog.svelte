<script lang="ts">
  import LockIcon from '@lucide/svelte/icons/lock';

  import { idle, IDLE_AFTER_MS } from '$lib/client/idle.svelte.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { buttonVariants } from '$lib/components/ui/button/index.js';

  /**
   * What the user sees after 15 minutes of nothing.
   *
   * By the time this renders the revealed values are ALREADY gone -- the idle
   * watcher wipes them first and raises its flag second, so a failure to mount
   * this dialog cannot leave a value on screen. This is the notification, not
   * the mechanism.
   */

  const minutes = Math.round(IDLE_AFTER_MS / 60_000);

  // Attaching listeners is a genuine side effect; Svelte owns the teardown.
  $effect(() => idle.start());

  function reauthenticate() {
    // A full reload, not a client-side navigation: Cloudflare Access sits in
    // front of the document request, so this is the only thing that actually
    // re-runs the identity check. If the Access session is still good it is
    // invisible; if it has expired the SSO flow takes over here.
    location.reload();
  }
</script>

<AlertDialog.Root open={idle.idle}>
  <AlertDialog.Content
    escapeKeydownBehavior="ignore"
    interactOutsideBehavior="ignore"
    onOpenAutoFocus={(event) => event.preventDefault()}
  >
    <AlertDialog.Header>
      <AlertDialog.Title class="flex items-center gap-2">
        <LockIcon class="size-4" aria-hidden="true" />
        Session idle
      </AlertDialog.Title>
      <AlertDialog.Description>
        Nothing has happened here for {minutes} minutes, so every revealed value has been
        discarded from this tab. Reload to confirm you are still you, or carry on and reveal
        what you need again.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel onclick={() => idle.resume()}>Carry on</AlertDialog.Cancel>
      <AlertDialog.Action class={buttonVariants({ variant: 'default' })} onclick={reauthenticate}>
        Reload and re-authenticate
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
