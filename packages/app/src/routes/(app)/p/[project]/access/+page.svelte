<script lang="ts">
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  import type { FormErrors } from '$lib/client/forms';
  import GrantDialog from '$lib/components/access/grant-dialog.svelte';
  import GrantsTable from '$lib/components/access/grants-table.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<svelte:head>
  <title>Access · {data.project.name} · prick</title>
</svelte:head>

<PageHeader
  title="Access to {data.project.name}"
  description="Grants scoped to this project and to environments inside it."
>
  {#snippet actions()}
    <GrantDialog
      identities={data.identities}
      projects={data.projects}
      lockedProject={data.project.slug}
      errors={formError}
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

<GrantsTable
  grants={data.grants}
  identities={data.identities}
  emptyTitle="Nobody is scoped to {data.project.name}"
  emptyDescription="Only global grants reach this project right now. Add a project- or environment-scoped grant to give someone narrower access."
/>

{#if data.globalGrants.length > 0}
  <section class="space-y-2">
    <h2 class="flex items-center gap-2 text-sm font-medium">
      <GlobeIcon class="size-4" aria-hidden="true" />
      Also reaching this project
      <Badge variant="outline">{data.globalGrants.length} global</Badge>
    </h2>
    <p class="text-muted-foreground text-sm">
      These are install-wide and are not this project's to revoke. Effective access is the highest
      role across every matching grant, so a global writer keeps write access here regardless of
      what is set above.
    </p>
    <ul class="text-muted-foreground space-y-1 text-sm">
      {#each data.globalGrants as grant (grant.id)}
        {@const identity = data.identities.find((entry) => entry.id === grant.identityId)}
        <li class="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{grant.role}</Badge>
          <code class="font-mono text-xs break-all">
            {identity?.subject ?? grant.identityId}
          </code>
        </li>
      {/each}
    </ul>
    <a class="text-sm underline underline-offset-4" href="/access">Manage install-wide access</a>
  </section>
{/if}
