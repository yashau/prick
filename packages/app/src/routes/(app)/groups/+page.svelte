<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import UsersIcon from '@lucide/svelte/icons/users';

  import { absoluteTime, relativeTime } from '$lib/client/format';
  import type { FormErrors } from '$lib/client/forms';
  import PageHeader from '$lib/components/page-header.svelte';
  import CreateGroupDialog from '$lib/components/rbac/create-group-dialog.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<svelte:head>
  <title>Groups · prick</title>
</svelte:head>

<PageHeader
  title="Groups"
  description="A named set of identities that can hold grants. Effective role is the maximum over an identity's own grants and its groups' — additive, always, with no deny rule."
>
  {#snippet actions()}
    {#if data.canManage}
      <CreateGroupDialog errors={formError} />
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

{#if !data.canManage}
  <!--
    Stated rather than left to be discovered from a 403.

    Membership and the lifecycle of a group need install-wide authority; what a
    group may DO inside a project needs only that project's admin. Splitting
    them costs a project admin nothing they should have had — and joining them
    would let the admin of one project add themselves to a group that reaches
    another, which is a way to grant yourself access.
  -->
  <Alert.Root>
    <UsersIcon aria-hidden="true" />
    <Alert.Title>You can grant to a group, but not change one</Alert.Title>
    <Alert.Description>
      Creating, renaming, deleting a group and changing its membership need an install-wide
      administrator. Granting a group a role inside a scope you administer does not — open a
      group to do that.
    </Alert.Description>
  </Alert.Root>
{/if}

{#if data.groups.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <UsersIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>No groups yet</Empty.Title>
      <Empty.Description>
        A group is worth creating when the same set of people needs the same access in more than
        one place — then revocation is one membership change instead of a hunt through the grants
        table.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">
        Every group, how many identities are on it and how many live grants it holds.
      </Table.Caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Group</Table.Head>
          <Table.Head class="w-28">Members</Table.Head>
          <Table.Head class="w-28">Grants</Table.Head>
          <Table.Head class="w-44">Updated</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.groups as group (group.id)}
          <Table.Row>
            <Table.Cell>
              <div class="min-w-0">
                <div class="font-medium">
                  <a class="underline-offset-4 hover:underline" href="/groups/{group.id}">
                    {group.name}
                  </a>
                </div>
                <div class="text-muted-foreground font-mono text-xs break-all">{group.slug}</div>
                {#if group.description}
                  <p class="text-muted-foreground mt-1 text-sm">{group.description}</p>
                {/if}
              </div>
            </Table.Cell>
            <Table.Cell><span class="text-sm">{group.memberCount}</span></Table.Cell>
            <Table.Cell>
              {#if group.grantCount === 0}
                <!--
                  Not an error, and worth saying out loud: a group with no
                  grants is a list. The failure it prevents is an operator who
                  wrote down a roster and believes they granted something.
                -->
                <Badge variant="outline">confers nothing</Badge>
              {:else}
                <span class="text-sm">{group.grantCount}</span>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <time
                class="text-sm"
                datetime={new Date(group.updatedAt).toISOString()}
                title={absoluteTime(group.updatedAt)}
              >
                {relativeTime(group.updatedAt)}
              </time>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}
