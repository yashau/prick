<script lang="ts">
  import LayersIcon from '@lucide/svelte/icons/layers';
  import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { EnvironmentSummary } from '$lib/client/api';
  import AuditItem from '$lib/components/audit/audit-item.svelte';
  import CreateEnvironmentDialog from '$lib/components/environments/create-environment-dialog.svelte';
  import EnvironmentCard from '$lib/components/environments/environment-card.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Item from '$lib/components/ui/item/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let deleting = $state<EnvironmentSummary | null>(null);
  let deleteOpen = $state(false);
  let confirmation = $state('');
  let submitting = $state(false);

  const createErrors = $derived(
    form && 'action' in form && form.action === 'createEnvironment' && 'errors' in form
      ? form.errors
      : {}
  );

  const matches = $derived(deleting !== null && confirmation === deleting.slug);

  function askDelete(environment: EnvironmentSummary) {
    deleting = environment;
    confirmation = '';
    deleteOpen = true;
  }
</script>

<svelte:head>
  <title>{data.project.name} · prick</title>
</svelte:head>

<PageHeader title={data.project.name} description={data.project.description ?? undefined}>
  {#snippet actions()}
    <Button href="/p/{data.project.slug}/settings" variant="outline">
      <SlidersHorizontalIcon aria-hidden="true" />
      Settings
    </Button>
    <CreateEnvironmentDialog errors={createErrors} />
  {/snippet}
</PageHeader>

<Tabs.Root value="environments">
  <Tabs.List>
    <Tabs.Trigger value="environments">Environments</Tabs.Trigger>
    <Tabs.Trigger value="activity">Recent activity</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="environments" class="mt-4">
    {#if data.environments.length === 0}
      <Empty.Root class="border">
        <Empty.Header>
          <Empty.Media variant="icon">
            <LayersIcon aria-hidden="true" />
          </Empty.Media>
          <Empty.Title>No environments in {data.project.name}</Empty.Title>
          <Empty.Description>
            Environments are what secrets belong to and what grants are scoped to. Most projects
            start with production, staging and development.
          </Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <CreateEnvironmentDialog errors={createErrors} />
        </Empty.Content>
      </Empty.Root>
    {:else}
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {#each data.environments as environment (environment.slug)}
          <EnvironmentCard
            project={data.project.slug}
            {environment}
            onDelete={askDelete}
          />
        {/each}
      </div>
    {/if}
  </Tabs.Content>

  <Tabs.Content value="activity" class="mt-4">
    {#if data.activity.length === 0}
      <Empty.Root class="border">
        <Empty.Header>
          <Empty.Title>Nothing recorded yet</Empty.Title>
          <Empty.Description>
            Every mutation writes its audit row inside the same transaction as the data, so this
            list is complete by construction — an un-audited change is not possible.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else}
      <Item.Group class="gap-2">
        {#each data.activity as entry (entry.id)}
          <AuditItem {entry} />
        {/each}
      </Item.Group>
      <div class="mt-4">
        <Button variant="outline" size="sm" href="/audit?project={data.project.slug}">
          Open the full audit log
        </Button>
      </div>
    {/if}
  </Tabs.Content>
</Tabs.Root>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <form
      method="POST"
      action="?/deleteEnvironment"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            deleteOpen = false;
            toast.success(`Deleted ${deleting?.slug}.`);
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <input type="hidden" name="slug" value={deleting?.slug ?? ''} />
      <AlertDialog.Header>
        <AlertDialog.Title class="flex items-center gap-2">
          <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
          Delete {deleting?.name}
        </AlertDialog.Title>
        <AlertDialog.Description>
          Every secret, every version in its history and every grant scoped to this environment
          goes with it, by foreign-key cascade. The ciphertexts are bound to this environment's
          id, so even a database backup restored elsewhere would not decrypt them. There is no
          undo.
        </AlertDialog.Description>
      </AlertDialog.Header>

      <Field.Field class="py-2">
        <Field.Label for="confirm-delete-environment">
          Type <code class="font-mono">{deleting?.slug}</code> to confirm
        </Field.Label>
        <Input
          id="confirm-delete-environment"
          name="confirm"
          bind:value={confirmation}
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
        />
      </Field.Field>

      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
        <button
          type="submit"
          class={buttonVariants({ variant: 'destructive' })}
          disabled={!matches || submitting}
        >
          {submitting ? 'Deleting…' : 'Delete environment'}
        </button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
