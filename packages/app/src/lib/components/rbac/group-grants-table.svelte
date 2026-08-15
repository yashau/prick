<script lang="ts">
  import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { expiryLabel } from '$lib/client/format';
  import RoleBadge from '$lib/components/rbac/role-badge.svelte';
  import ScopeLabel from '$lib/components/rbac/scope-label.svelte';
  import type { GroupGrantView } from '$lib/components/rbac/types';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * The grants one group holds.
   *
   * EVERY ROW HERE IS REVOCABLE BY WHOEVER CAN SEE IT, and that is not an
   * assumption this component makes — it is a property of `listGroupGrants`,
   * which narrows per row to the scopes the caller administers, and of
   * `revokeGroupGrant`, which asserts admin at that same scope. The two use the
   * same rule, so a Revoke button on a listed row cannot be a button that 403s.
   *
   * A memberless group holding grants is not an error and is not warned about
   * here; a grant-less group is, because that is the state where an operator
   * has written down a roster and believes they have granted something.
   */

  let {
    grants,
    /** Named in the confirmation copy. */
    groupSlug,
    memberCount,
    /** False when this actor administers no scope any listed grant sits at. */
    canRevoke = true
  }: {
    grants: GroupGrantView[];
    groupSlug: string;
    memberCount: number;
    canRevoke?: boolean;
  } = $props();

  let revoking = $state<GroupGrantView | null>(null);
  let confirmOpen = $state(false);
  let submitting = $state(false);

  function scopeText(grant: GroupGrantView): string {
    if (grant.scopeType === 'global') return 'everything in this install';
    if (grant.scopeType === 'project') return `project ${grant.projectSlug ?? '—'}`;
    return `${grant.projectSlug ?? '—'}/${grant.environmentSlug ?? '—'}`;
  }
</script>

{#if grants.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <ShieldOffIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>This group confers nothing</Empty.Title>
      <Empty.Description>
        Membership alone is not a permission. Until this group holds a grant it is a list of
        names, and its {memberCount === 1 ? 'member' : 'members'} gain nothing by being on it.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">
        The grants held by {groupSlug}, and the scope each one applies to.
      </Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-28">Role</Table.Head>
          <Table.Head>Scope</Table.Head>
          <Table.Head class="w-44">Expiry</Table.Head>
          {#if canRevoke}
            <Table.Head class="w-28"><span class="sr-only">Revoke</span></Table.Head>
          {/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each grants as grant (grant.id)}
          <Table.Row>
            <Table.Cell><RoleBadge role={grant.role} /></Table.Cell>
            <Table.Cell>
              <ScopeLabel
                scopeType={grant.scopeType}
                projectSlug={grant.projectSlug}
                environmentSlug={grant.environmentSlug}
              />
            </Table.Cell>
            <Table.Cell>
              <span class="text-muted-foreground text-sm">{expiryLabel(grant.expiresAt)}</span>
            </Table.Cell>
            {#if canRevoke}
              <Table.Cell>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => {
                    revoking = grant;
                    confirmOpen = true;
                  }}
                >
                  Revoke
                  <span class="sr-only">{grant.role} on {scopeText(grant)}</span>
                </Button>
              </Table.Cell>
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <form
      method="POST"
      action="?/revokeGrant"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            confirmOpen = false;
            toast.success('Grant revoked.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <input type="hidden" name="grant_id" value={revoking?.id ?? ''} />
      <AlertDialog.Header>
        <AlertDialog.Title>Revoke this grant</AlertDialog.Title>
        <AlertDialog.Description>
          {revoking
            ? `Every member of ${groupSlug} loses ${revoking.role} on ${scopeText(revoking)} — that is ${memberCount === 1 ? '1 identity' : `${String(memberCount)} identities`}, unless a direct grant or another group already gave them the same reach.`
            : ''}
          Access is resolved per request, so this takes effect on their next call — including a
          CI job that is mid-run.
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button
          type="submit"
          class={buttonVariants({ variant: 'destructive' })}
          disabled={submitting}
        >
          {submitting ? 'Revoking…' : 'Revoke'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
