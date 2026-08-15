<script lang="ts">
  import ShieldPlusIcon from '@lucide/svelte/icons/shield-plus';
  import { getLocalTimeZone, type DateValue } from '@internationalized/date';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { FormErrors } from '$lib/client/forms';
  import DatePicker from '$lib/components/access/date-picker.svelte';
  import IdentityCombobox from '$lib/components/access/identity-combobox.svelte';
  import ScopeFields from '$lib/components/rbac/scope-fields.svelte';
  import type { AdminScopes, IdentityView } from '$lib/components/rbac/types';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import * as Select from '$lib/components/ui/select/index.js';

  /**
   * Create a grant, for an identity or for a group.
   *
   * ONE DIALOG FOR BOTH HOLDERS, because on the server they are one operation
   * with two tables behind it: `createGrant` and `createGroupGrant` resolve the
   * scope through the same `resolveGrantScope` and check it with the same
   * `assertRole(scope, "admin")`. A second dialog would be a second place for
   * the role vocabulary, the expiry semantics and the scope rules to drift, and
   * "why does Bob have production?" only has one answer while they cannot.
   *
   * The holder is the only difference and it is expressed as data: `identities`
   * present means "pick who", `subject` present means "this one", neither means
   * the holder is named by the URL — which is the group case.
   */

  let {
    scopes,
    /** Where the form posts. `?/createGrant` on every screen that uses this. */
    action = '?/createGrant',
    /** Offer a choice of identity. Omit for a group grant. */
    identities = null,
    /** Grant to exactly this identity. Posts its id; renders its subject. */
    identity = null,
    /** Names the holder in the dialog copy. "the deploy group", "Ada Lovelace". */
    holder,
    triggerLabel = 'Grant access',
    errors = {},
    open = $bindable(false),
    showTrigger = true
  }: {
    scopes: AdminScopes;
    action?: string;
    identities?: IdentityView[] | null;
    identity?: IdentityView | null;
    holder: string;
    triggerLabel?: string;
    errors?: FormErrors;
    open?: boolean;
    showTrigger?: boolean;
  } = $props();

  /**
   * The widest scope this actor may grant at, as the starting selection.
   *
   * Not a `$derived`: it is the INITIAL value of a control the user then owns,
   * and a derived default would silently reset their choice on any unrelated
   * re-render of the parent.
   */
  function widest(): 'global' | 'project' | 'environment' {
    if (scopes.global) return 'global';
    if (scopes.projects.some((project) => project.grantable)) return 'project';
    return 'environment';
  }

  // svelte-ignore state_referenced_locally
  let scopeType = $state<'global' | 'project' | 'environment'>(widest());
  let projectSlug = $state('');
  let environmentSlug = $state('');
  let identityId = $state('');
  let role = $state<'reader' | 'writer' | 'admin'>('reader');
  let expires = $state<DateValue | undefined>(undefined);
  let submitting = $state(false);

  const roleDescriptions: Record<string, string> = {
    reader: 'Read values and list keys. Every read is audited.',
    writer: 'Everything a reader can do, plus write, import and roll back.',
    admin: 'Everything a writer can do, plus manage grants at this scope.'
  };

  const haveHolder = $derived(identity !== null || identities === null || identityId !== '');

  const valid = $derived(
    haveHolder &&
      (scopeType === 'global' ||
        (projectSlug !== '' && (scopeType === 'project' || environmentSlug !== '')))
  );
</script>

<Dialog.Root bind:open>
  {#if showTrigger}
    <Dialog.Trigger>
      {#snippet child({ props })}
        <Button {...props}>
          <ShieldPlusIcon aria-hidden="true" />
          {triggerLabel}
        </Button>
      {/snippet}
    </Dialog.Trigger>
  {/if}

  <!--
    THE DIALOG SCROLLS, and that is load-bearing rather than cosmetic.

    With a scope and an environment selected this form is nine fields and three
    explanations tall, which overflows a 1280x720 viewport — and the registry's
    dialog content has no height cap, so the footer simply lands below the fold
    with nothing to scroll. The submit button being unreachable is the whole
    screen being unusable, and it only shows up on a short viewport.
  -->
  <Dialog.Content class="max-h-[85svh] overflow-y-auto sm:max-w-lg">
    <form
      method="POST"
      {action}
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          submitting = false;
          if (result.type === 'success') {
            open = false;
            toast.success('Grant created.');
            await invalidateAll();
            return;
          }
          await applyAction(result);
        };
      }}
    >
      <Dialog.Header>
        <Dialog.Title>Grant access</Dialog.Title>
        <Dialog.Description>
          A grant is the only thing that confers authority here, and it is the same object
          whoever holds it. Effective access is the highest role across every grant that reaches
          a scope — including the grants of every group the holder belongs to.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        {#if identity}
          <Field.Field>
            <Field.Label for="grant-holder">Identity</Field.Label>
            <div
              id="grant-holder"
              class="bg-muted/50 rounded-md border px-3 py-2 font-mono text-sm break-all"
            >
              {identity.subject}
            </div>
            <input type="hidden" name="identity_id" value={identity.id} />
          </Field.Field>
        {:else if identities}
          <Field.Field>
            <Field.Label for="grant-identity">Identity</Field.Label>
            <IdentityCombobox id="grant-identity" {identities} bind:value={identityId} />
            {#if errors.identity}<Field.Error>{errors.identity}</Field.Error>{/if}
          </Field.Field>
        {:else}
          <Field.Field>
            <Field.Label for="grant-holder">Group</Field.Label>
            <div id="grant-holder" class="bg-muted/50 rounded-md border px-3 py-2 text-sm">
              {holder}
            </div>
            <Field.Description>
              Every member of this group gains the role below, and loses it the moment they
              leave the group or the grant is revoked.
            </Field.Description>
          </Field.Field>
        {/if}

        <Field.Field>
          <Field.Label for="grant-role">Role</Field.Label>
          <Select.Root type="single" bind:value={role} name="role">
            <Select.Trigger id="grant-role" class="w-full">{role}</Select.Trigger>
            <Select.Content>
              <Select.Item value="reader">reader</Select.Item>
              <Select.Item value="writer">writer</Select.Item>
              <Select.Item value="admin">admin</Select.Item>
            </Select.Content>
          </Select.Root>
          <Field.Description>{roleDescriptions[role]}</Field.Description>
          {#if errors.role}<Field.Error>{errors.role}</Field.Error>{/if}
        </Field.Field>

        <ScopeFields
          {scopes}
          idPrefix="grant"
          {errors}
          bind:scopeType
          bind:projectSlug
          bind:environmentSlug
        />

        <Field.Field>
          <Field.Label for="grant-expires">Expires</Field.Label>
          <DatePicker bind:value={expires} label="Grant expiry date" placeholder="Never expires" />
          <Field.Description>
            Optional, and worth setting for a contractor or a one-off migration. An expired grant
            stops conferring anything the moment it lapses; it is not swept up later.
          </Field.Description>
          <input
            type="hidden"
            name="expires_at"
            value={expires ? String(expires.toDate(getLocalTimeZone()).getTime()) : ''}
          />
        </Field.Field>

        {#if scopeType === 'global' && role === 'admin'}
          <Alert.Root>
            <ShieldPlusIcon aria-hidden="true" />
            <Alert.Title>This is full control of the install</Alert.Title>
            <Alert.Description>
              A global admin can read every value in every environment and can change anyone's
              access, including yours.
            </Alert.Description>
          </Alert.Root>
        {/if}

        {#if errors.form}<Field.Error>{errors.form}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={!valid || submitting}>
          {submitting ? 'Granting…' : 'Create grant'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
