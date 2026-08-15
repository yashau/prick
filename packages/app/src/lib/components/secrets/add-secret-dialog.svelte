<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { toast } from 'svelte-sonner';

  import { SECRET_VALUE_MAX_BYTES, SecretKey, utf8ByteLength } from '@prick/shared';

  import { ApiError } from '$lib/client/errors';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';

  let { controller }: { controller: SecretsController } = $props();

  let open = $state(false);
  let key = $state('');
  let value = $state('');
  let reason = $state('');
  let saving = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Validated with the SAME schema the API validates against, so a rejection
   * reads identically whether it came from here or from `prk`. This is a
   * convenience check, not the guard -- the server validates again regardless.
   */
  const keyIssue = $derived.by(() => {
    if (key === '') return null;
    const parsed = SecretKey.safeParse(key);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid key name.');
  });

  const duplicate = $derived(controller.rows.some((row) => row.key === key));

  /**
   * The bound is on UTF-8 BYTES, not characters: a four-byte emoji is one JS
   * "character" and four stored bytes, and counting `.length` would let a
   * value four times the intended size through.
   */
  const bytes = $derived(utf8ByteLength(value));
  const tooLarge = $derived(bytes > SECRET_VALUE_MAX_BYTES);

  const valid = $derived(key !== '' && !keyIssue && !duplicate && !tooLarge);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    failure = null;
    try {
      await controller.save(key, value, reason || undefined);
      toast.success(`${key} created.`);
      open = false;
      key = '';
      value = '';
      reason = '';
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

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props}>
        <PlusIcon aria-hidden="true" />
        Add secret
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Add a secret to {controller.environment}</Dialog.Title>
        <Dialog.Description>
          The key is stored in plaintext and is searchable. The value is encrypted and bound to
          this environment, this key and this version — it cannot be moved anywhere else.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="secret-key">Key</Field.Label>
          <Input
            id="secret-key"
            bind:value={key}
            required
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            placeholder="DATABASE_URL"
            aria-invalid={keyIssue || duplicate ? 'true' : undefined}
          />
          <Field.Description>
            A POSIX environment variable name: a letter or underscore, then letters, digits or
            underscores.
          </Field.Description>
          {#if keyIssue}<Field.Error>{keyIssue}</Field.Error>{/if}
          {#if duplicate}
            <Field.Error>{key} already exists here. Edit it in the table instead.</Field.Error>
          {/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="secret-value">Value</Field.Label>
          <Textarea
            id="secret-value"
            bind:value
            rows={3}
            class="font-mono text-xs"
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
          />
          <Field.Description>
            {bytes.toLocaleString()} of {SECRET_VALUE_MAX_BYTES.toLocaleString()} bytes
          </Field.Description>
          {#if tooLarge}<Field.Error>Too large. The limit is on UTF-8 bytes.</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="secret-reason">Reason</Field.Label>
          <Input
            id="secret-reason"
            bind:value={reason}
            maxlength={512}
            autocomplete="off"
            placeholder="Optional. Recorded verbatim in the audit row."
          />
        </Field.Field>

        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={!valid || saving}>
          {#if saving}<Spinner class="size-3" />{/if}
          Create
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
