<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { FormErrors } from '$lib/client/forms';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';

  let {
    errors = {},
    variant = 'default'
  }: {
    errors?: FormErrors;
    variant?: 'default' | 'outline';
  } = $props();

  let open = $state(false);
  let submitting = $state(false);
  let name = $state('');
  let slug = $state('');
  let slugTouched = $state(false);

  function syncSlug() {
    if (slugTouched) return;
    slug = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} {variant}>
        <PlusIcon aria-hidden="true" />
        New environment
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <form
      method="POST"
      action="?/createEnvironment"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            open = false;
            name = '';
            slug = '';
            slugTouched = false;
            toast.success('Environment created.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <Dialog.Header>
        <Dialog.Title>New environment</Dialog.Title>
        <Dialog.Description>
          An environment is the unit secrets belong to, the unit grants are scoped to, and the
          unit ciphertexts are cryptographically bound to. Its id is immutable and it can never
          be moved to another project.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="environment-name">Name</Field.Label>
          <Input
            id="environment-name"
            name="name"
            bind:value={name}
            oninput={syncSlug}
            required
            maxlength={128}
            autocomplete="off"
            placeholder="Production"
            aria-invalid={errors.name ? 'true' : undefined}
          />
          {#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="environment-slug">Slug</Field.Label>
          <Input
            id="environment-slug"
            name="slug"
            bind:value={slug}
            oninput={() => (slugTouched = true)}
            required
            maxlength={64}
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            aria-invalid={errors.slug ? 'true' : undefined}
          />
          <Field.Description>
            Appears in CLI scopes as <code class="font-mono text-xs">project:environment</code>.
          </Field.Description>
          {#if errors.slug}<Field.Error>{errors.slug}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="environment-description">Description</Field.Label>
          <Textarea id="environment-description" name="description" rows={2} maxlength={512} />
        </Field.Field>

        {#if errors.form}
          <Field.Error>{errors.form}</Field.Error>
        {/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create environment'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
