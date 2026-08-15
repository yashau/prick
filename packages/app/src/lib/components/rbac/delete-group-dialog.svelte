<script lang="ts">
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { pluralise } from '$lib/client/format';
  import type { FormErrors } from '$lib/client/forms';
  import type { GroupView } from '$lib/components/rbac/types';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  /**
   * Delete a group. Global admin only.
   *
   * DELETION FOLLOWS MEMBERSHIP for a reason beyond consistency: deleting a
   * group revokes its access in every project at once, INCLUDING projects the
   * deleter cannot see. A project admin who could delete `platform` would be
   * removing access from teams they have no relationship with, and would not
   * even be shown what they had removed.
   *
   * The cascade is real — `ON DELETE CASCADE` takes the memberships and the
   * grants in the same transaction — so the counts are spelled out here. And
   * the server will REFUSE this outright if the group holds the last global
   * admin grant: there is no recovery credential in this design, so a lockout
   * is refused rather than confirmed.
   */

  let {
    group,
    open = $bindable(false),
    /** Where to go afterwards; this screen cannot stay put. */
    redirectTo = '/groups',
    errors = {}
  }: {
    group: GroupView;
    open?: boolean;
    redirectTo?: string;
    errors?: FormErrors;
  } = $props();

  let confirmation = $state('');
  let submitting = $state(false);

  const matches = $derived(confirmation === group.slug);
</script>

<Button variant="destructive" onclick={() => (open = true)}>
  <Trash2Icon aria-hidden="true" />
  Delete group
</Button>

<AlertDialog.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) confirmation = '';
  }}
>
  <AlertDialog.Content>
    <form
      method="POST"
      action="?/delete"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'redirect' || result.type === 'success') {
            open = false;
            confirmation = '';
            toast.success(`Deleted ${group.slug}.`);
            location.assign(redirectTo);
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <AlertDialog.Header>
        <AlertDialog.Title class="flex items-center gap-2">
          <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
          Delete {group.name}
        </AlertDialog.Title>
        <AlertDialog.Description>
          This removes {pluralise(group.memberCount, 'membership')} and
          {pluralise(group.grantCount, 'grant')} in one transaction. Everyone on the roster loses
          every role this group conferred, in every project it reached — including projects that
          are not shown on this screen. The audit log keeps the record.
        </AlertDialog.Description>
      </AlertDialog.Header>

      <input type="hidden" name="slug" value={group.slug} />

      <Field.Field class="py-2">
        <Field.Label for="confirm-delete-group">
          Type <code class="font-mono">{group.slug}</code> to confirm
        </Field.Label>
        <Input
          id="confirm-delete-group"
          name="confirm"
          bind:value={confirmation}
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
        />
        {#if errors.confirm}<Field.Error>{errors.confirm}</Field.Error>{/if}
        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Field>

      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button
          type="submit"
          class={buttonVariants({ variant: 'destructive' })}
          disabled={!matches || submitting}
        >
          {submitting ? 'Deleting…' : 'Delete group'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
