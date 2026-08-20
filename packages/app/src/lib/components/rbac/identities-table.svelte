<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import UserIcon from '@lucide/svelte/icons/user';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import IdentityCell from '$lib/components/rbac/identity-cell.svelte';
  import type { GroupRefView, IdentityView } from '$lib/components/rbac/types';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * Every identity that has ever authenticated, and what reaches it.
   *
   * THE GROUPS COLUMN IS THE POINT OF THIS TABLE existing alongside the grants
   * one. A direct grant is visible from the grants list; a role that arrives
   * through a group is not, and an operator scanning for "who might have
   * production" off a grants table alone will miss every one of them.
   *
   * The enable switch is rendered only for an actor who can use it. `disabled`
   * is a kill switch that outranks every grant at every scope, so
   * `core.updateIdentity` requires GLOBAL admin — a project admin flipping it
   * would be revoking access to projects they have nothing to do with.
   */

  let {
    identities,
    /** Live direct grants per identity id, as narrowed for this viewer. */
    grantCounts,
    /** Group memberships per identity id. */
    memberships,
    /** Global admin. Anything less renders the state as text, not a control. */
    canManage
  }: {
    identities: IdentityView[];
    grantCounts: Record<string, number>;
    memberships: Record<string, GroupRefView[]>;
    canManage: boolean;
  } = $props();

  /**
   * One form element per row, so flipping a switch submits its own row. A
   * single shared form with a hidden id would be one race away from disabling
   * the wrong identity.
   */
  const forms: Record<string, HTMLFormElement | null> = $state({});
</script>

<div class="rounded-md border">
  <Table.Root>
    <Table.Caption class="sr-only">
      Every identity that has ever authenticated against this install, the groups it belongs to
      and the direct grants it holds.
    </Table.Caption>
    <Table.Header>
      <Table.Row>
        <Table.Head>Identity</Table.Head>
        <Table.Head class="w-24">Kind</Table.Head>
        <Table.Head>Groups</Table.Head>
        <Table.Head class="w-28">Direct grants</Table.Head>
        <Table.Head class="w-40">Last seen</Table.Head>
        <Table.Head class="w-32">Enabled</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each identities as identity (identity.id)}
        <!--
          The whole row opens the identity, via a pseudo-element on the name's
          own anchor rather than a handler on the `<tr>` -- so middle-click,
          ctrl-click, "copy link address" and Enter all keep working, and a
          screen reader still sees one link per row.

          `relative` is what the overlay is positioned against, and the two
          cells carrying their own controls are lifted above it below.
        -->
        <Table.Row class="relative has-[a:focus-visible]:bg-muted/50">
          <Table.Cell>
            <IdentityCell
              kind={identity.kind}
              subject={identity.subject}
              displayName={identity.displayName}
              disabled={identity.disabled}
              href="/users/{identity.id}"
              rowLink
            />
          </Table.Cell>

          <Table.Cell>
            <span class="flex items-center gap-1.5 text-sm">
              {#if identity.kind === 'service'}
                <KeyRoundIcon class="size-3.5" aria-hidden="true" />
                service
              {:else}
                <UserIcon class="size-3.5" aria-hidden="true" />
                user
              {/if}
            </span>
          </Table.Cell>

          <!-- Above the overlay: each badge is its own link to a group. -->
          <Table.Cell class="relative z-10">
            {#if (memberships[identity.id] ?? []).length === 0}
              <span class="text-muted-foreground text-sm">—</span>
            {:else}
              <span class="flex flex-wrap gap-1">
                {#each memberships[identity.id] ?? [] as group (group.id)}
                  <a href="/groups/{group.id}" class="rounded-sm">
                    <Badge variant="outline" class="font-mono">{group.slug}</Badge>
                  </a>
                {/each}
              </span>
            {/if}
          </Table.Cell>

          <Table.Cell>
            <span class="text-sm">{grantCounts[identity.id] ?? 0}</span>
          </Table.Cell>

          <Table.Cell>
            {#if identity.lastSeenAt}
              <time
                class="text-sm"
                datetime={new Date(identity.lastSeenAt).toISOString()}
                title={absoluteTime(identity.lastSeenAt)}
              >
                {relativeTime(identity.lastSeenAt)}
              </time>
            {:else}
              <span class="text-muted-foreground text-sm">Never</span>
            {/if}
          </Table.Cell>

          <!-- Above the overlay: the kill switch must never be a row click. -->
          <Table.Cell class="relative z-10">
            {#if canManage}
              <form
                bind:this={forms[identity.id]}
                method="POST"
                action="?/updateIdentity"
                use:enhance={() => {
                  return async ({ result }) => {
                    if (result.type === 'success') {
                      toast.success('Identity updated.');
                      await invalidateAll();
                      return;
                    }
                    await applyAction(result);
                  };
                }}
              >
                <input type="hidden" name="identity_id" value={identity.id} />
                <input
                  type="hidden"
                  name="disabled"
                  value={identity.disabled ? 'false' : 'true'}
                />
                <div class="flex items-center gap-2">
                  <Switch
                    checked={!identity.disabled}
                    aria-label="{identity.disabled ? 'Enable' : 'Disable'} {identity.subject}"
                    onCheckedChange={() => forms[identity.id]?.requestSubmit()}
                  />
                  <!-- The state is spelled out, never left to the toggle's position alone. -->
                  <span class="text-muted-foreground text-xs">
                    {identity.disabled ? 'Disabled' : 'Enabled'}
                  </span>
                </div>
              </form>
            {:else}
              <span class="text-muted-foreground text-xs">
                {identity.disabled ? 'Disabled' : 'Enabled'}
              </span>
            {/if}
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>
