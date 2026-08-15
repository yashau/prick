<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { pluralise } from '$lib/client/format';
  import type { FormErrors } from '$lib/client/forms';
  import PageHeader from '$lib/components/page-header.svelte';
  import DeleteProjectDialog from '$lib/components/projects/delete-project-dialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let saving = $state(false);
  let deleteOpen = $state(false);

  const errors = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<svelte:head>
  <title>Settings · {data.project.name} · prick</title>
</svelte:head>

<PageHeader title="Project settings" description={data.project.slug} />

<Card.Root>
  <form
    method="POST"
    action="?/update"
    use:enhance={() => {
      saving = true;
      return async ({ result }) => {
        saving = false;
        if (result.type === 'success') {
          toast.success('Project updated.');
          await invalidateAll();
          return;
        }
        await applyAction(result);
      };
    }}
  >
    <Card.Header>
      <Card.Title>Name and description</Card.Title>
      <Card.Description>
        Both are display-only. The slug is fixed: it appears in CLI scopes, in grant rows and in
        every audit entry this project has ever produced, so changing it would be a migration
        rather than an edit.
      </Card.Description>
    </Card.Header>

    <Card.Content>
      <Field.Group>
        <Field.Field>
          <Field.Label for="project-name">Name</Field.Label>
          <Input
            id="project-name"
            name="name"
            value={data.project.name}
            required
            maxlength={128}
            autocomplete="off"
            aria-invalid={errors.name ? 'true' : undefined}
          />
          {#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="project-slug-readonly">Slug</Field.Label>
          <Input
            id="project-slug-readonly"
            value={data.project.slug}
            readonly
            class="font-mono"
            aria-describedby="project-slug-note"
          />
          <Field.Description id="project-slug-note">Immutable.</Field.Description>
        </Field.Field>

        <Field.Field>
          <Field.Label for="project-description">Description</Field.Label>
          <Textarea
            id="project-description"
            name="description"
            rows={3}
            maxlength={1024}
            value={data.project.description ?? ''}
          />
        </Field.Field>

        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Group>
    </Card.Content>

    <Card.Footer>
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
    </Card.Footer>
  </form>
</Card.Root>

<Card.Root class="border-destructive/50">
  <Card.Header>
    <Card.Title class="text-destructive flex items-center gap-2">
      <TriangleAlertIcon class="size-4" aria-hidden="true" />
      Danger zone
    </Card.Title>
    <Card.Description>
      Deleting {data.project.name} removes {pluralise(data.environments.length, 'environment')} and
      every secret, version and grant beneath them, by foreign-key cascade in a single
      transaction. The ciphertexts are bound to those environment ids, so they would not decrypt
      even if the rows were restored elsewhere.
    </Card.Description>
  </Card.Header>
  <Card.Footer>
    <Button variant="destructive" onclick={() => (deleteOpen = true)}>Delete this project</Button>
  </Card.Footer>
</Card.Root>

<DeleteProjectDialog project={data.project} bind:open={deleteOpen} redirectTo="/projects" />
