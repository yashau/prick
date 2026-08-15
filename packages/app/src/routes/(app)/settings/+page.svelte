<script lang="ts">
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { absoluteTime, pluralise, relativeTime } from '$lib/client/format';
  import PageHeader from '$lib/components/page-header.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import { Progress } from '$lib/components/ui/progress/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let rekeying = $state(false);

  const outstanding = $derived(
    data.keyring.entries
      .filter((entry) => entry.status !== 'active')
      .reduce((total, entry) => total + entry.rowsRemaining, 0)
  );

  const total = $derived(Math.max(outstanding, 1));
  const migrated = $derived(outstanding === 0 ? 100 : 0);
</script>

<svelte:head>
  <title>Settings · prick</title>
</svelte:head>

<PageHeader
  title="Settings"
  description="Key material, rotation state, and how this install is bootstrapped."
/>

<!--
  THE indicator on this screen.

  Removing MASTER_KEY_OLD while any row still references a retired key id is
  the one irreversible mistake this design leaves available: those values can
  never be decrypted again, by anyone, ever. So the UI has to be what tells
  you, and it only goes green at zero.
-->
{#if data.keyring.safeToRemoveOldKey}
  <Alert.Root>
    <CircleCheckIcon aria-hidden="true" />
    <Alert.Title>Safe to remove MASTER_KEY_OLD</Alert.Title>
    <Alert.Description>
      Every stored value is sealed under the active key id
      <code class="font-mono text-xs">{data.keyring.activeKid}</code>. Removing the previous key
      from the Worker's secrets now loses nothing.
    </Alert.Description>
  </Alert.Root>
{:else}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>Do not remove MASTER_KEY_OLD yet</Alert.Title>
    <Alert.Description>
      {pluralise(outstanding, 'value')} still can only be opened with a retired key. Removing that
      key now would make them permanently undecryptable — there is no recovery path and no backup
      this app can restore from. Let the rekey finish first.
    </Alert.Description>
  </Alert.Root>
{/if}

<div class="grid gap-4 lg:grid-cols-3">
  <Card.Root class="lg:col-span-2">
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <KeyRoundIcon class="size-4" aria-hidden="true" />
        Keyring
      </Card.Title>
      <Card.Description>
        A key id is the first eight bytes of an HKDF output over the master key. It is stored in
        every envelope in the clear and is derived rather than configured, so it cannot drift from
        the key it names. An envelope naming an id the ring does not hold fails loudly and says
        which id it wanted.
      </Card.Description>
    </Card.Header>

    <Card.Content>
      <Table.Root>
        <Table.Caption class="sr-only">Key ids known to this install.</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Key id</Table.Head>
            <Table.Head class="w-32">Status</Table.Head>
            <Table.Head class="w-32">Rows left</Table.Head>
            <Table.Head class="w-40">Last rekey</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.keyring.entries as entry (entry.kid)}
            <Table.Row>
              <Table.Cell class="font-mono text-xs">{entry.kid}</Table.Cell>
              <Table.Cell>
                <Badge
                  variant={entry.status === 'active'
                    ? 'secondary'
                    : entry.rowsRemaining > 0
                      ? 'destructive'
                      : 'outline'}
                >
                  {entry.status}
                </Badge>
              </Table.Cell>
              <Table.Cell class="tabular-nums">
                {entry.status === 'active' ? '—' : entry.rowsRemaining.toLocaleString()}
              </Table.Cell>
              <Table.Cell>
                {#if entry.lastRekeyAt}
                  <time
                    class="text-xs"
                    datetime={new Date(entry.lastRekeyAt).toISOString()}
                    title={absoluteTime(entry.lastRekeyAt)}
                  >
                    {relativeTime(entry.lastRekeyAt)}
                  </time>
                {:else}
                  <span class="text-muted-foreground text-xs">Never</span>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <RefreshCwIcon class="size-4" aria-hidden="true" />
        Rekey
      </Card.Title>
      <Card.Description>
        Re-encrypts rows onto the active key under the identical authenticated data. The version
        does not change — a rekey alters the key protecting a row, never the row's identity.
      </Card.Description>
    </Card.Header>

    <Card.Content class="space-y-3">
      <Progress
        value={migrated}
        aria-label={outstanding === 0
          ? 'Rekey complete'
          : `${outstanding} rows still on a retired key`}
      />
      <p class="text-sm">
        {#if outstanding === 0}
          Nothing outstanding.
        {:else}
          {pluralise(outstanding, 'row')} on a retired key, out of {total.toLocaleString()}.
        {/if}
      </p>
      <Separator />
      <p class="text-muted-foreground text-xs">
        A cron trigger works through this in bounded pages so that a large database never needs a
        single long transaction. This button runs one page immediately.
      </p>
    </Card.Content>

    <Card.Footer>
      <form
        method="POST"
        action="?/rekey"
        use:enhance={() => {
          rekeying = true;
          return async ({ result }) => {
            rekeying = false;
            if (result.type === 'success') {
              toast.success('Rekey page processed.');
              await invalidateAll();
              return;
            }
            await applyAction(result);
          };
        }}
      >
        <input type="hidden" name="limit" value="100" />
        <Button type="submit" disabled={rekeying || outstanding === 0}>
          {#if rekeying}<Spinner class="size-3" />{/if}
          {rekeying ? 'Rekeying…' : 'Run one page now'}
        </Button>
      </form>
    </Card.Footer>
  </Card.Root>
</div>

<Card.Root>
  <Card.Header>
    <Card.Title>Bootstrap</Card.Title>
    <Card.Description>
      The first administrator comes from the <code class="font-mono text-xs">BOOTSTRAP_ADMINS</code>
      variable, evaluated live on every request. That is honest rather than convenient: whoever can
      deploy this Worker can already read the master key and decrypt everything, so anchoring the
      first administrator to the same authority adds no exposure and needs no one-time token that
      could leak.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    {#if data.viewer.bootstrapAdmin}
      <Alert.Root>
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>Your access is still implicit</Alert.Title>
        <Alert.Description>
          <code class="font-mono text-xs">{data.viewer.subject}</code> is an administrator because
          of that variable, not because of a grant — which means nothing in this UI can revoke it
          and nothing in the audit log explains it. Create a real global admin grant, confirm it
          works, then remove the variable.
        </Alert.Description>
        <Alert.Action>
          <Button size="sm" href="/access">Open access</Button>
        </Alert.Action>
      </Alert.Root>
    {:else}
      <p class="text-sm">
        Administrator access is conferred entirely by grants. There is no god mode: a global admin
        is a row in the grants table, on the same code path as every other grant, revocable and
        auditable.
      </p>
    {/if}
  </Card.Content>
</Card.Root>
