<script lang="ts">
  import { api, type RotatedServiceToken, type ServiceTokenRecord } from '#lib/client/api.js';
  import { toApiError } from '#lib/client/errors.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as Field from '#lib/components/ui/field/index.js';
  import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
  import { Spinner } from '#lib/components/ui/spinner/index.js';

  /**
   * Rotate a token's client secret. The client id, the identity and every grant
   * stay as they are.
   *
   * The grace period keeps the previous secret valid long enough to move jobs
   * across without an outage. None, the default, ends it the moment the new one
   * is issued -- the answer when the secret leaked.
   *
   * Like creation, the new secret goes straight to `onRotated` and is never
   * kept here.
   */

  let {
    token = $bindable(null),
    onRotated
  }: {
    /** The token being rotated; `null` closes the dialog. */
    token: ServiceTokenRecord | null;
    onRotated: (rotated: RotatedServiceToken) => void;
  } = $props();

  const GRACE = [
    { seconds: 0, label: 'None: the previous secret stops working now' },
    { seconds: 3_600, label: 'One hour' },
    { seconds: 86_400, label: 'One day' },
    { seconds: 604_800, label: 'Seven days' },
    { seconds: 2_592_000, label: '30 days' }
  ] as const;

  let grace = $state('0');
  let saving = $state(false);
  let failure = $state<string | null>(null);

  function close() {
    token = null;
    grace = '0';
    failure = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (token === null) return;
    saving = true;
    failure = null;
    try {
      const rotated = await api.rotateServiceToken(token.id, Number(grace));
      close();
      onRotated(rotated);
    } catch (error) {
      const failed = toApiError(error);
      failure = [
        failed.message,
        failed.hint,
        failed.requestId ? `(request ${failed.requestId})` : null
      ]
        .filter(Boolean)
        .join(' ');
    } finally {
      saving = false;
    }
  }
</script>

<Dialog.Root
  open={token !== null}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Rotate {token?.name ?? token?.clientId ?? ''}</Dialog.Title>
        <Dialog.Description>
          Cloudflare issues a new secret for the same client id, so the identity and its grants
          are unchanged. The new secret is shown once.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="rotate-grace">Grace period</Field.Label>
          <NativeSelect id="rotate-grace" bind:value={grace} class="w-full">
            {#each GRACE as option (option.seconds)}
              <NativeSelectOption value={String(option.seconds)}>{option.label}</NativeSelectOption>
            {/each}
          </NativeSelect>
          <Field.Description>
            How long the previous secret keeps working. Choose none when it may have leaked.
          </Field.Description>
        </Field.Field>

        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Button variant="outline" type="button" onclick={close}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {#if saving}<Spinner class="size-3" />{/if}
          Rotate secret
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
