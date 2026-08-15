<script lang="ts">
  import ShieldPlusIcon from '@lucide/svelte/icons/shield-plus';
  import { getLocalTimeZone, type DateValue } from '@internationalized/date';
  import { toast } from 'svelte-sonner';

  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { IdentityRecord, ProjectSummary } from '$lib/client/api';
  import type { FormErrors } from '$lib/client/forms';
  import DatePicker from '$lib/components/access/date-picker.svelte';
  import IdentityCombobox from '$lib/components/access/identity-combobox.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Field from '$lib/components/ui/field/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';
  import * as Select from '$lib/components/ui/select/index.js';

  /**
   * Create a grant.
   *
   * The scope is a DISCRIMINATED choice, matching the API schema: a global
   * grant has no project field at all, rather than a project field that is
   * ignored. A form that accepted `{scope: "global", project: "atlas"}` and
   * decided at submit time what that meant is exactly how an over-broad grant
   * gets created and nobody notices.
   */

  let {
    identities,
    projects,
    /** Pre-selected and locked when the dialog is opened from a project. */
    lockedProject = null,
    errors = {},
    open = $bindable(false),
    /**
     * A subject that has been SEEN but has no identity row selected in the
     * combobox -- the "seen but not granted" flow. Posting the subject rather
     * than an id is the point: an operator can read and verify
     * `e367826f93b8d71185e03fe518aff3b4.access`; they cannot verify a UUID
     * they have retyped.
     */
    presetSubject = null,
    presetKind = 'service',
    /** Hide the built-in trigger when the parent opens this programmatically. */
    showTrigger = true
  }: {
    identities: IdentityRecord[];
    projects: ProjectSummary[];
    lockedProject?: string | null;
    errors?: FormErrors;
    open?: boolean;
    presetSubject?: string | null;
    presetKind?: 'user' | 'service';
    showTrigger?: boolean;
  } = $props();

  let identityId = $state('');
  let role = $state<'reader' | 'writer' | 'admin'>('reader');
  // Capturing the INITIAL value is the intent: `lockedProject` is fixed for
  // the lifetime of the screen this dialog is mounted on, and these two are
  // then owned by the user's selections.
  // svelte-ignore state_referenced_locally
  let scopeType = $state<'global' | 'project' | 'environment'>(
    lockedProject ? 'project' : 'global'
  );
  // svelte-ignore state_referenced_locally
  let projectSlug = $state(lockedProject ?? '');
  let environmentSlug = $state('');
  let expires = $state<DateValue | undefined>(undefined);
  let submitting = $state(false);

  const roleDescriptions: Record<string, string> = {
    reader: 'Read values and list keys. Every read is audited.',
    writer: 'Everything a reader can do, plus write, import and roll back.',
    admin: 'Everything a writer can do, plus manage grants at this scope.'
  };

  const haveSubject = $derived(identityId !== '' || presetSubject !== null);

  const valid = $derived(
    haveSubject &&
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
          Grant access
        </Button>
      {/snippet}
    </Dialog.Trigger>
  {/if}

  <Dialog.Content class="sm:max-w-lg">
    <form
      method="POST"
      action="?/createGrant"
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
          A grant is the only thing that confers authority here. There is no bypass for
          administrators and no special case for human identities — a global admin is a row in
          this table like any other, which is what makes it revocable and auditable.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        {#if presetSubject}
          <Field.Field>
            <Field.Label for="grant-subject">Identity</Field.Label>
            <div
              id="grant-subject"
              class="bg-muted/50 rounded-md border px-3 py-2 font-mono text-sm break-all"
            >
              {presetSubject}
            </div>
            <Field.Description>
              Taken from the denial record, so there is nothing to transcribe.
            </Field.Description>
            <input type="hidden" name="subject" value={presetSubject} />
            <input type="hidden" name="kind" value={presetKind} />
          </Field.Field>
        {:else}
          <Field.Field>
            <Field.Label for="grant-identity">Identity</Field.Label>
            <IdentityCombobox id="grant-identity" {identities} bind:value={identityId} />
            {#if errors.identity}<Field.Error>{errors.identity}</Field.Error>{/if}
          </Field.Field>
        {/if}

        <Field.Field>
          <Field.Label for="grant-role">Role</Field.Label>
          <Select.Root type="single" bind:value={role} name="role">
            <Select.Trigger id="grant-role" class="w-full">
              {role}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="reader">reader</Select.Item>
              <Select.Item value="writer">writer</Select.Item>
              <Select.Item value="admin">admin</Select.Item>
            </Select.Content>
          </Select.Root>
          <Field.Description>{roleDescriptions[role]}</Field.Description>
          {#if errors.role}<Field.Error>{errors.role}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="grant-scope">Scope</Field.Label>
          <NativeSelect
            id="grant-scope"
            name="scope_type"
            bind:value={scopeType}
            disabled={lockedProject !== null}
            class="w-full"
          >
            <NativeSelectOption value="global">Everything in this install</NativeSelectOption>
            <NativeSelectOption value="project">One project</NativeSelectOption>
            <NativeSelectOption value="environment">One environment</NativeSelectOption>
          </NativeSelect>
          {#if errors.scope}<Field.Error>{errors.scope}</Field.Error>{/if}
        </Field.Field>

        {#if scopeType !== 'global'}
          <Field.Field>
            <Field.Label for="grant-project">Project</Field.Label>
            <NativeSelect
              id="grant-project"
              name="project"
              bind:value={projectSlug}
              disabled={lockedProject !== null}
              class="w-full"
            >
              <NativeSelectOption value="">Select a project…</NativeSelectOption>
              {#each projects as project (project.slug)}
                <NativeSelectOption value={project.slug}>
                  {project.name} ({project.slug})
                </NativeSelectOption>
              {/each}
            </NativeSelect>
            {#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
          </Field.Field>
        {/if}

        {#if scopeType === 'environment'}
          <Field.Field>
            <Field.Label for="grant-environment">Environment slug</Field.Label>
            <NativeSelect
              id="grant-environment"
              name="environment"
              bind:value={environmentSlug}
              class="w-full"
            >
              <NativeSelectOption value="">Select an environment…</NativeSelectOption>
              <NativeSelectOption value="production">production</NativeSelectOption>
              <NativeSelectOption value="staging">staging</NativeSelectOption>
              <NativeSelectOption value="development">development</NativeSelectOption>
            </NativeSelect>
            {#if errors.environment}<Field.Error>{errors.environment}</Field.Error>{/if}
          </Field.Field>
        {/if}

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
