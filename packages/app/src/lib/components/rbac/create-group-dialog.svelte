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

  /**
   * Create a group. Global admin only — see `core/groups.ts`.
   *
   * Creating one CONFERS NOTHING on anybody. That is stated in the dialog
   * rather than assumed, because the failure it prevents is an operator who
   * writes down "these five people work on payments", closes the screen, and
   * believes they have granted something.
   */

  let {
    errors = {}
  }: {
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
   * `$derived` would be wrong: the slug is a function of the name AND of
   * whether the user has taken it over, and a derived value would overwrite a
   * hand-typed slug on the next keystroke in the name field.
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
        New group
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
            toast.success('Group created.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <Dialog.Header>
        <Dialog.Title>New group</Dialog.Title>
        <Dialog.Description>
          A group is a named set of identities that can hold grants. Creating one gives nobody
          anything: a group with no grants is a list. Add members, then grant it a role at a
          scope you administer.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="group-name">Name</Field.Label>
          <Input
            id="group-name"
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
          <Field.Label for="group-slug">Slug</Field.Label>
          <Input
            id="group-slug"
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
            Lowercase letters, digits and single interior hyphens. Immutable once created — a
            slug that silently repointed would break every audit row that names it.
          </Field.Description>
          {#if errors.slug}<Field.Error>{errors.slug}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="group-description">Description</Field.Label>
          <Textarea
            id="group-description"
            name="description"
            rows={2}
            maxlength={512}
            placeholder="Optional. Who this group is, and who decides who is on it."
          />
          {#if errors.description}<Field.Error>{errors.description}</Field.Error>{/if}
        </Field.Field>

        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create group'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
