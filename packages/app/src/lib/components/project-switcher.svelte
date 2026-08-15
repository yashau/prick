<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ShieldIcon from '@lucide/svelte/icons/shield';

  import type { ProjectSummary } from '$lib/client/api';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { pluralise } from '$lib/client/format';

  let {
    projects,
    current
  }: {
    projects: ProjectSummary[];
    /** The slug in the URL, or `null` on the account-wide screens. */
    current: string | null;
  } = $props();

  const active = $derived(projects.find((project) => project.slug === current) ?? null);
</script>

<Sidebar.Menu>
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="lg"
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <div
              class="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
            >
              <ShieldIcon class="size-4" aria-hidden="true" />
            </div>
            <div class="grid flex-1 text-left text-sm leading-tight">
              <span class="truncate font-medium">{active?.name ?? 'prick'}</span>
              <span class="text-muted-foreground truncate text-xs">
                {active ? active.slug : 'All projects'}
              </span>
            </div>
            <ChevronsUpDownIcon class="ml-auto size-4" aria-hidden="true" />
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="w-(--bits-dropdown-menu-anchor-width) min-w-56" align="start">
        <DropdownMenu.GroupHeading>Projects</DropdownMenu.GroupHeading>
        {#each projects as project (project.slug)}
          <DropdownMenu.Item>
            {#snippet child({ props })}
              <a {...props} href="/p/{project.slug}">
                <span class="flex-1 truncate">{project.name}</span>
                <span class="text-muted-foreground text-xs">
                  {pluralise(project.environmentCount, 'env')}
                </span>
                {#if project.slug === current}
                  <CheckIcon class="size-4" aria-hidden="true" />
                  <span class="sr-only">(current)</span>
                {/if}
              </a>
            {/snippet}
          </DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator />
        <DropdownMenu.Item>
          {#snippet child({ props })}
            <a {...props} href="/projects">
              <PlusIcon class="size-4" aria-hidden="true" />
              Manage projects
            </a>
          {/snippet}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>
