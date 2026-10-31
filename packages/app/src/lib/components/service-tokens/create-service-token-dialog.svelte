<script lang="ts">
  import PlusIcon from '@lucide/svelte/icons/plus';

  import { DisplayName, type Role } from '@prick/shared';

  import {
    api,
    type EnvironmentSummary,
    type IssuedServiceToken,
    type ProjectSummary,
    type ServiceTokenGrantInput
  } from '#lib/client/api.js';
  import { toApiError } from '#lib/client/errors.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Checkbox } from '#lib/components/ui/checkbox/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as Field from '#lib/components/ui/field/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
  import { Spinner } from '#lib/components/ui/spinner/index.js';

  /**
   * Create a Cloudflare Access service token, optionally holding its first
   * grant from the moment it exists.
   *
   * The response carries the client secret, and this dialog hands it straight
   * to `onIssued` without keeping it: the page owns the one-time reveal, and
   * this component's state holds only the form.
   *
   * The grant is created by the server in the same transaction as the token's
   * identity, so a token never exists in a half-provisioned state where it
   * authenticates and is denied everything.
   */

  let {
    projects,
    onIssued
  }: {
    /** The projects the grant scope may name. A global admin sees every one. */
    projects: ProjectSummary[];
    onIssued: (issued: IssuedServiceToken) => void;
  } = $props();

  const DURATIONS = [
    { value: '720h', label: '30 days' },
    { value: '2160h', label: '90 days' },
    { value: '8760h', label: 'One year' },
    { value: 'forever', label: 'Never expires' }
  ] as const;

  let open = $state(false);
  let name = $state('');
  let duration = $state<string>('8760h');
  let withGrant = $state(false);
  let role = $state<Role>('reader');
  let scopeType = $state<'global' | 'project' | 'environment'>('project');
  let project = $state('');
  let environment = $state('');
  let environments = $state<EnvironmentSummary[]>([]);
  let loadingEnvironments = $state(false);
  let saving = $state(false);
  let failure = $state<string | null>(null);

  const nameIssue = $derived.by(() => {
    if (name === '') return null;
    const parsed = DisplayName.safeParse(name.trim());
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid name.');
  });

  const grantComplete = $derived(
    !withGrant ||
      scopeType === 'global' ||
      (scopeType === 'project' && project !== '') ||
      (scopeType === 'environment' && project !== '' && environment !== '')
  );

  const valid = $derived(name.trim() !== '' && nameIssue === null && grantComplete);

  /**
   * The environment list for the chosen project, fetched when an environment
   * scope needs it -- a network request, so an effect rather than a derivation.
   * A response that arrives after the project changed again is dropped, so the
   * list always belongs to the project on screen.
   */
  $effect(() => {
    const slug = project;
    const wanted = withGrant && scopeType === 'environment' && slug !== '';
    environment = '';
    environments = [];
    if (wanted) void loadEnvironments(slug);
  });

  async function loadEnvironments(slug: string) {
    loadingEnvironments = true;
    try {
      const list = await api.listEnvironments(slug);
      if (project === slug) environments = list;
    } catch (error) {
      failure = toApiError(error).message;
    } finally {
      loadingEnvironments = false;
    }
  }

  function grantBody(): ServiceTokenGrantInput | undefined {
    if (!withGrant) return undefined;
    if (scopeType === 'global') return { scope_type: 'global', role, expires_at: null };
    if (scopeType === 'project') return { scope_type: 'project', project, role, expires_at: null };
    return { scope_type: 'environment', project, environment, role, expires_at: null };
  }

  function reset() {
    name = '';
    duration = '8760h';
    withGrant = false;
    role = 'reader';
    scopeType = 'project';
    project = '';
    environment = '';
    environments = [];
    failure = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    failure = null;
    try {
      const grant = grantBody();
      const issued = await api.createServiceToken({
        name: name.trim(),
        duration,
        ...(grant === undefined ? {} : { grant })
      });
      open = false;
      reset();
      onIssued(issued);
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
  bind:open
  onOpenChange={(next) => {
    if (!next) reset();
  }}
>
  <Dialog.Trigger>
    {#snippet child({ props })}
      <Button {...props}>
        <PlusIcon aria-hidden="true" />
        Create service token
      </Button>
    {/snippet}
  </Dialog.Trigger>

  <Dialog.Content class="sm:max-w-lg">
    <form onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Create a service token</Dialog.Title>
        <Dialog.Description>
          Cloudflare issues the token and prick records the identity it authenticates as. The
          secret is shown once, right after this.
        </Dialog.Description>
      </Dialog.Header>

      <Field.Group class="py-4">
        <Field.Field>
          <Field.Label for="token-name">Name</Field.Label>
          <Input
            id="token-name"
            bind:value={name}
            required
            maxlength={128}
            autocomplete="off"
            placeholder="staging deploy"
            aria-invalid={nameIssue ? 'true' : undefined}
          />
          <Field.Description>
            Becomes the identity's display name, so grants and the audit log read as this rather
            than as a client id.
          </Field.Description>
          {#if nameIssue}<Field.Error>{nameIssue}</Field.Error>{/if}
        </Field.Field>

        <Field.Field>
          <Field.Label for="token-duration">Lifetime</Field.Label>
          <NativeSelect id="token-duration" bind:value={duration} class="w-full">
            {#each DURATIONS as option (option.value)}
              <NativeSelectOption value={option.value}>{option.label}</NativeSelectOption>
            {/each}
          </NativeSelect>
          <Field.Description>
            Refreshing a token extends its expiry by this much again, without a new secret.
          </Field.Description>
        </Field.Field>

        <Field.Field orientation="horizontal">
          <Checkbox id="token-with-grant" bind:checked={withGrant} />
          <Field.Label for="token-with-grant">Grant a role now</Field.Label>
        </Field.Field>

        {#if withGrant}
          <Field.Field>
            <Field.Label for="token-role">Role</Field.Label>
            <NativeSelect id="token-role" bind:value={role} class="w-full">
              <NativeSelectOption value="reader">reader</NativeSelectOption>
              <NativeSelectOption value="writer">writer</NativeSelectOption>
              <NativeSelectOption value="admin">admin</NativeSelectOption>
            </NativeSelect>
          </Field.Field>

          <Field.Field>
            <Field.Label for="token-scope">Scope</Field.Label>
            <NativeSelect
              id="token-scope"
              bind:value={scopeType}
              class="w-full"
            >
              <NativeSelectOption value="global">Everything in this install</NativeSelectOption>
              <NativeSelectOption value="project">One project</NativeSelectOption>
              <NativeSelectOption value="environment">One environment</NativeSelectOption>
            </NativeSelect>
            <Field.Description>
              A project grant reaches every environment in it; an environment grant reaches
              nothing else.
            </Field.Description>
          </Field.Field>

          {#if scopeType !== 'global'}
            <Field.Field>
              <Field.Label for="token-project">Project</Field.Label>
              <NativeSelect
                id="token-project"
                bind:value={project}
                class="w-full"
              >
                <NativeSelectOption value="">Select a project…</NativeSelectOption>
                {#each projects as option (option.slug)}
                  <NativeSelectOption value={option.slug}>
                    {option.name} ({option.slug})
                  </NativeSelectOption>
                {/each}
              </NativeSelect>
            </Field.Field>
          {/if}

          {#if scopeType === 'environment'}
            <Field.Field>
              <Field.Label for="token-environment">Environment</Field.Label>
              <NativeSelect
                id="token-environment"
                bind:value={environment}
                class="w-full"
                disabled={project === '' || loadingEnvironments}
              >
                <NativeSelectOption value="">
                  {loadingEnvironments ? 'Loading…' : 'Select an environment…'}
                </NativeSelectOption>
                {#each environments as option (option.slug)}
                  <NativeSelectOption value={option.slug}>
                    {option.name} ({option.slug})
                  </NativeSelectOption>
                {/each}
              </NativeSelect>
            </Field.Field>
          {/if}
        {/if}

        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
      </Field.Group>

      <Dialog.Footer>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="outline" type="button">Cancel</Button>
          {/snippet}
        </Dialog.Close>
        <Button type="submit" disabled={!valid || saving}>
          {#if saving}<Spinner class="size-3" />{/if}
          Create
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
