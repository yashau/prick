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
    errors = {}
  }: {
    /** Server-side field errors from the last `?/create` submission. */
    errors?: FormErrors;
  } = $props();

  let open = $state(false);
  let submitting = $state(false);
  let name = $state('');
  let slug = $state('');
  let slugTouched = $state(false);

  /**
   * The slug follows the name until someone edits it, then it stops.
   *
   * `$derived` would be wrong here: the slug is not a function of the name, it
   * is a function of the name *and of whether the user has taken it over*. A
   * derived value would silently overwrite a hand-typed slug on the next
   * keystroke in the name field.
   */
  function syncSlug() {
    if (slugTouched) return;
    slug = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
  }

  function reset() {
    name = '';
    slug = '';
    slugTouched = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props}>
        <PlusIcon aria-hidden="true" />
        New project
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <form
      method="POST"
      action="?/create"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            open = false;
            reset();
            toast.success('Project created.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <Dialog.Header>
        <Dialog.Title>New project</Dialog.Title>
        <Dialog.Description>
          A project groups environments. Both the slug and the environment slug appear in CLI
          scopes as <code class="font-mono text-xs">project:environment</code>.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="project-name">Name</Field.Label>
          <Input
            id="project-name"
            name="name"
            bind:value={name}
            oninput={syncSlug}
            required
            maxlength={128}
            autocomplete="off"
            aria-invalid={errors.name ? 'true' : undefined}
          />
          {#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="project-slug">Slug</Field.Label>
          <Input
            id="project-slug"
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
            Lowercase letters, digits and single interior hyphens. Immutable once created.
          </Field.Description>
          {#if errors.slug}<Field.Error>{errors.slug}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="project-description">Description</Field.Label>
          <Textarea
            id="project-description"
            name="description"
            rows={2}
            maxlength={512}
            placeholder="Optional. What this project is for."
          />
          {#if errors.description}<Field.Error>{errors.description}</Field.Error>{/if}
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
          {submitting ? 'Creating…' : 'Create project'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
