<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import UserIcon from '@lucide/svelte/icons/user';

  import type { AuditEntryView } from '$lib/client/api';

  let { entry }: { entry: AuditEntryView } = $props();
</script>

<span class="flex items-center gap-1.5">
  {#if entry.actorKind === 'service'}
    <KeyRoundIcon class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="sr-only">Service token</span>
  {:else}
    <UserIcon class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="sr-only">User</span>
  {/if}
  <code class="max-w-56 truncate font-mono text-xs" title={entry.actorSubject}>
    {entry.actorSubject}
  </code>
</span>
