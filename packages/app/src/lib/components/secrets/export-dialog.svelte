<script lang="ts">
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import FileDownIcon from '@lucide/svelte/icons/file-down';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { api } from '$lib/client/api';
  import { copyPlainText } from '$lib/client/clipboard';
  import { downloadText, toDotenv, toJson, UnrepresentableValueError } from '$lib/client/dotenv';
  import { ApiError } from '$lib/client/errors';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';

  /**
   * Export the whole environment.
   *
   * The rendered file is NEVER shown on screen. An export is fetched, handed
   * straight to a download or to the clipboard, and dropped -- so the values
   * never enter the DOM, never end up in a screenshot, and never sit in a
   * detached node waiting for garbage collection.
   *
   * It is also the loudest action available here: one `secret.export` audit
   * row covering every key, and a file on disk that this app cannot protect.
   * The dialog says so before the button is pressed rather than after.
   */

  let { controller }: { controller: SecretsController } = $props();

  let open = $state(false);
  let format = $state<'env' | 'json'>('env');
  let running = $state(false);
  let failure = $state<ApiError | null>(null);
  let unrepresentable = $state<string | null>(null);

  async function render(): Promise<string | null> {
    running = true;
    failure = null;
    unrepresentable = null;
    try {
      const values = await api.exportSecrets(controller.project, controller.environment);
      return format === 'env' ? toDotenv(values) : toJson(values);
    } catch (error) {
      if (error instanceof UnrepresentableValueError) {
        unrepresentable = error.key;
        return null;
      }
      if (error instanceof ApiError) {
        failure = error;
        return null;
      }
      throw error;
    } finally {
      running = false;
    }
  }

  async function download() {
    const text = await render();
    if (text === null) return;
    downloadText(
      format === 'env' ? `${controller.environment}.env` : `${controller.environment}.json`,
      text,
      format === 'env' ? 'text/plain' : 'application/json'
    );
    open = false;
    toast.success('Exported. The file on disk is plaintext — treat it accordingly.');
  }

  async function copy() {
    const text = await render();
    if (text === null) return;
    try {
      await copyPlainText(text);
      open = false;
      toast.success('Exported to the clipboard.');
    } catch {
      toast.error('This browser will not give the page clipboard access.');
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline">
        <FileDownIcon aria-hidden="true" />
        Export
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Export {controller.environment}</Dialog.Title>
      <Dialog.Description>
        Every value in this environment is decrypted and written out in plaintext. This is
        recorded as a single <code class="font-mono text-xs">secret.export</code> row naming you
        and the number of keys.
      </Dialog.Description>
    </Dialog.Header>

    <Field.Field class="py-2">
      <Field.Label for="export-format">Format</Field.Label>
      <NativeSelect id="export-format" bind:value={format}>
        <NativeSelectOption value="env">.env — every value double-quoted</NativeSelectOption>
        <NativeSelectOption value="json">JSON — sorted keys</NativeSelectOption>
      </NativeSelect>
      <Field.Description>
        {#if format === 'env'}
          Values are always quoted and only <code class="font-mono">\ " \n \r \t</code> are
          escaped. A value containing any other control character is refused rather than written
          as a line two parsers would read differently.
        {:else}
          Keys sorted, so two exports of the same environment are byte-identical.
        {/if}
      </Field.Description>
    </Field.Field>

    {#if controller.unreadableCount > 0}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>
          {controller.unreadableCount} value{controller.unreadableCount === 1 ? '' : 's'} cannot be
          decrypted
        </Alert.Title>
        <Alert.Description>
          The export will fail rather than silently omit them. A short file is worse than no file:
          that is how a deploy loses a key nobody notices is missing.
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if unrepresentable}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>{unrepresentable} cannot be written as .env</Alert.Title>
        <Alert.Description>
          Its value contains a control character that has no unambiguous representation in this
          format. Export as JSON instead.
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if failure}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>{failure.code}</Alert.Title>
        <Alert.Description>
          {failure.message}
          {#if failure.hint}<span class="block">{failure.hint}</span>{/if}
          {#if failure.requestId}
            <span class="block font-mono text-xs">request {failure.requestId}</span>
          {/if}
        </Alert.Description>
      </Alert.Root>
    {/if}

    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="outline" type="button">Cancel</Button>
        {/snippet}
      </Dialog.Close>
      <Button variant="secondary" disabled={running} onclick={copy}>
        {#if running}<Spinner class="size-3" />{:else}<ClipboardIcon aria-hidden="true" />{/if}
        Copy
      </Button>
      <Button disabled={running} onclick={download}>
        {#if running}<Spinner class="size-3" />{:else}<DownloadIcon aria-hidden="true" />{/if}
        Download
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
