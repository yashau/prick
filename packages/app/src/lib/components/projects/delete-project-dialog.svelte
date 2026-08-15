<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ProjectSummary } from '$lib/client/api';
  import { pluralise } from '$lib/client/format';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let {
    project,
    open = $bindable(false),
    /** Where to go afterwards. The project settings page cannot stay put. */
    redirectTo
  }: {
    project: ProjectSummary | null;
    open?: boolean;
    redirectTo?: string;
  } = $props();

  let confirmation = $state('');
  let submitting = $state(false);

  /**
   * The cascade is real: D1 enforces foreign keys, so `ON DELETE CASCADE`
   * actually fires and takes every environment, secret, version and grant with
   * it. Saying so in the dialog is the only warning there is.
   */
  const matches = $derived(project !== null && confirmation === project.slug);
</script>

<AlertDialog.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) confirmation = '';
  }}
>
  <AlertDialog.Content>
    <form
      method="POST"
      action="/projects?/delete"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            open = false;
            confirmation = '';
            toast.success(`Deleted ${project?.slug}.`);
            if (redirectTo) {
              location.assign(redirectTo);
              return;
            }
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <input type="hidden" name="slug" value={project?.slug ?? ''} />

      <AlertDialog.Header>
        <AlertDialog.Title class="flex items-center gap-2">
          <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
          Delete {project?.name}
        </AlertDialog.Title>
        <AlertDialog.Description>
          This removes {pluralise(project?.environmentCount ?? 0, 'environment')} and every secret,
          version and grant beneath them. The values are gone: there is no undo and no backup this
          app can restore from. The audit log keeps the record of the deletion.
        </AlertDialog.Description>
      </AlertDialog.Header>

      <Field.Field class="py-2">
        <Field.Label for="confirm-delete-project">
          Type <code class="font-mono">{project?.slug}</code> to confirm
        </Field.Label>
        <Input
          id="confirm-delete-project"
          name="confirm"
          bind:value={confirmation}
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
        />
      </Field.Field>

      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button
          type="submit"
          class={buttonVariants({ variant: 'destructive' })}
          disabled={!matches || submitting}
        >
          {submitting ? 'Deleting…' : 'Delete project'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
