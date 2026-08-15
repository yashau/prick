<script lang="ts">
  import ShieldPlusIcon from '@lucide/svelte/icons/shield-plus';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  import type { FormErrors } from '$lib/client/forms';
  import PageHeader from '$lib/components/page-header.svelte';
  import DeleteGroupDialog from '$lib/components/rbac/delete-group-dialog.svelte';
  import GrantDialog from '$lib/components/rbac/grant-dialog.svelte';
  import GroupDetailsForm from '$lib/components/rbac/group-details-form.svelte';
  import GroupGrantsTable from '$lib/components/rbac/group-grants-table.svelte';
  import GroupMembers from '$lib/components/rbac/group-members.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});

  /** Admin at some scope. Granting needs that; it does not need global admin. */
  const canGrant = $derived(data.scopes.global || data.scopes.projects.length > 0);

  /**
   * Which tab is open. Bound rather than passed, so the selection survives the
   * re-render that follows every `invalidateAll()` — adding a member and being
   * bounced back to the grants tab is a small thing that makes a screen feel
   * broken.
   */
  let tab = $state('grants');
</script>

<svelte:head>
  <title>{data.group.name} · Groups · prick</title>
</svelte:head>

<PageHeader title={data.group.name} description={data.group.description ?? undefined}>
  {#snippet actions()}
    {#if canGrant}
      <GrantDialog
        scopes={data.scopes}
        holder="{data.group.name} ({data.group.slug})"
        triggerLabel="Grant to this group"
      />
    {/if}
    {#if data.canManage}
      <DeleteGroupDialog group={data.group} errors={formError} />
    {/if}
  {/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 text-sm">
  <code class="text-muted-foreground font-mono text-xs">{data.group.slug}</code>
  <Badge variant="outline">
    {data.group.memberCount === 1 ? '1 member' : `${String(data.group.memberCount)} members`}
  </Badge>
  <Badge variant={data.group.grantCount === 0 ? 'outline' : 'secondary'}>
    {data.group.grantCount === 0
      ? 'confers nothing'
      : data.group.grantCount === 1
        ? '1 grant'
        : `${String(data.group.grantCount)} grants`}
  </Badge>
</div>

{#if formError.form}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>That did not go through</Alert.Title>
    <Alert.Description>{formError.form}</Alert.Description>
  </Alert.Root>
{/if}

{#if data.group.memberCount > 0 && data.group.grantCount === 0}
  <!--
    The state most worth naming, because it looks like success and is not: a
    roster has been written down and nothing has been granted. Membership alone
    confers nothing, and it is enforced in SQL rather than in a conditional --
    the authorization query reaches `group_grants` through an INNER join, so a
    group with no grants contributes no rows at all.
  -->
  <Alert.Root>
    <ShieldPlusIcon aria-hidden="true" />
    <Alert.Title>This group has members but no grants</Alert.Title>
    <Alert.Description>
      Nobody on the roster gains anything from being on it. Grant the group a role at a scope you
      administer to make the membership mean something.
    </Alert.Description>
  </Alert.Root>
{/if}

<Tabs.Root bind:value={tab}>
  <Tabs.List>
    <Tabs.Trigger value="grants" class="gap-2">
      Grants
      <Badge variant="outline">{data.grants.length}</Badge>
    </Tabs.Trigger>
    <Tabs.Trigger value="members" class="gap-2">
      Members
      <Badge variant="outline">{data.members.length}</Badge>
    </Tabs.Trigger>
    {#if data.canManage}
      <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
    {/if}
  </Tabs.List>

  <Tabs.Content value="grants" class="mt-4 space-y-4">
    {#if data.grants.length < data.group.grantCount}
      <!--
        `listGroupGrants` narrows PER ROW to the scopes the caller administers.
        Being allowed to open this screen is not being allowed to read the whole
        organisation's access graph off a group you happen to be able to grant
        to -- so the count in the header and the rows in the table can honestly
        disagree, and saying so is better than letting it read as a bug.
      -->
      <p class="text-muted-foreground text-sm">
        This group holds {data.group.grantCount} live
        {data.group.grantCount === 1 ? 'grant' : 'grants'}; {data.grants.length} of them
        {data.grants.length === 1 ? 'sits' : 'sit'} at a scope you administer. The rest are not
        yours to read or revoke.
      </p>
    {/if}

    <GroupGrantsTable
      grants={data.grants}
      groupSlug={data.group.slug}
      memberCount={data.group.memberCount}
      canRevoke={canGrant}
    />
  </Tabs.Content>

  <Tabs.Content value="members" class="mt-4 space-y-4">
    <GroupMembers
      members={data.members}
      identities={data.identities}
      groupSlug={data.group.slug}
      canManage={data.canManage}
      errors={formError}
    />
  </Tabs.Content>

  {#if data.canManage}
    <Tabs.Content value="settings" class="mt-4">
      <GroupDetailsForm group={data.group} errors={formError} />
    </Tabs.Content>
  {/if}
</Tabs.Root>
