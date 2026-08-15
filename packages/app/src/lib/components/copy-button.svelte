<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import { toast } from 'svelte-sonner';

  import { copyPlainText } from '$lib/client/clipboard';
  import { Button, type ButtonSize, type ButtonVariant } from '$lib/components/ui/button/index.js';

  /**
   * Copies something that is NOT a secret: a request id, a key name, a slug.
   *
   * Secret values never go through here -- they go through
   * `copySecretValue()`, which refetches so that the copy is audited. Two
   * components rather than one flag, because "which one is this?" must not be
   * a runtime question.
   */

  let {
    text,
    label,
    variant = 'ghost',
    size = 'icon-sm',
    class: className
  }: {
    /** The literal string to place on the clipboard. */
    text: string;
    /** Describes what is being copied. Read by screen readers, never shown. */
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  } = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    try {
      await copyPlainText(text);
      copied = true;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error('This browser will not give the page clipboard access.');
    }
  }
</script>

<Button {variant} {size} class={className} onclick={copy}>
  {#if copied}
    <CheckIcon aria-hidden="true" />
  {:else}
    <CopyIcon aria-hidden="true" />
  {/if}
  <!-- Icon-only controls always carry their name for assistive technology. -->
  <span class="sr-only">{copied ? `${label} copied` : label}</span>
</Button>
