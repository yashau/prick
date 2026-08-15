<script lang="ts">
  import LockIcon from '@lucide/svelte/icons/lock';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  import { page } from '$app/state';
  import { SecretsController } from '$lib/client/secrets.svelte.js';
  import CopyButton from '$lib/components/copy-button.svelte';
  import SecretsTable from '$lib/components/secrets/secrets-table.svelte';
  import TableSkeleton from '$lib/components/secrets/table-skeleton.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';

  /**
   * The secrets table. CLIENT-RENDERED ONLY -- see `+layout.ts` next to this
   * file for why that is a security property and not a performance choice.
   *
   * There is deliberately no `+page.server.ts` here and there must never be
   * one. A load would put data in the payload; an action would put its return
   * value there too. Everything on this screen goes through `fetch`.
   */

  const project = $derived(page.params.project ?? '');
  const environment = $derived(page.params.env ?? '');

  /**
   * One controller per environment.
   *
   * `$derived` rather than an `$effect` that reassigns: navigating from one
   * environment to another must produce a NEW controller, not mutate the old
   * one, so there is no window in which rows from `staging` are on screen
   * under the `production` heading.
   */
  const controller = $derived(new SecretsController(project, environment));

  // Fetching is a genuine side effect. It re-runs when the controller changes,
  // which is exactly the navigation case above.
  $effect(() => {
    void controller.load();
  });
</script>

<svelte:head>
  <title>{environment} · {project} · prick</title>
</svelte:head>

<!--
  Reveals are a visual change with no focus movement, so they are silent to a
  screen reader without this. Polite, not assertive: it must not interrupt.
-->
<div aria-live="polite" class="sr-only">{controller.announcement}</div>

{#if controller.loading}
  <TableSkeleton />
{:else if controller.error}
  {#if controller.error.status === 403}
    <Empty.Root class="border">
      <Empty.Header>
        <Empty.Media variant="icon">
          <LockIcon aria-hidden="true" />
        </Empty.Media>
        <Empty.Title>No grant covers {environment}</Empty.Title>
        <Empty.Description>
          Your grants reach this project but not this environment. An administrator can add an
          environment-scoped grant on the access screen.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button variant="outline" href="/p/{project}/access">Open project access</Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <Alert.Title>{controller.error.code}</Alert.Title>
      <Alert.Description>
        <span class="block">{controller.error.message}</span>
        {#if controller.error.hint}
          <span class="block">{controller.error.hint}</span>
        {/if}
        {#if controller.error.requestId}
          <span class="mt-1 flex items-center gap-1">
            <code class="font-mono text-xs">{controller.error.requestId}</code>
            <CopyButton
              text={controller.error.requestId}
              label="Copy request id"
              size="icon-xs"
            />
          </span>
        {/if}
      </Alert.Description>
      <Alert.Action>
        <Button size="sm" variant="outline" onclick={() => controller.load()}>Retry</Button>
      </Alert.Action>
    </Alert.Root>
  {/if}
{:else}
  <SecretsTable {controller} />
{/if}
