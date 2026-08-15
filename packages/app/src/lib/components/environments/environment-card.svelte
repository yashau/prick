<script lang="ts">
  import HistoryIcon from '@lucide/svelte/icons/history';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import TrashIcon from '@lucide/svelte/icons/trash-2';

  import { ENV_MAX_SECRETS } from '@prick/shared';

  import type { EnvironmentSummary } from '$lib/client/api';
  import { absoluteTime, pluralise, relativeTime } from '$lib/client/format';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as HoverCard from '$lib/components/ui/hover-card/index.js';
  import { Progress } from '$lib/components/ui/progress/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';

  let {
    project,
    environment,
    onDelete
  }: {
    project: string;
    environment: EnvironmentSummary;
    onDelete: (environment: EnvironmentSummary) => void;
  } = $props();

  /**
   * The cap is a correctness constraint, not a quota: a full-environment
   * replace has to fit in ONE D1 `batch()`, because splitting it across
   * batches would forfeit atomicity. Showing the headroom means nobody
   * discovers the ceiling from a 413 in CI.
   */
  const fill = $derived(Math.min(100, (environment.secretCount / ENV_MAX_SECRETS) * 100));
  const nearCap = $derived(environment.secretCount / ENV_MAX_SECRETS >= 0.8);
</script>

<Card.Root class="gap-4">
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <a
        href="/p/{project}/{environment.slug}"
        class="underline-offset-4 hover:underline focus-visible:underline"
      >
        {environment.name}
      </a>
      <HoverCard.Root>
        <HoverCard.Trigger>
          {#snippet child({ props })}
            <Badge {...props} variant="outline" class="font-mono">rev {environment.rev}</Badge>
          {/snippet}
        </HoverCard.Trigger>
        <HoverCard.Content class="w-80 text-sm">
          <p class="font-medium">Revision {environment.rev}</p>
          <p class="text-muted-foreground mt-1">
            Sent back as <code class="font-mono text-xs">expected_rev</code> on a full replace. If
            it has moved on since you loaded the page, the write is refused with a 412 and this
            environment is left byte-for-byte unchanged.
          </p>
          <Separator class="my-2" />
          <dl class="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt>Slug</dt>
            <dd class="font-mono">{environment.slug}</dd>
            <dt>Id</dt>
            <dd class="font-mono break-all">{environment.id}</dd>
          </dl>
        </HoverCard.Content>
      </HoverCard.Root>
    </Card.Title>
    <Card.Description>
      {environment.description ?? `Secrets scoped to ${environment.slug}.`}
    </Card.Description>
  </Card.Header>

  <Card.Content class="space-y-3">
    <div class="flex items-baseline justify-between text-sm">
      <span class="font-medium">{pluralise(environment.secretCount, 'secret')}</span>
      <span class="text-muted-foreground text-xs">
        of {ENV_MAX_SECRETS} max
      </span>
    </div>
    <!--
      Colour is never the only signal: the bar is accompanied by a text label
      that says the same thing in words.
    -->
    <Progress
      value={fill}
      aria-label="{environment.secretCount} of {ENV_MAX_SECRETS} secrets used"
    />
    {#if nearCap}
      <p class="text-destructive text-xs">
        Approaching the per-environment cap. A write past {ENV_MAX_SECRETS} is refused with 413
        rather than split across transactions.
      </p>
    {/if}
    <p class="text-muted-foreground text-xs">
      Last change
      <time
        datetime={new Date(environment.updatedAt).toISOString()}
        title={absoluteTime(environment.updatedAt)}
      >
        {relativeTime(environment.updatedAt)}
      </time>
    </p>
  </Card.Content>

  <Card.Footer class="gap-2">
    <Button href="/p/{project}/{environment.slug}" size="sm">
      <KeyRoundIcon aria-hidden="true" />
      Secrets
    </Button>
    <Button href="/p/{project}/{environment.slug}/history" size="sm" variant="outline">
      <HistoryIcon aria-hidden="true" />
      History
    </Button>
    <Button
      size="icon-sm"
      variant="ghost"
      class="ml-auto"
      onclick={() => onDelete(environment)}
    >
      <TrashIcon aria-hidden="true" />
      <span class="sr-only">Delete {environment.name}</span>
    </Button>
  </Card.Footer>
</Card.Root>
