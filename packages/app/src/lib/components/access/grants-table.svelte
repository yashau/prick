<script lang="ts">
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import UserIcon from '@lucide/svelte/icons/user';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { GrantRecord, IdentityRecord } from '$lib/client/api';
  import { expiryLabel } from '$lib/client/format';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';

  let {
    grants,
    identities,
    /** Where the revoke action posts. Differs between the two access screens. */
    action = '?/revokeGrant',
    emptyTitle = 'No grants yet',
    emptyDescription = 'Nothing confers access here until a grant exists.',
    empty
  }: {
    grants: GrantRecord[];
    identities: IdentityRecord[];
    action?: string;
    emptyTitle?: string;
    emptyDescription?: string;
    empty?: import('svelte').Snippet;
  } = $props();

  let revoking = $state<GrantRecord | null>(null);
  let confirmOpen = $state(false);
  let submitting = $state(false);

  const byId = $derived(new Map(identities.map((identity) => [identity.id, identity])));

  /**
   * The subject is joined onto the grant row server-side, so it is present even
   * when the identity list is narrower than the grant list -- which it can be:
   * the two are gated separately, and a row whose identity is missing here
   * would otherwise render as a bare uuid.
   */
  function subjectOf(grant: GrantRecord): string {
    return grant.subject;
  }

  function nameOf(grant: GrantRecord): string {
    return byId.get(grant.identityId)?.displayName ?? grant.subject;
  }

  function scopeLabel(grant: GrantRecord): string {
    if (grant.scopeType === 'global') return 'Everything';
    if (grant.scopeType === 'project') return grant.projectSlug ?? '—';
    return `${grant.projectSlug}/${grant.environmentSlug}`;
  }

  const isLastGlobalAdmin = $derived.by(() => {
    const admins = grants.filter(
      (grant) => grant.scopeType === 'global' && grant.role === 'admin'
    );
    return (grant: GrantRecord) =>
      admins.length === 1 && admins[0]?.id === grant.id;
  });
</script>

{#if grants.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <ShieldOffIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>{emptyTitle}</Empty.Title>
      <Empty.Description>{emptyDescription}</Empty.Description>
    </Empty.Header>
    {#if empty}
      <Empty.Content>{@render empty()}</Empty.Content>
    {/if}
  </Empty.Root>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">Grants, their scope, role and expiry.</Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Identity</Table.Head>
          <Table.Head class="w-28">Role</Table.Head>
          <Table.Head class="w-56">Scope</Table.Head>
          <Table.Head class="w-44">Expiry</Table.Head>
          <Table.Head class="w-24"><span class="sr-only">Revoke</span></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each grants as grant (grant.id)}
          {@const identity = byId.get(grant.identityId)}
          {@const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now()}
          <Table.Row>
            <Table.Cell>
              <div class="flex items-center gap-2">
                {#if identity?.kind === 'service'}
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        {#snippet child({ props })}
                          <span {...props}><KeyRoundIcon class="size-4" aria-hidden="true" /></span>
                        {/snippet}
                      </Tooltip.Trigger>
                      <Tooltip.Content>Service token</Tooltip.Content>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                {:else}
                  <UserIcon class="size-4" aria-hidden="true" />
                {/if}
                <div class="min-w-0">
                  <div class="truncate font-medium">{nameOf(grant)}</div>
                  <div class="text-muted-foreground truncate font-mono text-xs">
                    {subjectOf(grant)}
                  </div>
                </div>
                {#if identity?.disabled}
                  <Badge variant="destructive">disabled</Badge>
                {/if}
              </div>
            </Table.Cell>

            <Table.Cell>
              <!-- The role word is always present; the variant only reinforces it. -->
              <Badge variant={grant.role === 'admin' ? 'default' : 'secondary'}>
                {grant.role}
              </Badge>
            </Table.Cell>

            <Table.Cell>
              <span class="flex items-center gap-1.5 text-sm">
                {#if grant.scopeType === 'global'}
                  <GlobeIcon class="size-3.5" aria-hidden="true" />
                {:else if grant.scopeType === 'project'}
                  <FolderIcon class="size-3.5" aria-hidden="true" />
                {:else}
                  <LayersIcon class="size-3.5" aria-hidden="true" />
                {/if}
                <span class="font-mono">{scopeLabel(grant)}</span>
              </span>
            </Table.Cell>

            <Table.Cell>
              <span class="text-sm {expired ? 'text-destructive' : 'text-muted-foreground'}">
                {expiryLabel(grant.expiresAt)}
              </span>
            </Table.Cell>

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
                <span class="sr-only">{grant.role} for {subjectOf(grant)}</span>
              </Button>
            </Table.Cell>
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
      {action}
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
          {revoking ? `${nameOf(revoking)} loses ${revoking.role} on ${scopeLabel(revoking)}.` : ''}
          Access is resolved per request, so this takes effect on their next call — including a
          CI job that is mid-run.
          {#if revoking && isLastGlobalAdmin(revoking)}
            <span class="text-destructive mt-2 block font-medium">
              This is the last global admin grant. If BOOTSTRAP_ADMINS is also empty, removing it
              locks everyone out permanently — there is no recovery credential by design. The
              server will refuse it.
            </span>
          {/if}
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button type="submit" class={buttonVariants({ variant: 'destructive' })} disabled={submitting}>
          {submitting ? 'Revoking…' : 'Revoke'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
