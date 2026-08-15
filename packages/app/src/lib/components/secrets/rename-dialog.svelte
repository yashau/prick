<script lang="ts">
  import { toast } from 'svelte-sonner';

  import { SecretKey } from '@prick/shared';

  import type { SecretListEntry } from '$lib/client/api';
  import { ApiError } from '$lib/client/errors';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  let {
    controller,
    row = $bindable(),
    open = $bindable(false)
  }: {
    controller: SecretsController;
    row: SecretListEntry | null;
    open?: boolean;
  } = $props();

  let next = $state('');
  let saving = $state(false);
  let failure = $state<string | null>(null);

  const issue = $derived.by(() => {
    if (next === '') return null;
    const parsed = SecretKey.safeParse(next);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid key name.';
    if (next === row?.key) return 'That is the current name.';
    if (controller.rows.some((entry) => entry.key === next)) return `${next} already exists here.`;
    return null;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!row) return;
    saving = true;
    failure = null;
    try {
      await controller.rename(row.key, next);
      toast.success(`Renamed to ${next}.`);
      open = false;
      next = '';
    } catch (error) {
      failure =
        error instanceof ApiError
          ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`
          : 'Something went wrong.';
    } finally {
      saving = false;
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(isOpen) => {
    if (isOpen) {
      next = row?.key ?? '';
      failure = null;
    }
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Rename {row?.key}</Dialog.Title>
        <Dialog.Description>
          There is no cheap rename. The ciphertext is bound to the key name, so the value is
          decrypted under the old name and re-encrypted under the new one as a new version, both
          in a single transaction. History is preserved and the old envelope is never reused.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Field class="py-4">
        <Field.Label for="rename-key">New name</Field.Label>
        <Input
          id="rename-key"
          bind:value={next}
          required
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
          aria-invalid={issue ? 'true' : undefined}
        />
        {#if issue}<Field.Error>{issue}</Field.Error>{/if}
        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
      </Field.Field>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={next === '' || issue !== null || saving}>
          {#if saving}<Spinner class="size-3" />{/if}
          Rename
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
