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

  const keyring = $derived(data.keyring);

  /**
   * Rows the server COUNTED under a key that is not the active one.
   *
   * Summed from the entries rather than inferred from `safeToRemoveOldKey`,
   * because the two are not the same statement: the indicator can be false
   * while this is zero -- a stored ciphertext the server could not attribute to
   * any key id does not belong to an entry and cannot be shown in the table,
   * and an unknown must not read as safe. That case gets its own message below
   * rather than a "0 values" sentence that reads like a bug.
   */
  const outstanding = $derived(
    keyring.entries
      .filter((entry) => entry.status !== 'active')
      .reduce((total, entry) => total + entry.rowsRemaining, 0)
  );

  const onActiveKey = $derived(
    keyring.entries.find((entry) => entry.status === 'active')?.rowsRemaining ?? 0
  );

  const total = $derived(onActiveKey + outstanding);
  const migrated = $derived(total === 0 ? 100 : Math.round((onActiveKey / total) * 100));

  /**
   * The action's two numbers, read through a guard rather than a cast.
   *
   * `enhance` types `result.data` as `Record<string, unknown>`, because a form
   * can post to any action. Narrowing here means a change to what the action
   * returns shows up as a wrong toast in review rather than as `undefined rows`
   * on somebody's screen.
   */
  function rekeyMessage(payload: Record<string, unknown> | undefined): string {
    const rekeyed = payload?.['rekeyed'];
    const remaining = payload?.['remaining'];

    if (typeof rekeyed !== 'number' || typeof remaining !== 'number') {
      return 'Rekey page processed.';
    }

    return remaining === 0
      ? `Re-encrypted ${pluralise(rekeyed, 'row')}. Nothing outstanding.`
      : `Re-encrypted ${pluralise(rekeyed, 'row')}; ${remaining.toLocaleString()} still to go.`;
  }
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
  you, and it only goes green at zero -- counted by the server, over the real
  rows, every time this page loads.

  GREEN REQUIRES A KEY TO REMOVE, not just an absence of stranded rows.
  `safeToRemoveOldKey` is a statement about rows, and on an install with no
  MASTER_KEY_OLD and nothing stored it is vacuously true -- no non-active kid
  exists to strand anything. Rendering the green card off that alone told a
  fresh deployment it was safe to remove a secret it never had, over a
  database with nothing in it, which reads as "your rotation finished". It is
  the same sentence in the one state where it means nothing, and this screen
  is the only thing standing between an operator and an unrecoverable delete.
-->
{#if keyring.safeToRemoveOldKey && keyring.oldKeyLoaded}
  <Alert.Root>
    <CircleCheckIcon aria-hidden="true" />
    <Alert.Title>Safe to remove MASTER_KEY_OLD</Alert.Title>
    <Alert.Description>
      {#if total === 0}
        Nothing is stored yet, so no value depends on the previous key. Removing it from the
        Worker's secrets now loses nothing.
      {:else}
        All {total.toLocaleString()} stored
        {total === 1 ? 'value is' : 'values are'} sealed under the active key id
        <code class="font-mono text-xs">{keyring.activeKid}</code>. Removing the previous key from
        the Worker's secrets now loses nothing.
      {/if}
    </Alert.Description>
  </Alert.Root>
{:else if keyring.safeToRemoveOldKey}
  <!--
    No MASTER_KEY_OLD is loaded, so the question this screen exists to answer
    has not been asked yet. Deliberately NOT the green card: there is nothing
    to remove, and "safe to remove" over an empty ring is an answer to a
    question nobody put. Deliberately not destructive either -- nothing is
    wrong. It states the configuration and stops.
  -->
  <Alert.Root>
    <KeyRoundIcon aria-hidden="true" />
    <Alert.Title>No key rotation in progress</Alert.Title>
    <Alert.Description>
      This install carries one key, active id
      <code class="font-mono text-xs">{keyring.activeKid}</code>, and
      <code class="font-mono text-xs">MASTER_KEY_OLD</code> is not set — so there is nothing to
      remove. During a rotation this is where you will be told whether the old key can go.
    </Alert.Description>
  </Alert.Root>
{:else if outstanding > 0}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>Do not remove MASTER_KEY_OLD yet</Alert.Title>
    <Alert.Description>
      {pluralise(outstanding, 'value')} still can only be opened with a retired key. Removing that
      key now would make them permanently undecryptable — there is no recovery path and no backup
      this app can restore from. Let the rekey finish first.
    </Alert.Description>
  </Alert.Root>
{:else}
  <!--
    Nothing is outstanding and it is still not safe. That means the server found
    a stored ciphertext it could not attribute to any key id -- a row this
    application cannot have written, because a value row always carries its kid
    and a deletion carries neither. It belongs to no row of the table below, so
    the only honest thing the screen can do is refuse to go green and say why.
  -->
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>Do not remove MASTER_KEY_OLD yet</Alert.Title>
    <Alert.Description>
      Every key id below reports zero rows, but the server found at least one stored value it
      could not attribute to any key id. A row like that cannot have been written by this
      application, so nothing here can tell you which key protects it. Investigate before removing
      anything.
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
          {#each keyring.entries as entry (entry.kid)}
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
      <!--
        THE OPERATOR DRIVES THIS, AND THE SCREEN SAYS SO.

        Nothing in wrangler.jsonc triggers it. An operator told that a
        background job is working through it would wait for a count that never
        moves, and the thing they are waiting to do safely is delete a key.

        The CLI is named here because pressing a button several hundred times is
        the reason somebody stops half way, and stopping half way is how a
        retired key gets deleted with rows still under it.
      -->
      <p class="text-muted-foreground text-xs">
        You drive this. Each press re-encrypts up to 100 rows in one transaction and reports how
        many are left; press it until nothing is outstanding, or run
        <code>prk keyring rekey --until-done</code> to work through the rest in one go. Ordinary
        writes also move rows onto the active key, so the count falls on its own as secrets are
        updated.
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
              toast.success(rekeyMessage(result.data));
              await invalidateAll();
              return;
            }
            await applyAction(result);
          };
        }}
      >
        <input type="hidden" name="limit" value="100" />
        <!--
          Disabled at zero because there is nothing for it to do — including in
          the unattributed case above, which a rekey cannot fix: a row with no
          key id names no key to move it off.
        -->
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
    {#if data.viewer.bootstrap}
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
