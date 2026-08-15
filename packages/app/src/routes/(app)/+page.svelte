<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // TODO(build order step 15): shadcn-svelte registry components --
  // card, table, button, dialog, field, input, textarea, dropdown-menu,
  // alert-dialog, badge, empty, skeleton, tooltip.
  //
  // `empty` is the registry's first-run state; use it rather than a bespoke
  // "no projects yet" div.
</script>

<h1>Projects</h1>

{#if data.projects.length === 0}
  <p>No projects yet.</p>
{:else}
  <ul>
    {#each data.projects as project (project.slug)}
      <li>
        <a href="/p/{project.slug}">{project.name}</a>
        <span>{project.environmentCount} environments</span>
      </li>
    {/each}
  </ul>
{/if}
