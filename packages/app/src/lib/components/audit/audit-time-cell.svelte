<script lang="ts">
  import type { AuditEntryView } from '$lib/client/api';
  import { absoluteTime, relativeTime } from '$lib/client/format';

  let { entry }: { entry: AuditEntryView } = $props();
</script>

<time
  class="text-xs"
  datetime={new Date(entry.ts).toISOString()}
  title={absoluteTime(entry.ts)}
>
  {relativeTime(entry.ts)}
</time>
