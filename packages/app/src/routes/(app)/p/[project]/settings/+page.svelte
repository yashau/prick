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

<!--
  A single column, capped.

  The app shell hands every page the full width, which is right for the tables
  and environment grids but wrong here: this screen is two prose-heavy cards
  and one short form, and a name field three feet wide invites nobody to type
  in it.
-->
<div class="flex max-w-3xl flex-col gap-4">
  <PageHeader
    title="Project settings"
    description="Display name, description, and deletion for this project."
  />

  <Card.Root>
    <!--
      The form carries the card's own column layout.

      `Card.Root` spaces its sections with `gap-(--card-spacing)`, which only
      reaches direct children -- and a form wrapping the header, content and
      footer is one child, so the gap lands nowhere and the three sections
      stack flush against each other. Restating the column here is what keeps
      the spacing while the whole card stays inside a single submit.
    -->
    <form
      class="flex flex-col gap-(--card-spacing)"
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
              class="text-muted-foreground font-mono"
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
              placeholder="Optional. What this project covers, and who owns it."
            />
            {#if errors.description}<Field.Error>{errors.description}</Field.Error>{/if}
          </Field.Field>

          {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
        </Field.Group>
      </Card.Content>

      <Card.Footer class="border-t">
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
      </Card.Footer>
    </form>
  </Card.Root>

  <!--
    `ring`, not `border`.

    The card outlines itself with `ring-1 ring-foreground/10` and preflight
    leaves every border at zero width, so a lone `border-destructive/50` set a
    colour on an edge that was never drawn -- the danger zone rendered
    identically to the card above it.
  -->
  <Card.Root class="ring-destructive/40">
    <Card.Header>
      <Card.Title class="text-destructive flex items-center gap-2">
        <TriangleAlertIcon class="size-4" aria-hidden="true" />
        Danger zone
      </Card.Title>
      <Card.Description>
        Deleting {data.project.name} removes {pluralise(data.environments.length, 'environment')}
        and every secret, version and grant beneath them, by foreign-key cascade in a single
        transaction. The ciphertexts are bound to those environment ids, so they would not decrypt
        even if the rows were restored elsewhere.
      </Card.Description>
    </Card.Header>
    <Card.Footer class="border-t">
      <Button variant="destructive" onclick={() => (deleteOpen = true)}>
        Delete this project
      </Button>
    </Card.Footer>
  </Card.Root>
</div>

<DeleteProjectDialog project={data.project} bind:open={deleteOpen} redirectTo="/projects" />
