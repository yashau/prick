<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import UserIcon from '@lucide/svelte/icons/user';
  import type { IdentityKind } from '@prick/shared';

  import { Badge } from '$lib/components/ui/badge/index.js';

  /**
   * An identity, as one table cell.
   *
   * BOTH LINES ARE SHOWN, always. A service token's subject is an opaque hex
   * string like `e367826f93b8d71185e03fe518aff3b4.access`, so the display name
   * is the only thing a human can read — and the subject is the only thing that
   * identifies the row unambiguously. Dropping either one makes a revocation
   * decision guesswork.
   *
   * `disabled` is a badge rather than a greyed-out row: the kill switch
   * outranks every grant at every scope, and that fact has to survive being
   * read quickly.
   */

  let {
    kind,
    subject,
    displayName,
    disabled = false,
    /** Renders the name as a link to the identity's permissions screen. */
    href = null,
    /**
     * Stretch that link over the whole table row.
     *
     * OPT-IN, because it is a claim about the container rather than about this
     * cell: the overlay is positioned against the nearest positioned ancestor,
     * so a caller passing this must also make its row `relative` and lift any
     * control in a later cell above the overlay. A caller that does neither
     * would get a link stretched over the wrong box.
     *
     * It also swaps the hover underline for nothing, since the row's own tint
     * is the affordance once the row is the target.
     */
    rowLink = false
  }: {
    kind: IdentityKind;
    subject: string;
    displayName: string | null;
    disabled?: boolean;
    href?: string | null;
    rowLink?: boolean;
  } = $props();
</script>

<div class="flex items-start gap-2">
  {#if kind === 'service'}
    <KeyRoundIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <span class="sr-only">Service token</span>
  {:else}
    <UserIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <span class="sr-only">User</span>
  {/if}

  <div class="min-w-0">
    <div class="font-medium">
      {#if href}
        <a
          class={rowLink
            ? "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            : 'underline-offset-4 hover:underline'}
          {href}
        >
          {displayName ?? subject}
        </a>
      {:else}
        {displayName ?? subject}
      {/if}
    </div>
    <div class="text-muted-foreground font-mono text-xs break-all">{subject}</div>
  </div>

  {#if disabled}
    <Badge variant="destructive">disabled</Badge>
  {/if}
</div>
