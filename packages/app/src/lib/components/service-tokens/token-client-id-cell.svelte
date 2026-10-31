<script lang="ts">
  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import CopyButton from '#lib/components/copy-button.svelte';

  let { token }: { token: ServiceTokenRecord } = $props();
</script>

<div class="flex items-center gap-1">
  <code class="font-mono text-xs break-all">{token.clientId}</code>
  <CopyButton text={token.clientId} label="Copy client id" size="icon-xs" />
</div>
