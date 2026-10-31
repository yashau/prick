<script lang="ts">
  import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
  import KeySquareIcon from '@lucide/svelte/icons/key-square';
  import LockIcon from '@lucide/svelte/icons/lock';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import {
    api,
    type IssuedServiceToken,
    type RotatedServiceToken,
    type ServiceTokenList,
    type ServiceTokenRecord
  } from '#lib/client/api.js';
  import { ApiError, toApiError } from '#lib/client/errors.js';
  import { pluralise } from '#lib/client/format.js';
  import CopyButton from '#lib/components/copy-button.svelte';
  import PageHeader from '#lib/components/page-header.svelte';
  import CreateServiceTokenDialog from '#lib/components/service-tokens/create-service-token-dialog.svelte';
  import ReconcileDialog from '#lib/components/service-tokens/reconcile-dialog.svelte';
  import RotateServiceTokenDialog from '#lib/components/service-tokens/rotate-service-token-dialog.svelte';
  import SecretRevealDialog from '#lib/components/service-tokens/secret-reveal-dialog.svelte';
  import ServiceTokensTable from '#lib/components/service-tokens/service-tokens-table.svelte';
  import type { OneTimeSecret } from '#lib/components/service-tokens/types.js';
  import * as Alert from '#lib/components/ui/alert/index.js';
  import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
  import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
  import * as Empty from '#lib/components/ui/empty/index.js';
  import { Label } from '#lib/components/ui/label/index.js';
  import { Switch } from '#lib/components/ui/switch/index.js';
  import TableSkeleton from '#lib/components/secrets/table-skeleton.svelte';
  import type { PageData } from './$types';

  /**
   * Cloudflare Access service tokens, created and managed by this Worker.
   *
   * Client-rendered (see `+layout.ts`): the list and every mutation are
   * `fetch`es to `/api/v1/service-tokens`, which are global admin only. The one
   * secret this screen ever holds is `secret` below -- component state, handed
   * to the reveal panel and set back to `null` when the panel closes.
   *
   * The capability from the `(app)` layout decides what renders before any
   * request is made: the screen for a viewer the server allows, the server's
   * configuration hint for a global administrator on a Worker without a
   * Cloudflare API token, and a plain explanation for everyone else.
   */

  let { data }: { data: PageData } = $props();

  const capability = $derived(data.serviceTokens);

  let list = $state<ServiceTokenList | null>(null);
  let loading = $state(false);
  let loadError = $state<ApiError | null>(null);
  let showRevoked = $state(false);

  /** The ONLY place a client secret is held. See `SecretRevealDialog`. */
  let secret = $state<OneTimeSecret | null>(null);

  let rotating = $state<ServiceTokenRecord | null>(null);
  let revoking = $state<ServiceTokenRecord | null>(null);
  let revokeOpen = $state(false);
  let revokeBusy = $state(false);

  const revokedCount = $derived(
    list?.tokens.filter((token) => token.status === 'revoked').length ?? 0
  );
  const visible = $derived(
    (list?.tokens ?? []).filter((token) => showRevoked || token.status !== 'revoked')
  );

  async function load() {
    loading = true;
    try {
      list = await api.listServiceTokens();
      loadError = null;
    } catch (error) {
      loadError = toApiError(error);
    } finally {
      loading = false;
    }
  }

  /** The first fetch, once the server has said this viewer may make it. */
  $effect(() => {
    if (capability.allowed) void load();
  });

  function labelOf(token: ServiceTokenRecord): string {
    return token.name ?? token.clientId;
  }

  function describe(error: unknown): string {
    const failed = toApiError(error);
    return [failed.message, failed.hint, failed.requestId ? `(request ${failed.requestId})` : null]
      .filter(Boolean)
      .join(' ');
  }

  function issued(result: IssuedServiceToken) {
    secret = {
      kind: 'created',
      label: labelOf(result.token),
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      previousSecretExpiresAt: null
    };
    void load();
  }

  function rotated(result: RotatedServiceToken) {
    secret = {
      kind: 'rotated',
      label: labelOf(result.token),
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      previousSecretExpiresAt: result.previousSecretExpiresAt
    };
    void load();
  }

  async function refresh(token: ServiceTokenRecord) {
    try {
      await api.refreshServiceToken(token.id);
      toast.success(`Extended the expiry of ${labelOf(token)}.`);
      await load();
    } catch (error) {
      toast.error('Extending the expiry failed', { description: describe(error) });
    }
  }

  function askRevoke(token: ServiceTokenRecord) {
    revoking = token;
    revokeOpen = true;
  }

  async function confirmRevoke() {
    if (revoking === null) return;
    revokeBusy = true;
    try {
      await api.revokeServiceToken(revoking.id);
      toast.success(`Revoked ${labelOf(revoking)}.`);
      revokeOpen = false;
      revoking = null;
    } catch (error) {
      toast.error('Revoking failed', { description: describe(error) });
    } finally {
      revokeBusy = false;
      await load();
    }
  }
</script>

<svelte:head>
  <title>Service tokens · prick</title>
</svelte:head>

<PageHeader
  title="Service tokens"
  description="Cloudflare Access service tokens for CI jobs and servers, issued and revoked from here. Each one is an identity that holds grants like any other."
>
  {#snippet actions()}
    {#if capability.allowed}
      <ReconcileDialog onApplied={load} />
      <CreateServiceTokenDialog projects={data.projects} onIssued={issued} />
    {/if}
  {/snippet}
</PageHeader>

{#if !capability.allowed}
  {#if capability.hint}
    <Alert.Root data-testid="service-tokens-unconfigured">
      <TriangleAlertIcon aria-hidden="true" />
      <Alert.Title>This Worker cannot manage service tokens yet</Alert.Title>
      <Alert.Description>
        <p>{capability.hint}</p>
        <p>
          The API token needs the account permission
          <span class="font-medium">Access: Service Tokens Write</span> and nothing more.
        </p>
      </Alert.Description>
    </Alert.Root>
  {:else}
    <Empty.Root class="border">
      <Empty.Header>
        <Empty.Media variant="icon">
          <LockIcon aria-hidden="true" />
        </Empty.Media>
        <Empty.Title>Service tokens are managed by global administrators</Empty.Title>
        <Empty.Description>
          Ask a global administrator to create a token, or to grant one you already use from the
          access screen.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {/if}
{:else}
  {#if loadError}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <Alert.Title>The token list did not load</Alert.Title>
      <Alert.Description>
        <p>{loadError.message}{loadError.hint ? ` ${loadError.hint}` : ''}</p>
        {#if loadError.requestId}
          <p class="flex items-center gap-1">
            Request <code class="font-mono text-xs">{loadError.requestId}</code>
            <CopyButton text={loadError.requestId} label="Copy request id" size="icon-xs" />
          </p>
        {/if}
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if list?.cloudflare === 'unavailable'}
    <Alert.Root data-testid="service-tokens-cloudflare-unavailable">
      <CloudOffIcon aria-hidden="true" />
      <Alert.Title>Cloudflare could not be reached</Alert.Title>
      <Alert.Description>
        These are prick's own records. Expiry, last use and leak reports come from Cloudflare and
        appear once it answers again.
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if list === null && loading}
    <TableSkeleton />
  {:else if list !== null}
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2">
        <Switch id="show-revoked" bind:checked={showRevoked} />
        <Label for="show-revoked">Show revoked ({revokedCount})</Label>
      </div>
      <span class="text-muted-foreground text-xs">{pluralise(visible.length, 'token')} shown</span>
      <Button variant="ghost" size="sm" class="ml-auto" onclick={load} disabled={loading}>
        <RefreshCwIcon class={loading ? 'animate-spin' : undefined} aria-hidden="true" />
        Reload
      </Button>
    </div>

    <ServiceTokensTable
      tokens={visible}
      onRotate={(token) => (rotating = token)}
      onRefresh={refresh}
      onRevoke={askRevoke}
    >
      {#snippet empty()}
        <CreateServiceTokenDialog projects={data.projects} onIssued={issued} />
      {/snippet}
    </ServiceTokensTable>
  {/if}
{/if}

<RotateServiceTokenDialog bind:token={rotating} onRotated={rotated} />
<SecretRevealDialog bind:secret />

<AlertDialog.Root bind:open={revokeOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title class="flex items-center gap-2">
        <KeySquareIcon class="text-destructive size-4" aria-hidden="true" />
        Revoke {revoking ? labelOf(revoking) : 'this token'}
      </AlertDialog.Title>
      <AlertDialog.Description>
        <span class="block">
          The token's identity is disabled the moment this commits, which outranks every grant it
          holds, and Cloudflare then deletes the token. Any job still using it is refused on its
          next request.
        </span>
        <span class="mt-2 block">
          Its grants stay on record as what it held. A revoked token cannot be brought back; issue
          a new one instead.
        </span>
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
      <button
        type="button"
        class={buttonVariants({ variant: 'destructive' })}
        disabled={revokeBusy}
        onclick={confirmRevoke}
      >
        {revokeBusy ? 'Revoking…' : 'Revoke'}
      </button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
