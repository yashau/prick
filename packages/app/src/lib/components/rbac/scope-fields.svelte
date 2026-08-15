<script lang="ts">
  import type { FormErrors } from '$lib/client/forms';
  import type { AdminScopes } from '$lib/components/rbac/types';
  import * as Field from '$lib/components/ui/field/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';

  /**
   * Pick the scope a grant applies to — offering only scopes this actor can
   * actually grant at.
   *
   * ---------------------------------------------------------------------------
   * WHY THE OPTIONS ARE FILTERED RATHER THAN DISABLED
   * ---------------------------------------------------------------------------
   * Granting requires admin AT THE SCOPE BEING GRANTED. An admin of one project
   * offered "Everything in this install" in a dropdown learns their real
   * authority from a 403 after they have already decided what they wanted to
   * do. `AdminScopes` is computed server-side by `(app)/users/scopes.ts` and is
   * presentation only — the server re-checks every one of these choices, so a
   * hand-posted body naming a scope that is missing here is refused exactly as
   * it was before this component existed.
   *
   * THE ENVIRONMENT LIST IS REAL. It comes from `listEnvironments`, which has
   * already narrowed to what this actor may see. An environment picker with
   * three hard-coded names in it is wrong for every install that named theirs
   * something else.
   */

  let {
    scopes,
    /** Fixed and non-editable when the screen already implies a project. */
    lockedProject = null,
    idPrefix,
    errors = {},
    scopeType = $bindable('global'),
    projectSlug = $bindable(''),
    environmentSlug = $bindable('')
  }: {
    scopes: AdminScopes;
    lockedProject?: string | null;
    /** Prefix for the generated element ids, so two forms can coexist. */
    idPrefix: string;
    errors?: FormErrors;
    scopeType?: 'global' | 'project' | 'environment';
    projectSlug?: string;
    environmentSlug?: string;
  } = $props();

  const projectOptions = $derived(scopes.projects.filter((project) => project.grantable));
  const environmentHosts = $derived(
    scopes.projects.filter((project) => project.environments.length > 0)
  );

  const available = $derived(
    scopeType === 'environment' ? environmentHosts : scopeType === 'project' ? projectOptions : []
  );

  const environments = $derived(
    environmentHosts.find((project) => project.slug === projectSlug)?.environments ?? []
  );
</script>

<Field.Field>
  <Field.Label for="{idPrefix}-scope">Scope</Field.Label>
  <NativeSelect
    id="{idPrefix}-scope"
    name="scope_type"
    bind:value={scopeType}
    disabled={lockedProject !== null}
    class="w-full"
  >
    {#if scopes.global}
      <NativeSelectOption value="global">Everything in this install</NativeSelectOption>
    {/if}
    {#if projectOptions.length > 0}
      <NativeSelectOption value="project">One project</NativeSelectOption>
    {/if}
    {#if environmentHosts.length > 0}
      <NativeSelectOption value="environment">One environment</NativeSelectOption>
    {/if}
  </NativeSelect>
  <Field.Description>
    Grants are inherited downwards and never upwards: a project grant reaches
    every environment in it, and an environment grant reaches nothing else.
  </Field.Description>
  {#if errors.scope}<Field.Error>{errors.scope}</Field.Error>{/if}
</Field.Field>

{#if scopeType !== 'global'}
  <Field.Field>
    <Field.Label for="{idPrefix}-project">Project</Field.Label>
    <NativeSelect
      id="{idPrefix}-project"
      name="project"
      bind:value={projectSlug}
      disabled={lockedProject !== null}
      class="w-full"
    >
      <NativeSelectOption value="">Select a project…</NativeSelectOption>
      {#each available as project (project.slug)}
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
    <Field.Label for="{idPrefix}-environment">Environment</Field.Label>
    <NativeSelect
      id="{idPrefix}-environment"
      name="environment"
      bind:value={environmentSlug}
      class="w-full"
      disabled={projectSlug === ''}
    >
      <NativeSelectOption value="">Select an environment…</NativeSelectOption>
      {#each environments as environment (environment.slug)}
        <NativeSelectOption value={environment.slug}>
          {environment.name} ({environment.slug})
        </NativeSelectOption>
      {/each}
    </NativeSelect>
    {#if projectSlug !== '' && environments.length === 0}
      <Field.Description>
        You administer this project but it has no environments yet.
      </Field.Description>
    {/if}
    {#if errors.environment}<Field.Error>{errors.environment}</Field.Error>{/if}
  </Field.Field>
{/if}
