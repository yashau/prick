<script lang="ts">
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import UsersIcon from '@lucide/svelte/icons/users';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import type { FormErrors } from '$lib/client/forms';
  import IdentityCombobox from '$lib/components/access/identity-combobox.svelte';
  import IdentityCell from '$lib/components/rbac/identity-cell.svelte';
  import type { GroupMemberView, IdentityView } from '$lib/components/rbac/types';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * Who is in a group.
   *
   * ---------------------------------------------------------------------------
   * MEMBERSHIP IS GLOBAL-ADMIN ONLY, AND THE ARGUMENT IS WORTH KNOWING
   * ---------------------------------------------------------------------------
   * The permissive reading — "a project admin should be able to manage the
   * groups they grant into" — is superficially reasonable and is a privilege
   * escalation. Suppose `platform` holds admin on `payments` and on `billing`.
   * The admin of `billing` may grant to `platform`: their scope, their
   * decision. If they could also edit its roster they could add THEMSELVES and
   * walk out with admin on `payments`, a project they have nothing to do with,
   * without anybody granting them anything.
   *
   * So the two capabilities are split, and this component renders that split
   * rather than hiding it: an actor who cannot change the roster still SEES it,
   * and is told which authority the change needs instead of being handed a
   * button that 403s.
   *
   * `disabled` is shown per row on purpose. A disabled identity in a privileged
   * group holds nothing — the kill switch outranks every grant — and without
   * the flag an operator reads a roster of five and believes five people have
   * access.
   */

  let {
    members,
    /** Everyone who could be added. Already narrowed by `listIdentities`. */
    identities,
    groupSlug,
    /** Global admin. Anything less renders the roster read-only. */
    canManage,
    errors = {}
  }: {
    members: GroupMemberView[];
    identities: IdentityView[];
    groupSlug: string;
    canManage: boolean;
    errors?: FormErrors;
  } = $props();

  let addOpen = $state(false);
  let identityId = $state('');
  let adding = $state(false);

  let removing = $state<GroupMemberView | null>(null);
  let removeOpen = $state(false);
  let removingSubmit = $state(false);

  const memberIds = $derived(new Set(members.map((member) => member.identityId)));
  const candidates = $derived(identities.filter((identity) => !memberIds.has(identity.id)));
</script>

<div class="flex flex-wrap items-center justify-between gap-2">
  <p class="text-muted-foreground text-sm">
    {members.length === 1 ? '1 identity is' : `${String(members.length)} identities are`} in
    <code class="font-mono">{groupSlug}</code>. Membership confers nothing on its own — only the
    grants this group holds do.
  </p>

  {#if canManage}
    <Dialog.Root bind:open={addOpen}>
      <Dialog.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="outline" size="sm" disabled={candidates.length === 0}>
            <UserPlusIcon aria-hidden="true" />
            Add member
          </Button>
        {/snippet}
      </Dialog.Trigger>
      <Dialog.Content class="sm:max-w-lg">
        <form
          method="POST"
          action="?/addMember"
          use:enhance={() => {
            adding = true;
            return async ({ result }) => {
              adding = false;
              if (result.type === 'success') {
                addOpen = false;
                identityId = '';
                toast.success('Added to the group.');
                await invalidateAll();
                return;
              }
              await applyAction(result);
            };
          }}
        >
          <Dialog.Header>
            <Dialog.Title>Add to {groupSlug}</Dialog.Title>
            <Dialog.Description>
              They gain every role this group holds, at every scope it holds one, on their next
              request. Nothing is cached across requests, so there is nothing to wait for.
            </Dialog.Description>
          </Dialog.Header>

          <Field.Group class="py-4">
            <Field.Field>
              <Field.Label for="add-member-identity">Identity</Field.Label>
              <IdentityCombobox
                id="add-member-identity"
                identities={candidates}
                bind:value={identityId}
              />
              {#if errors.identity}<Field.Error>{errors.identity}</Field.Error>{/if}
            </Field.Field>
            {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
          </Field.Group>

          <Dialog.Footer>
            <Dialog.Close>
              {#snippet child({ props })}
                <Button {...props} variant="outline" type="button">Cancel</Button>
              {/snippet}
            </Dialog.Close>
            <Button type="submit" disabled={identityId === '' || adding}>
              {adding ? 'Adding…' : 'Add member'}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  {/if}
</div>

{#if !canManage}
  <p class="text-muted-foreground text-sm">
    Changing this roster needs an install-wide administrator. Deciding what a group may do inside
    your project is yours; deciding who is on it is not — otherwise adding yourself to a group
    would be a way to grant yourself access to every other project it reaches.
  </p>
{/if}

{#if members.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <UsersIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>Nobody is in this group</Empty.Title>
      <Empty.Description>
        An empty group is normal and is not an error. Whatever grants it holds reach nobody until
        somebody is added.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">The identities in {groupSlug}.</Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Identity</Table.Head>
          <Table.Head class="w-44">Added</Table.Head>
          <Table.Head class="w-56">Added by</Table.Head>
          {#if canManage}
            <Table.Head class="w-28"><span class="sr-only">Remove</span></Table.Head>
          {/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each members as member (member.identityId)}
          <Table.Row>
            <Table.Cell>
              <IdentityCell
                kind={member.kind}
                subject={member.subject}
                displayName={member.displayName}
                disabled={member.disabled}
                href="/users/{member.identityId}"
              />
            </Table.Cell>
            <Table.Cell>
              <time
                class="text-sm"
                datetime={new Date(member.addedAt).toISOString()}
                title={absoluteTime(member.addedAt)}
              >
                {relativeTime(member.addedAt)}
              </time>
            </Table.Cell>
            <Table.Cell>
              <span class="text-muted-foreground font-mono text-xs break-all">
                {member.addedBy}
              </span>
            </Table.Cell>
            {#if canManage}
              <Table.Cell>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => {
                    removing = member;
                    removeOpen = true;
                  }}
                >
                  Remove
                  <span class="sr-only">{member.subject} from {groupSlug}</span>
                </Button>
              </Table.Cell>
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<AlertDialog.Root bind:open={removeOpen}>
  <AlertDialog.Content>
    <form
      method="POST"
      action="?/removeMember"
      use:enhance={() => {
        removingSubmit = true;
        return async ({ result }) => {
          removingSubmit = false;
          if (result.type === 'success') {
            removeOpen = false;
            toast.success('Removed from the group.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <input type="hidden" name="identity_id" value={removing?.identityId ?? ''} />
      <AlertDialog.Header>
        <AlertDialog.Title>Remove from {groupSlug}</AlertDialog.Title>
        <AlertDialog.Description>
          {removing
            ? `${removing.displayName ?? removing.subject} loses every role this group confers.`
            : ''}
          It takes effect on their next request — there is no cached snapshot for a revocation to
          be missing from. Any role they hold from a direct grant or another group is untouched.
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button
          type="submit"
          class={buttonVariants({ variant: 'destructive' })}
          disabled={removingSubmit}
        >
          {removingSubmit ? 'Removing…' : 'Remove'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
