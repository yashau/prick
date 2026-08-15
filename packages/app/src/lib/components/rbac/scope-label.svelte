<script lang="ts">
  import FolderIcon from '@lucide/svelte/icons/folder';
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import type { ScopeType } from '@prick/shared';

  /**
   * One scope, spelled the same way everywhere in the app.
   *
   * `project/environment` for an environment, the bare slug for a project, and
   * the word "Everything" for global — matching `access/grants-table.svelte`,
   * because two screens that render the same row differently make an operator
   * cross-reference two vocabularies during an incident.
   *
   * The icon is decorative and marked as such. The text carries the meaning.
   */

  let {
    scopeType,
    projectSlug,
    environmentSlug
  }: {
    scopeType: ScopeType;
    projectSlug: string | null;
    environmentSlug: string | null;
  } = $props();

  /**
   * `projectSlug` CAN be null on an environment-scoped row, and rendering
   * `null/production` for it is worse than saying less.
   *
   * `grants.project_id` is nullable and is not populated on every
   * environment-scoped grant — a row written before the column was maintained,
   * or seeded directly, carries NULL — so the join that produces the project
   * slug finds nothing. The environment slug is never null in that case and is
   * the part that identifies the scope, so it is shown alone.
   */
  const label = $derived(
    scopeType === 'global'
      ? 'Everything'
      : scopeType === 'project'
        ? (projectSlug ?? '—')
        : projectSlug === null
          ? (environmentSlug ?? '—')
          : `${projectSlug}/${environmentSlug ?? '—'}`
  );
</script>

<span class="flex items-center gap-1.5 text-sm">
  {#if scopeType === 'global'}
    <GlobeIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {:else if scopeType === 'project'}
    <FolderIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {:else}
    <LayersIcon class="size-3.5 shrink-0" aria-hidden="true" />
  {/if}
  <span class="font-mono break-all">{label}</span>
</span>
