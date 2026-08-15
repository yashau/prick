<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import UserIcon from '@lucide/svelte/icons/user';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { FormErrors } from '$lib/client/forms';
  import GrantsTable from '$lib/components/access/grants-table.svelte';
  import CopyButton from '$lib/components/copy-button.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import AddToGroupDialog from '$lib/components/rbac/add-to-group-dialog.svelte';
  import EffectivePermissions from '$lib/components/rbac/effective-permissions.svelte';
  import GrantDialog from '$lib/components/rbac/grant-dialog.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const formError = $derived<FormErrors>(form && 'errors' in form ? (form.errors ?? {}) : {});

  const identity = $derived(data.permissions.identity);
  const canGrant = $derived(data.scopes.global || data.scopes.projects.length > 0);
  /** Membership, enable/disable and group creation are all global-admin only. */
  const isGlobalAdmin = $derived(data.scopes.global);

  const memberOf = $derived(new Set(data.permissions.groups.map((group) => group.id)));
  const candidates = $derived(data.groups.filter((group) => !memberOf.has(group.id)));

  let togglingIdentity = $state(false);
</script>

<svelte:head>
  <title>{identity.displayName ?? identity.subject} · Users · prick</title>
</svelte:head>

<PageHeader
  title={identity.displayName ?? identity.subject}
  description="Every role this identity holds, and the grant or group that conferred each one."
>
  {#snippet actions()}
    {#if isGlobalAdmin}
      <AddToGroupDialog {candidates} subject={identity.subject} errors={formError} />
    {/if}
    {#if canGrant}
      <GrantDialog
        scopes={data.scopes}
        identity={{
          id: identity.id,
          kind: identity.kind,
          subject: identity.subject,
          displayName: identity.displayName,
          disabled: identity.disabled,
          lastSeenAt: identity.lastSeenAt
        }}
        holder={identity.subject}
      />
    {/if}
  {/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 text-sm">
  <span class="flex items-center gap-1.5">
    {#if identity.kind === 'service'}
      <KeyRoundIcon class="size-3.5" aria-hidden="true" />
      service token
    {:else}
      <UserIcon class="size-3.5" aria-hidden="true" />
      user
    {/if}
  </span>
  <code class="text-muted-foreground font-mono text-xs break-all">{identity.subject}</code>
  <CopyButton text={identity.subject} label="Copy subject" size="icon-xs" />
  {#if identity.disabled}
    <Badge variant="destructive">disabled</Badge>
  {/if}
</div>

{#if formError.form}
  <Alert.Root variant="destructive">
    <TriangleAlertIcon aria-hidden="true" />
    <Alert.Title>That did not go through</Alert.Title>
    <Alert.Description>{formError.form}</Alert.Description>
  </Alert.Root>
{/if}

{#if data.permissions.bootstrap}
  <!--
    The one source an operator cannot find by searching the database. It has no
    row, so it cannot be revoked from any screen in this application.
  -->
  <Alert.Root>
    <TerminalIcon aria-hidden="true" />
    <Alert.Title>This subject is named in BOOTSTRAP_ADMINS</Alert.Title>
    <Alert.Description>
      It holds global admin from a Worker variable rather than from a grant, so nothing here can
      take it away. Create a real global admin grant, then remove the variable and redeploy — a
      grant is revocable and auditable; the variable is neither.
    </Alert.Description>
  </Alert.Root>
{/if}

{#if isGlobalAdmin}
  <form
    method="POST"
    action="?/updateIdentity"
    class="flex flex-wrap items-center gap-3 rounded-md border p-4"
    use:enhance={() => {
      togglingIdentity = true;
      return async ({ result }) => {
        togglingIdentity = false;
        if (result.type === 'success') {
          toast.success('Identity updated.');
          await invalidateAll();
          return;
        }
        await applyAction(result);
      };
    }}
  >
    <input type="hidden" name="disabled" value={identity.disabled ? 'false' : 'true'} />
    <p class="text-muted-foreground flex-1 text-sm">
      {#if identity.disabled}
        This identity is disabled. The kill switch outranks every grant at every scope, so it
        currently holds nothing — including anything its groups confer.
      {:else}
        Disabling is the kill switch: it outranks every grant at every scope, immediately, and
        the grants themselves are left in place.
      {/if}
    </p>
    <Button type="submit" variant={identity.disabled ? 'outline' : 'destructive'} disabled={togglingIdentity}>
      {identity.disabled ? 'Enable identity' : 'Disable identity'}
    </Button>
  </form>
{/if}

<section class="space-y-3">
  <h2 class="text-lg font-semibold tracking-tight">Groups</h2>
  {#if data.permissions.groups.length === 0}
    <p class="text-muted-foreground text-sm">
      Not in any group. Every role below, if there is one, comes from a grant held directly by
      this identity.
    </p>
  {:else}
    <ul class="flex flex-wrap gap-2">
      {#each data.permissions.groups as group (group.id)}
        <li class="flex items-center gap-1 rounded-md border py-1 pr-1 pl-3">
          <a class="text-sm underline-offset-4 hover:underline" href="/groups/{group.id}">
            {group.name}
            <span class="text-muted-foreground font-mono text-xs">({group.slug})</span>
          </a>
          {#if isGlobalAdmin}
            <form
              method="POST"
              action="?/removeFromGroup"
              use:enhance={() => {
                return async ({ result }) => {
                  if (result.type === 'success') {
                    toast.success(`Removed from ${group.slug}.`);
                    await invalidateAll();
                    return;
                  }
                  await applyAction(result);
                };
              }}
            >
              <input type="hidden" name="group_id" value={group.id} />
              <Button type="submit" variant="ghost" size="sm">
                Remove
                <span class="sr-only">{identity.subject} from {group.slug}</span>
              </Button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="text-muted-foreground text-sm">
      A group with no grants confers nothing — being on a roster is not a permission. What each
      one actually hands over is listed under its own grants.
    </p>
  {/if}
</section>

<section class="space-y-3">
  <h2 class="text-lg font-semibold tracking-tight">Effective permissions</h2>
  <p class="text-muted-foreground text-sm">
    One entry per scope some grant names — never the full cross product of projects and
    environments. A global admin is one row saying "global admin", because that is what the
    inheritance rule says and re-materialising it into one row per project would make it harder
    to read, not easier.
  </p>
  <EffectivePermissions
    scopes={data.permissions.scopes}
    subject={identity.subject}
    disabled={identity.disabled}
  />
</section>

<section class="space-y-3">
  <h2 class="text-lg font-semibold tracking-tight">Direct grants</h2>
  <p class="text-muted-foreground text-sm">
    Rows held by this identity alone. Revoking one here does not touch anything it inherits from
    a group.
  </p>
  <GrantsTable
    grants={data.grants}
    identities={[identity]}
    emptyTitle="No direct grants"
    emptyDescription="Any access this identity has arrives through a group, or through BOOTSTRAP_ADMINS, or it has none."
  />
</section>
