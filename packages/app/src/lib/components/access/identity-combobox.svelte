<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import UserIcon from '@lucide/svelte/icons/user';

  import type { IdentityRecord } from '$lib/client/api';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Command from '$lib/components/ui/command/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';

  /**
   * Pick an identity.
   *
   * `combobox` is NOT a registry item -- shadcn-svelte documents it as
   * `popover` + `command`, which is what this is. Nothing about the listbox,
   * the filtering or the keyboard behaviour is written here; it all comes from
   * the `command` component.
   *
   * Searching matters more than usual on this control: a service token's
   * subject is an opaque hex string like
   * `e367826f93b8d71185e03fe518aff3b4.access`, so the display name is often
   * the only thing a human can search by -- and both are matched.
   */

  let {
    identities,
    value = $bindable(''),
    id
  }: {
    identities: IdentityRecord[];
    value?: string;
    id?: string;
  } = $props();

  let open = $state(false);

  const selected = $derived(identities.find((identity) => identity.id === value) ?? null);
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        {id}
        variant="outline"
        role="combobox"
        aria-expanded={open}
        class="w-full justify-between font-normal"
      >
        {#if selected}
          <span class="flex min-w-0 items-center gap-2">
            {#if selected.kind === 'service'}
              <KeyRoundIcon class="size-4 shrink-0" aria-hidden="true" />
            {:else}
              <UserIcon class="size-4 shrink-0" aria-hidden="true" />
            {/if}
            <span class="truncate">{selected.displayName ?? selected.subject}</span>
          </span>
        {:else}
          <span class="text-muted-foreground">Select an identity…</span>
        {/if}
        <ChevronsUpDownIcon class="opacity-50" aria-hidden="true" />
      </Button>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content class="w-(--bits-popover-anchor-width) p-0" align="start">
    <Command.Root>
      <Command.Input placeholder="Search by name or subject…" />
      <Command.List>
        <Command.Empty>No identity matches.</Command.Empty>
        <Command.Group>
          {#each identities as identity (identity.id)}
            <Command.Item
              value={`${identity.displayName ?? ''} ${identity.subject}`}
              onSelect={() => {
                value = identity.id;
                open = false;
              }}
            >
              {#if identity.kind === 'service'}
                <KeyRoundIcon aria-hidden="true" />
              {:else}
                <UserIcon aria-hidden="true" />
              {/if}
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate">{identity.displayName ?? identity.subject}</span>
                <span class="text-muted-foreground truncate font-mono text-xs">
                  {identity.subject}
                </span>
              </span>
              {#if identity.id === value}
                <CheckIcon aria-hidden="true" />
                <span class="sr-only">(selected)</span>
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>

<input type="hidden" name="identity_id" {value} />
