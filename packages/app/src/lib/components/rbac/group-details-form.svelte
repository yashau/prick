<script lang="ts">
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { FormErrors } from '$lib/client/forms';
  import type { GroupView } from '$lib/components/rbac/types';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';

  /**
   * Rename a group, or change what it says it is for. Global admin only.
   *
   * THE SLUG IS NOT EDITABLE, and that is not an oversight. It appears in every
   * audit row this group has ever produced, and a rename that silently
   * repointed an identifier somebody has written down is a change nobody
   * notices until it matters. Delete and recreate instead — which is loud, and
   * drops the grants with it.
   */

  let {
    group,
    errors = {}
  }: {
    group: GroupView;
    errors?: FormErrors;
  } = $props();

  let submitting = $state(false);
</script>

<Card.Root>
  <form
    method="POST"
    action="?/update"
    use:enhance={() => {
      submitting = true;
      return async ({ result }) => {
        submitting = false;
        if (result.type === 'success') {
          toast.success('Group updated.');
          await invalidateAll();
          return;
        }
        await applyAction(result);
      };
    }}
  >
    <Card.Header>
      <Card.Title>Details</Card.Title>
      <Card.Description>
        The slug is fixed. It is what the audit log records, so renaming it would rewrite history
        that other people are reading.
      </Card.Description>
    </Card.Header>

    <Card.Content>
      <Field.Group>
        <Field.Field>
          <Field.Label for="group-detail-slug">Slug</Field.Label>
          <Input id="group-detail-slug" value={group.slug} readonly class="font-mono" />
        </Field.Field>

        <Field.Field>
          <Field.Label for="group-detail-name">Name</Field.Label>
          <Input
            id="group-detail-name"
            name="name"
            value={group.name}
            required
            maxlength={128}
            autocomplete="off"
            aria-invalid={errors.name ? 'true' : undefined}
          />
          {#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="group-detail-description">Description</Field.Label>
          <Textarea
            id="group-detail-description"
            name="description"
            rows={2}
            maxlength={512}
            value={group.description ?? ''}
            placeholder="Optional. Who this group is, and who decides who is on it."
          />
          {#if errors.description}<Field.Error>{errors.description}</Field.Error>{/if}
        </Field.Field>

        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Group>
    </Card.Content>

    <Card.Footer>
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save changes'}
      </Button>
    </Card.Footer>
  </form>
</Card.Root>
