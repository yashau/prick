<script lang="ts">
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import ShieldXIcon from '@lucide/svelte/icons/shield-x';

  import { OUTCOME_LABELS } from '$lib/client/audit';
  import { Badge } from '$lib/components/ui/badge/index.js';

  let { outcome }: { outcome: string } = $props();

  /**
   * Colour is never the sole signal. Each outcome carries a distinct ICON and
   * a word as well as a colour, so the table is still readable in greyscale
   * and to anyone who cannot distinguish red from green -- which, on a screen
   * whose whole job is to show you a denial you did not expect, matters more
   * than usual.
   */
  const variant = $derived(
    outcome === 'success' ? 'secondary' : outcome === 'denied' ? 'outline' : 'destructive'
  );
</script>

<Badge {variant}>
  {#if outcome === 'success'}
    <CircleCheckIcon aria-hidden="true" />
  {:else if outcome === 'denied'}
    <ShieldXIcon aria-hidden="true" />
  {:else}
    <OctagonXIcon aria-hidden="true" />
  {/if}
  {OUTCOME_LABELS[outcome] ?? outcome}
</Badge>
