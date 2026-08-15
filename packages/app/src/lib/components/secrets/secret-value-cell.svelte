<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import XIcon from '@lucide/svelte/icons/x';
  import { toast } from 'svelte-sonner';

  import type { SecretListEntry } from '$lib/client/api';
  import { ApiError } from '$lib/client/errors';
  import { MASK } from '$lib/client/format';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  /**
   * The masked value cell.
   *
   * One `input-group` from the registry: mono input, eye toggle, copy button
   * and edit control in a single control, rather than an input with three
   * buttons scattered around it. Everything that touches a value goes through
   * here.
   */

  let {
    row,
    controller
  }: {
    row: SecretListEntry;
    controller: SecretsController;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const revealed = $derived(controller.isRevealed(row.key));
  const busy = $derived(controller.busy.has(row.key));
  const secondsLeft = $derived(controller.secondsLeft(row.key));
  const shown = $derived(controller.valueOf(row.key));

  /**
   * Focus is a genuine side effect, which is what `$effect` is for. It runs
   * when the editor opens, not on every keystroke, because it depends only on
   * `editing` and `input`.
   */
  $effect(() => {
    if (editing && input) input.select();
  });

  async function toggleReveal() {
    if (revealed) {
      controller.hideKey(row.key);
      return;
    }
    try {
      await controller.revealKey(row.key);
    } catch (error) {
      reportFailure(error, `Could not reveal ${row.key}`);
    }
  }

  async function copy() {
    try {
      await controller.copyKey(row.key);
      toast.success(`${row.key} copied. The clipboard is cleared in 30 seconds.`);
    } catch (error) {
      reportFailure(error, `Could not copy ${row.key}`);
    }
  }

  async function beginEdit() {
    try {
      draft = await controller.loadForEdit(row.key);
      editing = true;
    } catch (error) {
      reportFailure(error, `Could not open ${row.key} for editing`);
    }
  }

  function cancelEdit() {
    editing = false;
    // The draft held a plaintext value. Drop it the instant the editor closes
    // rather than leaving it in component state until the row unmounts.
    draft = '';
  }

  async function commit() {
    saving = true;
    try {
      await controller.save(row.key, draft);
      toast.success(`${row.key} updated to version ${row.version + 1}.`);
      cancelEdit();
    } catch (error) {
      reportFailure(error, `Could not save ${row.key}`);
    } finally {
      saving = false;
    }
  }

  function reportFailure(error: unknown, title: string) {
    if (error instanceof ApiError) {
      toast.error(title, {
        description: error.requestId
          ? `${error.message} (request ${error.requestId})`
          : error.message
      });
      return;
    }
    toast.error(title, {
      description: error instanceof Error ? error.message : 'Something went wrong.'
    });
  }
</script>

{#if row.unreadable}
  <!--
    A row whose envelope will not open is the loudest thing on the screen.

    NOT a blank cell, NOT a skipped row. Swallowing the failure would turn a
    tamper attempt into a quietly shorter `.env`, which is how a deploy loses
    DATABASE_URL and nobody finds out until the outage. Here the
    row states what failed and what the two possible causes are, because
    "you removed MASTER_KEY_OLD too early" and "these bytes have been altered"
    need opposite responses.
  -->
  <Alert.Root variant="destructive" class="py-2">
    <ShieldAlertIcon aria-hidden="true" />
    <Alert.Title class="text-sm">Cannot decrypt</Alert.Title>
    <Alert.Description class="text-xs">
      The stored envelope failed authentication. Either it is sealed under a key id this keyring
      no longer holds, or its bytes have been altered. It is recorded in the audit log with
      outcome <code class="font-mono">error</code>.
    </Alert.Description>
  </Alert.Root>
{:else if editing}
  <form
    class="flex items-center gap-1"
    onsubmit={(event) => {
      event.preventDefault();
      void commit();
    }}
  >
    <InputGroup.Root>
      <InputGroup.Input
        bind:ref={input}
        bind:value={draft}
        aria-label="New value for {row.key}"
        class="font-mono"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        onkeydown={(event) => {
          if (event.key === 'Escape') cancelEdit();
        }}
      />
      <InputGroup.Addon align="inline-end">
        <InputGroup.Button type="submit" size="icon-xs" disabled={saving} aria-label="Save {row.key}">
          {#if saving}
            <Spinner class="size-3" />
          {:else}
            <CheckIcon aria-hidden="true" />
          {/if}
          <span class="sr-only">Save {row.key}</span>
        </InputGroup.Button>
        <InputGroup.Button size="icon-xs" onclick={cancelEdit} aria-label="Cancel editing {row.key}">
          <XIcon aria-hidden="true" />
          <span class="sr-only">Cancel editing {row.key}</span>
        </InputGroup.Button>
      </InputGroup.Addon>
    </InputGroup.Root>
  </form>
{:else}
  <InputGroup.Root>
    <!--
      READONLY, and the value only ever arrives here after an explicit reveal.
      The password-manager opt-outs are not cosmetic: 1Password, LastPass and
      Bitwarden all capture and SYNC field contents they believe to be
      credentials, which would put every revealed value into a third-party
      vault the operator never chose.
    -->
    <InputGroup.Input
      readonly
      value={shown ?? MASK}
      aria-label={revealed ? `${row.key}, revealed` : `${row.key}, hidden`}
      class="font-mono transition-colors duration-150 motion-reduce:transition-none"
      autocomplete="off"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-form-type="other"
    />
    <InputGroup.Addon align="inline-end">
      {#if revealed}
        <span class="text-muted-foreground tabular-nums" aria-hidden="true">{secondsLeft}s</span>
      {/if}
      <InputGroup.Button
        size="icon-xs"
        aria-pressed={revealed}
        disabled={busy}
        onclick={toggleReveal}
      >
        {#if busy}
          <Spinner class="size-3" />
        {:else if revealed}
          <EyeOffIcon aria-hidden="true" />
        {:else}
          <EyeIcon aria-hidden="true" />
        {/if}
        <span class="sr-only">{revealed ? `Hide ${row.key}` : `Reveal ${row.key}`}</span>
      </InputGroup.Button>
      <InputGroup.Button size="icon-xs" disabled={busy} onclick={copy}>
        <CopyIcon aria-hidden="true" />
        <span class="sr-only">Copy the value of {row.key}</span>
      </InputGroup.Button>
      <InputGroup.Button size="icon-xs" disabled={busy} onclick={beginEdit}>
        <PencilIcon aria-hidden="true" />
        <span class="sr-only">Edit {row.key}</span>
      </InputGroup.Button>
    </InputGroup.Addon>
  </InputGroup.Root>
{/if}
