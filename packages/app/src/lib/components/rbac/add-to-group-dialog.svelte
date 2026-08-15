<script lang="ts">
  import UsersIcon from '@lucide/svelte/icons/users';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { FormErrors } from '$lib/client/forms';
  import type { GroupView } from '$lib/components/rbac/types';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';

  /**
   * Put this identity into a group. Global admin only.
   *
   * Offered from the identity's own screen as well as from the group's, because
   * the two questions an operator arrives with are "who is in `deploy`" and
   * "why does Bob have production" — and the second one ends here.
   *
   * The role a group confers is spelled out beside each option, so choosing one
   * is not a guess about what it will hand over.
   */

  let {
    /** Groups this identity is not already in. */
    candidates,
    subject,
    errors = {}
  }: {
    candidates: GroupView[];
    subject: string;
    errors?: FormErrors;
  } = $props();

  let open = $state(false);
  let groupId = $state('');
  let submitting = $state(false);
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" disabled={candidates.length === 0}>
        <UsersIcon aria-hidden="true" />
        Add to group
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <form
      method="POST"
      action="?/addToGroup"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            open = false;
            groupId = '';
            toast.success('Added to the group.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <Dialog.Header>
        <Dialog.Title>Add to a group</Dialog.Title>
        <Dialog.Description>
          {subject} gains every role the group holds, at every scope it holds one, on their next
          request. Effective role is the maximum over their own grants and their groups' — a
          group can raise it and can never lower it.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="add-to-group">Group</Field.Label>
          <NativeSelect id="add-to-group" name="group_id" bind:value={groupId} class="w-full">
            <NativeSelectOption value="">Select a group…</NativeSelectOption>
            {#each candidates as group (group.id)}
              <NativeSelectOption value={group.id}>
                {group.name} ({group.slug}) — {group.grantCount === 0
                  ? 'holds no grants'
                  : group.grantCount === 1
                    ? 'holds 1 grant'
                    : `holds ${String(group.grantCount)} grants`}
              </NativeSelectOption>
            {/each}
          </NativeSelect>
          <Field.Description>
            A group holding no grants confers nothing. It is a list until somebody grants it a
            role.
          </Field.Description>
        </Field.Field>

        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={groupId === '' || submitting}>
          {submitting ? 'Adding…' : 'Add to group'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
