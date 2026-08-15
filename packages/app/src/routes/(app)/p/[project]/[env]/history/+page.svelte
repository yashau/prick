<script lang="ts">
  import HistoryIcon from '@lucide/svelte/icons/history';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  import { page } from '$app/state';
  import { api, type AuditEntryView } from '$lib/client/api';
  import { toApiError, type ApiError } from '$lib/client/errors';
  import { SecretsController } from '$lib/client/secrets.svelte.js';
  import AuditItem from '$lib/components/audit/audit-item.svelte';
  import KeyVersions from '$lib/components/history/key-versions.svelte';
  import * as Accordion from '$lib/components/ui/accordion/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Item from '$lib/components/ui/item/index.js';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';

  /**
   * The environment's change feed, and per-key versions with rollback.
   *
   * Inside the `ssr = false` subtree, so it is client-rendered like the table
   * next to it. Nothing here carries a value -- versions are metadata and the
   * feed is audit rows -- but it shares the subtree because rollback is a
   * secret write and belongs on the same side of the boundary as the code that
   * performs it.
   */

  const project = $derived(page.params.project ?? '');
  const environment = $derived(page.params.env ?? '');
  const controller = $derived(new SecretsController(project, environment));

  /** Deep link from the table's row menu: `?key=DATABASE_URL`. */
  const focusKey = $derived(page.url.searchParams.get('key'));

  let feed = $state<AuditEntryView[]>([]);
  let loadingFeed = $state(true);
  let feedError = $state<ApiError | null>(null);
  let expanded = $state<string[]>([]);

  $effect(() => {
    void controller.load();
  });

  $effect(() => {
    let cancelled = false;
    loadingFeed = true;

    api
      .queryAudit({ project, environment, limit: 25 })
      .then((result) => {
        if (!cancelled) feed = result.entries;
      })
      .catch((cause: unknown) => {
        if (!cancelled) feedError = toApiError(cause);
      })
      .finally(() => {
        if (!cancelled) loadingFeed = false;
      });

    return () => {
      cancelled = true;
    };
  });

  /**
   * Opening the deep-linked accordion item is a side effect of arriving with a
   * query parameter, not derived state: the user must be able to close it
   * again without the URL forcing it back open.
   */
  $effect(() => {
    if (focusKey) expanded = [focusKey];
  });
</script>

<svelte:head>
  <title>History · {environment} · {project} · prick</title>
</svelte:head>

<div class="grid gap-6 lg:grid-cols-[2fr_1fr]">
  <section class="space-y-3">
    <h2 class="text-lg font-medium">Versions by key</h2>

    {#if controller.loading}
      <div class="space-y-2">
        {#each { length: 4 } as _, index (index)}
          <Skeleton class="h-12 w-full" />
        {/each}
      </div>
    {:else if controller.error}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>{controller.error.code}</Alert.Title>
        <Alert.Description>{controller.error.message}</Alert.Description>
      </Alert.Root>
    {:else if controller.rows.length === 0}
      <Empty.Root class="border">
        <Empty.Header>
          <Empty.Media variant="icon">
            <HistoryIcon aria-hidden="true" />
          </Empty.Media>
          <Empty.Title>No keys, so no history</Empty.Title>
          <Empty.Description>
            History is keyed by environment and key name, not by row id — deleting a key and
            recreating it continues its version sequence rather than restarting at 1.
          </Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <Button href="/p/{project}/{environment}">Back to secrets</Button>
        </Empty.Content>
      </Empty.Root>
    {:else}
      <Accordion.Root type="multiple" bind:value={expanded} class="rounded-md border px-3">
        {#each controller.rows as row (row.key)}
          <Accordion.Item value={row.key}>
            <Accordion.Trigger>
              <span class="flex flex-wrap items-center gap-2">
                <code class="font-mono text-sm">{row.key}</code>
                <Badge variant="outline" class="font-mono">v{row.version}</Badge>
                {#if row.unreadable}
                  <Badge variant="destructive">cannot decrypt</Badge>
                {/if}
              </span>
            </Accordion.Trigger>
            <Accordion.Content>
              {#if expanded.includes(row.key)}
                <KeyVersions {controller} secretKey={row.key} />
              {/if}
            </Accordion.Content>
          </Accordion.Item>
        {/each}
      </Accordion.Root>
    {/if}
  </section>

  <section class="space-y-3">
    <h2 class="text-lg font-medium">Change feed</h2>

    {#if loadingFeed}
      <div class="space-y-2">
        {#each { length: 6 } as _, index (index)}
          <Skeleton class="h-16 w-full" />
        {/each}
      </div>
    {:else if feedError}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>{feedError.code}</Alert.Title>
        <Alert.Description>{feedError.message}</Alert.Description>
      </Alert.Root>
    {:else if feed.length === 0}
      <Empty.Root class="border">
        <Empty.Header>
          <Empty.Title>Nothing recorded yet</Empty.Title>
          <Empty.Description>
            Every mutation writes its audit row in the same transaction as the data.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else}
      <ScrollArea class="max-h-[70vh] pr-3">
        <Item.Group class="gap-2">
          {#each feed as entry (entry.id)}
            <AuditItem {entry} />
          {/each}
        </Item.Group>
      </ScrollArea>
      <Button
        variant="outline"
        size="sm"
        href="/audit?project={project}&environment={environment}"
      >
        Open the full audit log
      </Button>
    {/if}
  </section>
</div>
