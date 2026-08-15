<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import UsersIcon from '@lucide/svelte/icons/users';

  import type { FormErrors } from '$lib/client/forms';
  import GrantsTable from '$lib/components/access/grants-table.svelte';
  import GrantDialog from '$lib/components/rbac/grant-dialog.svelte';
  import IdentitiesTable from '$lib/components/rbac/identities-table.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});

  /** True when at least one scope is grantable. See `AdminScopes`. */
  const canGrant = $derived(data.scopes.global || data.scopes.projects.length > 0);

  /**
   * Which tab is open, held here and bound.
   *
   * `value="identities"` without `bind:` would hand the primitive a prop it
   * cannot write back through, and every re-render of this page — one follows
   * each `invalidateAll()` — would reset the selection to the default. State
   * that the user owns has to live somewhere the user's change survives.
   */
  let tab = $state('identities');
</script>

<svelte:head>
  <title>Users · prick</title>
</svelte:head>

<PageHeader
  title="Users"
  description="Every identity Cloudflare Access has ever presented, the groups it belongs to, and the roles that follow."
>
  {#snippet actions()}
    {#if canGrant}
      <GrantDialog scopes={data.scopes} identities={data.identities} holder="an identity" />
    {/if}
  {/snippet}
</PageHeader>

{#if formError.form}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>That did not go through</Alert.Title>
    <Alert.Description>{formError.form}</Alert.Description>
  </Alert.Root>
{/if}

<Tabs.Root bind:value={tab}>
  <Tabs.List>
    <Tabs.Trigger value="identities" class="gap-2">
      Identities
      <Badge variant="outline">{data.identities.length}</Badge>
    </Tabs.Trigger>
    <Tabs.Trigger value="grants" class="gap-2">
      Direct grants
      <Badge variant="outline">{data.grants.length}</Badge>
    </Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="identities" class="mt-4">
    <IdentitiesTable
      identities={data.identities}
      grantCounts={data.grantCounts}
      memberships={data.memberships}
      canManage={data.scopes.global}
    />
  </Tabs.Content>

  <Tabs.Content value="grants" class="mt-4 space-y-4">
    <!--
      The caveat is the whole reason the permissions screen exists.

      This tab lists DIRECT grants — rows in `grants`, held by an identity.
      A group's grants live in `group_grants` and are not here, so "who can read
      production" is not a question this table can answer on its own, and an
      operator who treats it as complete will miss every role that arrives
      through a group.
    -->
    <Alert.Root>
      <UsersIcon aria-hidden="true" />
      <Alert.Title>This is not the whole access graph</Alert.Title>
      <Alert.Description>
        These are grants held directly by an identity. A role can also arrive through a
        <a class="underline underline-offset-4" href="/groups">group</a>, or from
        <code class="font-mono text-xs">BOOTSTRAP_ADMINS</code>, and neither appears here. To see
        everything that reaches one identity — and which source decided its role — open that
        identity and read its effective permissions.
      </Alert.Description>
    </Alert.Root>

    <GrantsTable
      grants={data.grants}
      identities={data.identities}
      emptyTitle="No direct grants are visible to you"
      emptyDescription="Either none exist, or every one that does sits at a scope you do not administer. Roles conferred by a group are listed on the group, not here."
    />
  </Tabs.Content>
</Tabs.Root>
