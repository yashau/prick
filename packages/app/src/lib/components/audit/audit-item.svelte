<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import UserIcon from '@lucide/svelte/icons/user';

  import type { AuditEntryView } from '$lib/client/api';
  import { actionLabel, summariseDetail } from '$lib/client/audit';
  import { absoluteTime, relativeTime } from '$lib/client/format';
  import CopyButton from '$lib/components/copy-button.svelte';
  import OutcomeBadge from '$lib/components/audit/outcome-badge.svelte';
  import * as Item from '$lib/components/ui/item/index.js';

  let { entry }: { entry: AuditEntryView } = $props();

  const summary = $derived(summariseDetail(entry));
</script>

<!--
  `role="listitem"` because every use of this component is a direct child of an
  `Item.Group`, and the registry's group is a `div role="list"`.

  Without it the group owns whatever interactive element happens to be nearest --
  the copy-the-request-id button -- and a `list` whose children are `button`s is
  a real defect, not a lint: a screen reader announces the feed's length and then
  cannot step through it. The role belongs here rather than on the group's
  children generically, because THIS component is the thing that is always in a
  list; `Item.Root` on its own is not.
-->
<Item.Root variant="outline" role="listitem">
  <Item.Media variant="icon">
    {#if entry.actorKind === 'service'}
      <KeyRoundIcon aria-hidden="true" />
      <span class="sr-only">service token</span>
    {:else}
      <UserIcon aria-hidden="true" />
      <span class="sr-only">user</span>
    {/if}
  </Item.Media>

  <Item.Content>
    <Item.Title class="flex flex-wrap items-center gap-2">
      {actionLabel(entry.action)}
      <OutcomeBadge outcome={entry.outcome} />
    </Item.Title>
    <Item.Description>
      <span class="font-mono text-xs break-all">{entry.actorSubject}</span>
      {#if summary}
        <span aria-hidden="true"> · </span>
        <span>{summary}</span>
      {/if}
    </Item.Description>
  </Item.Content>

  <Item.Actions class="items-end gap-1">
    <time
      class="text-muted-foreground text-xs"
      datetime={new Date(entry.ts).toISOString()}
      title={absoluteTime(entry.ts)}
    >
      {relativeTime(entry.ts)}
    </time>
    {#if entry.requestId}
      <span class="flex items-center gap-1">
        <code class="text-muted-foreground font-mono text-[0.7rem]">{entry.requestId}</code>
        <CopyButton text={entry.requestId} label="Copy request id" size="icon-xs" />
      </span>
    {/if}
  </Item.Actions>
</Item.Root>
