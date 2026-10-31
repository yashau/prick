<script lang="ts">
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { toast } from 'svelte-sonner';

  import { api, type ReconcileEntry, type ReconcileResult } from '#lib/client/api.js';
  import { toApiError } from '#lib/client/errors.js';
  import { pluralise } from '#lib/client/format.js';
  import { Badge } from '#lib/components/ui/badge/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as Empty from '#lib/components/ui/empty/index.js';
  import { Spinner } from '#lib/components/ui/spinner/index.js';
  import * as Table from '#lib/components/ui/table/index.js';

  /**
   * Compare prick's records with Cloudflare's, then repair on request.
   *
   * Opening the dialog runs the comparison with `apply: false`, which changes
   * nothing. The repair is a second, explicit step, and each entry it touches is
   * written to the audit log by the server. Tokens named for another deployment
   * sharing the Cloudflare account are listed and left alone.
   */

  let { onApplied }: { onApplied: () => void } = $props();

  let open = $state(false);
  let checking = $state(false);
  let applying = $state(false);
  let result = $state<ReconcileResult | null>(null);
  let failure = $state<string | null>(null);

  const KIND_LABEL: Record<ReconcileEntry['kind'], string> = {
    orphan: 'In Cloudflare, unknown to prick',
    missing: 'Deleted from Cloudflare',
    revoke_incomplete: 'Revoked, still in Cloudflare',
    foreign: 'Another deployment'
  };

  const KIND_REPAIR: Record<ReconcileEntry['kind'], string> = {
    orphan: 'Delete it from Cloudflare',
    missing: 'Retire the record and disable its identity',
    revoke_incomplete: 'Delete it from Cloudflare',
    foreign: 'Left alone'
  };

  const repairable = $derived(
    result !== null && !result.applied && result.entries.some((entry) => !entry.skipped)
  );

  function describe(error: unknown): string {
    const failed = toApiError(error);
    return [failed.message, failed.hint, failed.requestId ? `(request ${failed.requestId})` : null]
      .filter(Boolean)
      .join(' ');
  }

  async function check() {
    checking = true;
    failure = null;
    result = null;
    try {
      result = await api.reconcileServiceTokens(false);
    } catch (error) {
      failure = describe(error);
    } finally {
      checking = false;
    }
  }

  async function apply() {
    applying = true;
    failure = null;
    try {
      result = await api.reconcileServiceTokens(true);
      const repaired = result.entries.filter((entry) => entry.applied).length;
      toast.success(`Repaired ${pluralise(repaired, 'difference')}.`);
      onApplied();
    } catch (error) {
      failure = describe(error);
    } finally {
      applying = false;
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(next) => {
    if (next) void check();
    else result = null;
  }}
>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline">
        <CloudIcon aria-hidden="true" />
        Check with Cloudflare
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Compare with Cloudflare</Dialog.Title>
      <Dialog.Description>
        Finds tokens prick and Cloudflare disagree about. Checking changes nothing; repairs run
        only when you apply them.
      </Dialog.Description>
    </Dialog.Header>

    {#if checking}
      <div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Spinner class="size-4" />
        Asking Cloudflare…
      </div>
    {:else if result !== null && result.entries.length === 0}
      <Empty.Root>
        <Empty.Header>
          <Empty.Media variant="icon">
            <CircleCheckIcon aria-hidden="true" />
          </Empty.Media>
          <Empty.Title>prick and Cloudflare agree</Empty.Title>
          <Empty.Description>Every managed token matches what Cloudflare holds.</Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else if result !== null}
      <div class="max-h-96 overflow-auto rounded-md border">
        <Table.Root>
          <Table.Caption class="sr-only">Differences between prick and Cloudflare.</Table.Caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Token</Table.Head>
              <Table.Head>Difference</Table.Head>
              <Table.Head>{result.applied ? 'Outcome' : 'Repair'}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each result.entries as entry (entry.cloudflareId)}
              <Table.Row>
                <Table.Cell>
                  <div class="font-medium">{entry.name ?? '—'}</div>
                  <code class="text-muted-foreground font-mono text-xs break-all">
                    {entry.clientId}
                  </code>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={entry.kind === 'foreign' ? 'outline' : 'secondary'}>
                    {KIND_LABEL[entry.kind]}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="text-sm">
                  {#if entry.skipped && entry.kind !== 'foreign'}
                    <span class="text-muted-foreground">Skipped: {entry.reason}</span>
                  {:else if !result.applied}
                    {KIND_REPAIR[entry.kind]}
                  {:else if entry.error}
                    <span class="text-destructive">{entry.error}</span>
                  {:else if entry.applied}
                    Repaired
                  {:else}
                    Left alone
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    {/if}

    {#if failure}
      <p class="text-destructive text-sm" role="alert">{failure}</p>
    {/if}

    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="outline" type="button">Close</Button>
        {/snippet}
      </Dialog.Close>
      {#if repairable}
        <Button onclick={apply} disabled={applying}>
          {#if applying}<Spinner class="size-3" />{/if}
          Apply repairs
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
