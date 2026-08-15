<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import UserIcon from '@lucide/svelte/icons/user';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { UnknownIdentity } from '$lib/client/api';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import type { FormErrors } from '$lib/client/forms';
  import GrantDialog from '$lib/components/access/grant-dialog.svelte';
  import GrantsTable from '$lib/components/access/grants-table.svelte';
  import UnknownIdentities from '$lib/components/access/unknown-identities.svelte';
  import CopyButton from '$lib/components/copy-button.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let grantOpen = $state(false);
  let presetSubject = $state<string | null>(null);
  let presetKind = $state<'user' | 'service'>('service');

  /**
   * One form element per identity row, so flipping a switch submits its own
   * row. A single shared form with a hidden id would be one race away from
   * disabling the wrong identity.
   */
  const identityForms: Record<string, HTMLFormElement | null> = $state({});

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});

  function grantFor(identity: UnknownIdentity) {
    presetSubject = identity.subject;
    presetKind = identity.kind;
    grantOpen = true;
  }
</script>

<svelte:head>
  <title>Access · prick</title>
</svelte:head>

<PageHeader
  title="Access"
  description="Identity comes from Cloudflare Access. Authorization is these grants, and nothing else."
>
  {#snippet actions()}
    <GrantDialog
      identities={data.identities}
      projects={data.projects}
      errors={formError}
      presetSubject={null}
    />
  {/snippet}
</PageHeader>

{#if formError.form}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>That did not go through</Alert.Title>
    <Alert.Description>{formError.form}</Alert.Description>
  </Alert.Root>
{/if}

<Tabs.Root value={data.unknown.length > 0 ? 'unknown' : 'grants'}>
  <Tabs.List>
    <Tabs.Trigger value="grants">Grants</Tabs.Trigger>
    <Tabs.Trigger value="identities">Identities</Tabs.Trigger>
    <Tabs.Trigger value="unknown" class="gap-2">
      Seen but not granted
      {#if data.unknown.length > 0}
        <Badge variant="destructive">{data.unknown.length}</Badge>
      {/if}
    </Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="grants" class="mt-4">
    <GrantsTable
      grants={data.grants}
      identities={data.identities}
      emptyTitle="No grants exist"
      emptyDescription="While this is empty, the only administrators are the addresses listed in BOOTSTRAP_ADMINS — an authority nothing in this UI can revoke."
    />
  </Tabs.Content>

  <Tabs.Content value="identities" class="mt-4">
    <div class="rounded-md border">
      <Table.Root>
        <Table.Caption class="sr-only">
          Every identity that has ever authenticated against this install.
        </Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Identity</Table.Head>
            <Table.Head class="w-28">Kind</Table.Head>
            <Table.Head class="w-44">Last seen</Table.Head>
            <Table.Head class="w-32">Enabled</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.identities as identity (identity.id)}
            <Table.Row>
              <Table.Cell>
                <div class="font-medium">{identity.displayName ?? '—'}</div>
                <div class="flex items-center gap-1">
                  <code class="text-muted-foreground font-mono text-xs break-all">
                    {identity.subject}
                  </code>
                  <CopyButton text={identity.subject} label="Copy subject" size="icon-xs" />
                </div>
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
              <Table.Cell>
                <form
                  bind:this={identityForms[identity.id]}
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
                  <input type="hidden" name="disabled" value={identity.disabled ? 'false' : 'true'} />
                  <div class="flex items-center gap-2">
                    <Switch
                      checked={!identity.disabled}
                      aria-label="{identity.disabled ? 'Enable' : 'Disable'} {identity.subject}"
                      onCheckedChange={() => identityForms[identity.id]?.requestSubmit()}
                    />
                    <!-- The state is spelled out, never left to the toggle's position alone. -->
                    <span class="text-muted-foreground text-xs">
                      {identity.disabled ? 'Disabled' : 'Enabled'}
                    </span>
                  </div>
                </form>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  </Tabs.Content>

  <Tabs.Content value="unknown" class="mt-4">
    <UnknownIdentities identities={data.unknown} onGrant={grantFor} />
  </Tabs.Content>
</Tabs.Root>

<GrantDialog
  identities={data.identities}
  projects={data.projects}
  errors={formError}
  bind:open={grantOpen}
  {presetSubject}
  {presetKind}
  showTrigger={false}
/>
