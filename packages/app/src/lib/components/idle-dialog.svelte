<script lang="ts">
  import LockIcon from '@lucide/svelte/icons/lock';

  import { idle, IDLE_AFTER_MS } from '$lib/client/idle.svelte.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';

  /**
   * What the user sees after 15 minutes of nothing.
   *
   * By the time this renders the revealed values are ALREADY gone -- the idle
   * watcher wipes them first and raises its flag second, so a failure to mount
   * this dialog cannot leave a value on screen. This is the notification, not
   * the mechanism.
   *
   * Which is why there is exactly one button. There was a second one that
   * reloaded the page "to re-authenticate", and it was theatre: Access owns the
   * identity check, its session is measured in hours, and this app has no
   * sign-out of its own to pair a sign-in with. Offering re-authentication next
   * to a dismiss button implied the dismiss was skipping a security step. It
   * never was -- the wipe already happened, and the only cost of continuing is
   * revealing again. Signing out is a deliberate act and lives in the sidebar,
   * not in a dialog that fires on a timer.
   */

  const minutes = Math.round(IDLE_AFTER_MS / 60_000);

  // Attaching listeners is a genuine side effect; Svelte owns the teardown.
  $effect(() => idle.start());
</script>

<!--
  `onOpenChange` rather than the `escapeKeydownBehavior="ignore"` /
  `interactOutsideBehavior="ignore"` pair this dialog used to carry. `open` is
  driven by the store, so a dismissal Bits performs on its own would leave the
  flag set and the dialog wedged. Routing every close through `resume()` keeps
  the two in step, and a notice with nothing to decide should take Escape for an
  answer.
-->
<AlertDialog.Root
  open={idle.idle}
  onOpenChange={(open) => {
    if (!open) idle.resume();
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title class="flex items-center gap-2">
        <LockIcon class="size-4" aria-hidden="true" />
        Session idle
      </AlertDialog.Title>
      <AlertDialog.Description>
        Nothing has happened here for {minutes} minutes, so every revealed value has been
        discarded from this tab. Reveal what you need again to carry on.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Action onclick={() => idle.resume()}>Continue</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
