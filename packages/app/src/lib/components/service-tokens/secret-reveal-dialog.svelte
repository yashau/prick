<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import EyeOffIcon from '@lucide/svelte/icons/eye-off';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';

  import { copyOneTimeSecret } from '#lib/client/clipboard.js';
  import { absoluteTime, MASK, relativeTime } from '#lib/client/format.js';
  import { idle } from '#lib/client/idle.svelte.js';
  import CopyButton from '#lib/components/copy-button.svelte';
  import type { OneTimeSecret } from '#lib/components/service-tokens/types.js';
  import * as Alert from '#lib/components/ui/alert/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';

  /**
   * The one-time reveal of a service token's client secret.
   *
   * The secret arrives as a bindable prop owned by the page's `$state`, and
   * closing this panel sets it to `null` -- the page forgets it in the same tick
   * the panel disappears. Three things close it: the Done button, the idle
   * watcher reaching its threshold (the same 15 minutes that wipes revealed
   * secret values), and leaving the page, which destroys the state outright.
   *
   * A click outside or an Escape does NOT close it. The secret cannot be shown
   * again, so the panel goes away only when the operator says they are done.
   *
   * Masked until asked, like every other secret on screen, and copied through
   * `copyOneTimeSecret`, which overwrites the clipboard after 30 seconds.
   */

  let { secret = $bindable(null) }: { secret: OneTimeSecret | null } = $props();

  let shown = $state(false);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    secret = null;
    shown = false;
    copied = false;
    clearTimeout(copiedTimer);
  }

  /** The idle threshold wipes this secret exactly as it wipes revealed values. */
  $effect(() => {
    if (idle.idle && secret !== null) close();
  });

  async function copySecret() {
    if (secret === null) return;
    try {
      await copyOneTimeSecret(secret.clientSecret);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error('This browser will not give the page clipboard access.', {
        description: 'Show the secret and copy it by hand.'
      });
    }
  }
</script>

<Dialog.Root
  open={secret !== null}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content
    class="sm:max-w-xl"
    showCloseButton={false}
    interactOutsideBehavior="ignore"
    escapeKeydownBehavior="ignore"
    data-testid="service-token-reveal"
  >
    {#if secret !== null}
      <Dialog.Header>
        <Dialog.Title>
          {secret.kind === 'created' ? 'Service token created' : 'Secret rotated'}: {secret.label}
        </Dialog.Title>
        <Dialog.Description>
          A job authenticates by sending both values as the
          <code class="font-mono text-xs">CF-Access-Client-Id</code> and
          <code class="font-mono text-xs">CF-Access-Client-Secret</code> headers.
        </Dialog.Description>
      </Dialog.Header>

      <Alert.Root variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <Alert.Title>The secret is shown once</Alert.Title>
        <Alert.Description>
          Store it now. Cloudflare returns it only in this response and prick keeps no copy, so
          once this panel closes the only way to a working secret is another rotation.
        </Alert.Description>
      </Alert.Root>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <p class="text-sm font-medium" id="reveal-client-id-label">Client id</p>
          <div class="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
            <code
              class="min-w-0 flex-1 font-mono text-xs break-all"
              aria-labelledby="reveal-client-id-label"
            >
              {secret.clientId}
            </code>
            <CopyButton text={secret.clientId} label="Copy client id" size="icon-sm" />
          </div>
        </div>

        <div class="space-y-1.5">
          <p class="text-sm font-medium" id="reveal-client-secret-label">Client secret</p>
          <div class="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
            <code
              class="min-w-0 flex-1 font-mono text-xs break-all"
              aria-labelledby="reveal-client-secret-label"
              data-testid="service-token-secret"
            >
              {shown ? secret.clientSecret : MASK}
            </code>
            <Button variant="ghost" size="icon-sm" onclick={() => (shown = !shown)}>
              {#if shown}
                <EyeOffIcon aria-hidden="true" />
              {:else}
                <EyeIcon aria-hidden="true" />
              {/if}
              <span class="sr-only">{shown ? 'Hide client secret' : 'Show client secret'}</span>
            </Button>
            <Button variant="ghost" size="icon-sm" onclick={copySecret}>
              {#if copied}
                <CheckIcon aria-hidden="true" />
              {:else}
                <CopyIcon aria-hidden="true" />
              {/if}
              <span class="sr-only">{copied ? 'Client secret copied' : 'Copy client secret'}</span>
            </Button>
          </div>
          <p class="text-muted-foreground text-xs">
            A copied secret is cleared from the clipboard after 30 seconds while this tab has
            focus.
          </p>
        </div>

        {#if secret.kind === 'rotated'}
          <p class="text-sm">
            {#if secret.previousSecretExpiresAt === null}
              The previous secret stopped working when this one was issued.
            {:else}
              The previous secret keeps working until
              <time
                datetime={new Date(secret.previousSecretExpiresAt).toISOString()}
                title={absoluteTime(secret.previousSecretExpiresAt)}
              >
                {relativeTime(secret.previousSecretExpiresAt)}
              </time>, so jobs can move to this one first.
            {/if}
          </p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button onclick={close}>I have stored the secret</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
