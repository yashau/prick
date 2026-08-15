<script lang="ts">
  import FileUpIcon from '@lucide/svelte/icons/file-up';
  import MinusIcon from '@lucide/svelte/icons/minus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { api, type ImportPreview } from '$lib/client/api';
  import { ApiError } from '$lib/client/errors';
  import { pluralise } from '$lib/client/format';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';

  /**
   * `.env` / JSON import, dry run first.
   *
   * The dry run is the default and the apply button does not exist until one
   * has been done. That ordering is the point: a `replace` import is the only
   * operation in this app that can delete a hundred keys in one go, and the
   * diff -- which carries KEY NAMES and counts, never values, in either
   * direction -- is the last chance to notice that the file you pasted is for
   * staging.
   */

  let { controller }: { controller: SecretsController } = $props();

  let open = $state(false);
  let format = $state<'env' | 'json'>('env');
  let replace = $state(false);
  let content = $state('');
  let preview = $state<ImportPreview | null>(null);
  let running = $state(false);
  let failure = $state<ApiError | null>(null);

  /** A preview is only meaningful for the exact text it was computed from. */
  let previewedContent = $state('');
  const stale = $derived(preview !== null && previewedContent !== content);

  /** The three key lists, in the order they are shown. Names only, no values. */
  const diffSections = $derived<{ heading: string; keys: string[] }[]>(
    preview
      ? [
          { heading: 'Added', keys: preview.added },
          { heading: 'Changed', keys: preview.changed },
          { heading: 'Removed', keys: preview.removed }
        ]
      : []
  );

  async function readFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.name.endsWith('.json')) format = 'json';
    content = await file.text();
    preview = null;
    // Clear the picker so re-selecting the same file fires `change` again.
    input.value = '';
  }

  async function run(dryRun: boolean) {
    running = true;
    failure = null;
    try {
      const result = await api.importSecrets(controller.project, controller.environment, {
        format,
        content,
        mode: replace ? 'replace' : 'merge',
        dry_run: dryRun,
        expected_rev: controller.rev
      });

      if (dryRun) {
        preview = result;
        previewedContent = content;
        return;
      }

      toast.success(
        `Imported: ${result.added.length} added, ${result.changed.length} changed, ${result.removed.length} removed.`
      );
      open = false;
      reset();
      await controller.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        failure = error;
        return;
      }
      throw error;
    } finally {
      running = false;
    }
  }

  function reset() {
    content = '';
    preview = null;
    previewedContent = '';
    failure = null;
    replace = false;
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) reset();
  }}
>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline">
        <FileUpIcon aria-hidden="true" />
        Import
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Import into {controller.environment}</Dialog.Title>
      <Dialog.Description>
        Paste a <code class="font-mono text-xs">.env</code> file or a flat JSON object. Nothing is
        written until you have seen the diff.
      </Dialog.Description>
    </Dialog.Header>

    <Field.Group class="py-2">
      <div class="flex flex-wrap items-end gap-4">
        <Field.Field class="w-40">
          <Field.Label for="import-format">Format</Field.Label>
          <NativeSelect id="import-format" bind:value={format} class="w-full">
            <NativeSelectOption value="env">.env</NativeSelectOption>
            <NativeSelectOption value="json">JSON</NativeSelectOption>
          </NativeSelect>
        </Field.Field>

        <Field.Field class="flex-1">
          <Field.Label for="import-file">Or choose a file</Field.Label>
          <input
            id="import-file"
            type="file"
            accept=".env,.json,text/plain,application/json"
            onchange={readFile}
            class="file:text-foreground text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border p-1.5 text-sm file:mr-2 file:rounded file:border-0 file:bg-transparent file:text-sm focus-visible:ring-3"
          />
        </Field.Field>
      </div>

      <Field.Field>
        <Field.Label for="import-content">Contents</Field.Label>
        <!--
          This textarea holds plaintext values, because the operator pasted
          them here. The password-manager opt-outs still apply: a vault
          extension that captures this field would sync the whole environment
          into a service nobody chose.
        -->
        <Textarea
          id="import-content"
          bind:value={content}
          rows={8}
          class="font-mono text-xs"
          placeholder={'DATABASE_URL="postgres://…"\nSTRIPE_SECRET_KEY="sk_live_…"'}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          oninput={() => (failure = null)}
        />
      </Field.Field>

      <div class="flex items-start gap-3 rounded-md border p-3">
        <Switch id="import-replace" bind:checked={replace} />
        <div class="space-y-1">
          <Label for="import-replace">Replace everything</Label>
          <p class="text-muted-foreground text-xs">
            Keys absent from this file are deleted. Off, keys not mentioned are left alone. Either
            way the whole import is one transaction — it lands completely or not at all.
          </p>
        </div>
      </div>
    </Field.Group>

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

    {#if preview}
      <div class="space-y-3 rounded-md border p-3">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            <PlusIcon aria-hidden="true" />
            {pluralise(preview.added.length, 'addition')}
          </Badge>
          <Badge variant="secondary">
            <PencilIcon aria-hidden="true" />
            {preview.changed.length} changed
          </Badge>
          <Badge variant={preview.removed.length > 0 ? 'destructive' : 'outline'}>
            <MinusIcon aria-hidden="true" />
            {preview.removed.length} removed
          </Badge>
          <Badge variant="outline">{preview.unchanged.length} unchanged</Badge>
          {#if stale}
            <Badge variant="destructive">Contents changed — preview again</Badge>
          {/if}
        </div>

        <ScrollArea class="max-h-48">
          <dl class="grid gap-2 text-xs">
            {#each diffSections as section (section.heading)}
              {#if section.keys.length > 0}
                <div>
                  <dt class="font-medium">{section.heading}</dt>
                  <dd class="text-muted-foreground font-mono break-all">
                    {section.keys.join(', ')}
                  </dd>
                </div>
              {/if}
            {/each}
          </dl>
        </ScrollArea>

        {#if preview.warnings.length > 0}
          <Alert.Root variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <Alert.Title>{pluralise(preview.warnings.length, 'line')} skipped</Alert.Title>
            <Alert.Description class="text-xs">
              {#each preview.warnings as warning (warning.line)}
                <span class="block">Line {warning.line}: {warning.message}</span>
              {/each}
            </Alert.Description>
          </Alert.Root>
        {/if}
      </div>
    {/if}

    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="outline" type="button">Cancel</Button>
        {/snippet}
      </Dialog.Close>
      <Button
        variant="secondary"
        disabled={content.trim() === '' || running}
        onclick={() => run(true)}
      >
        {#if running && !preview}<Spinner class="size-3" />{/if}
        Preview changes
      </Button>
      <Button disabled={preview === null || stale || running} onclick={() => run(false)}>
        {#if running && preview}<Spinner class="size-3" />{/if}
        Apply import
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
