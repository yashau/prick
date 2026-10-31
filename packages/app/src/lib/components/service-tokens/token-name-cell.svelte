<script lang="ts">
  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import { Badge } from '#lib/components/ui/badge/index.js';

  let { token }: { token: ServiceTokenRecord } = $props();
</script>

<div class="min-w-0">
  <div class="flex flex-wrap items-center gap-1.5">
    <span class="truncate font-medium">{token.name ?? token.cloudflareName}</span>
    {#if token.adopted}
      <Badge
        variant="outline"
        title="Made in the Cloudflare dashboard and brought under prick's management."
      >
        adopted
      </Badge>
    {/if}
  </div>
  <a href="/users/{token.identityId}" class="text-muted-foreground text-xs underline-offset-4 hover:underline">
    Identity and grants
  </a>
</div>
