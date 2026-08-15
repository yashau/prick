<script lang="ts">
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { api, type VersionEntry } from '$lib/client/api';
  import { ApiError, toApiError } from '$lib/client/errors';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { buttonVariants, Button } from '$lib/components/ui/button/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * One key's version history, with rollback.
   *
   * Fetched lazily when the accordion item opens: an environment with 200 keys
   * would otherwise issue 200 requests to render a page nobody has expanded.
   */

  let {
    controller,
    secretKey
  }: {
    controller: SecretsController;
    secretKey: string;
  } = $props();

  let versions = $state<VersionEntry[]>([]);
  let loading = $state(true);
  let error = $state<ApiError | null>(null);

  let target = $state<VersionEntry | null>(null);
  let confirmOpen = $state(false);
  let reason = $state('');
  let rolling = $state(false);

  const current = $derived(versions.find((entry) => !entry.deleted)?.version ?? 0);

  // Fetching is a genuine side effect and re-runs if the key changes.
  $effect(() => {
    let cancelled = false;
    loading = true;
    error = null;

    api
      .listVersions(controller.project, controller.environment, secretKey)
      .then((rows) => {
        if (!cancelled) versions = rows;
      })
      .catch((cause: unknown) => {
        if (!cancelled) error = toApiError(cause);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  async function rollback() {
    if (!target) return;
    rolling = true;
    try {
      await controller.rollback(secretKey, target.version, reason || undefined);
      toast.success(`${secretKey} rolled back to version ${target.version}.`);
      confirmOpen = false;
      reason = '';
      versions = await api.listVersions(controller.project, controller.environment, secretKey);
    } catch (cause) {
      const failure = toApiError(cause);
      toast.error(`Could not roll back ${secretKey}`, {
        description: failure.requestId
          ? `${failure.message} (request ${failure.requestId})`
          : failure.message
      });
    } finally {
      rolling = false;
    }
  }
</script>

{#if loading}
  <div class="space-y-2 py-2">
    {#each { length: 3 } as _, index (index)}
      <Skeleton class="h-8 w-full" />
    {/each}
  </div>
{:else if error}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>{error.code}</Alert.Title>
    <Alert.Description>{error.message}</Alert.Description>
  </Alert.Root>
{:else}
  <Table.Root>
    <Table.Caption class="sr-only">Version history for {secretKey}</Table.Caption>
    <Table.Header>
      <Table.Row>
        <Table.Head class="w-20">Version</Table.Head>
        <Table.Head class="w-28">Operation</Table.Head>
        <Table.Head>Who</Table.Head>
        <Table.Head class="w-40">When</Table.Head>
        <Table.Head class="w-40">Key id</Table.Head>
        <Table.Head class="w-28"><span class="sr-only">Rollback</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each versions as entry (entry.version)}
        <Table.Row>
          <Table.Cell class="font-mono">
            v{entry.version}
            {#if entry.version === current}
              <Badge variant="secondary">current</Badge>
            {/if}
          </Table.Cell>
          <Table.Cell>
            <Badge variant={entry.deleted ? 'destructive' : 'outline'}>
              {entry.deleted ? 'deleted' : entry.op}
            </Badge>
          </Table.Cell>
          <Table.Cell class="font-mono text-xs break-all">{entry.createdBy}</Table.Cell>
          <Table.Cell>
            <time
              class="text-xs"
              datetime={new Date(entry.createdAt).toISOString()}
              title={absoluteTime(entry.createdAt)}
            >
              {relativeTime(entry.createdAt)}
            </time>
          </Table.Cell>
          <Table.Cell class="text-muted-foreground font-mono text-xs">
            {entry.kid ?? '—'}
          </Table.Cell>
          <Table.Cell>
            {#if entry.version !== current && !entry.deleted}
              <Button
                variant="outline"
                size="xs"
                onclick={() => {
                  target = entry;
                  confirmOpen = true;
                }}
              >
                <RotateCcwIcon aria-hidden="true" />
                Roll back
                <span class="sr-only">{secretKey} to version {entry.version}</span>
              </Button>
            {/if}
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
{/if}

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Roll {secretKey} back to v{target?.version}</AlertDialog.Title>
      <AlertDialog.Description>
        This does not resurrect the old ciphertext. Version {target?.version} is decrypted and
        re-encrypted as version {current + 1} under fresh authenticated data, so the history stays
        append-only and the old envelope stays exactly where it is. Anything currently deployed
        from this environment will pick up the older value on its next read.
      </AlertDialog.Description>
    </AlertDialog.Header>

    <Field.Field class="py-2">
      <Field.Label for="rollback-reason-{secretKey}">Reason</Field.Label>
      <Input
        id="rollback-reason-{secretKey}"
        bind:value={reason}
        maxlength={512}
        autocomplete="off"
        placeholder="Optional. Recorded verbatim in the audit row."
      />
    </Field.Field>

    <AlertDialog.Footer>
      <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
      <button
        type="button"
        class={buttonVariants({ variant: 'default' })}
        disabled={rolling}
        onclick={rollback}
      >
        {rolling ? 'Rolling back…' : `Roll back to v${target?.version}`}
      </button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
