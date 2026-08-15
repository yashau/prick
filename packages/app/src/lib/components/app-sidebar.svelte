<script lang="ts">
  import FolderIcon from '@lucide/svelte/icons/folder';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
  import UsersIcon from '@lucide/svelte/icons/users';

  import { page } from '$app/state';
  import type { ProjectSummary } from '$lib/client/api';
  import type { Viewer } from '$lib/client/fixtures';
  import ProjectSwitcher from '$lib/components/project-switcher.svelte';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';

  let {
    projects,
    viewer,
    unknownIdentityCount = 0
  }: {
    projects: ProjectSummary[];
    viewer: Viewer;
    /** Drives the "seen but not granted" badge. */
    unknownIdentityCount?: number;
  } = $props();

  const currentProject = $derived((page.params.project as string | undefined) ?? null);
  const project = $derived(projects.find((entry) => entry.slug === currentProject) ?? null);

  const initials = $derived(
    (viewer.displayName ?? viewer.subject)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  );

  function isActive(href: string, exact = false): boolean {
    return exact ? page.url.pathname === href : page.url.pathname.startsWith(href);
  }
</script>

<Sidebar.Root collapsible="icon">
  <Sidebar.Header>
    <ProjectSwitcher {projects} current={currentProject} />
  </Sidebar.Header>

  <Sidebar.Content>
    <ScrollArea class="h-full">
      {#if project}
        <Sidebar.Group>
          <Sidebar.GroupLabel>{project.name}</Sidebar.GroupLabel>
          <Sidebar.GroupContent>
            <Sidebar.Menu>
              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={isActive(`/p/${project.slug}`, true)}
                  tooltipContent="Environments"
                >
                  {#snippet child({ props })}
                    <a {...props} href="/p/{project.slug}">
                      <LayersIcon aria-hidden="true" />
                      <span>Environments</span>
                    </a>
                  {/snippet}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>

              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={isActive(`/p/${project.slug}/access`)}
                  tooltipContent="Project access"
                >
                  {#snippet child({ props })}
                    <a {...props} href="/p/{project.slug}/access">
                      <UsersIcon aria-hidden="true" />
                      <span>Access</span>
                    </a>
                  {/snippet}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>

              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={isActive(`/p/${project.slug}/settings`)}
                  tooltipContent="Project settings"
                >
                  {#snippet child({ props })}
                    <a {...props} href="/p/{project.slug}/settings">
                      <SlidersHorizontalIcon aria-hidden="true" />
                      <span>Settings</span>
                    </a>
                  {/snippet}
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>
            </Sidebar.Menu>
          </Sidebar.GroupContent>
        </Sidebar.Group>
      {/if}

      <Sidebar.Group>
        <Sidebar.GroupLabel>Install</Sidebar.GroupLabel>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                isActive={isActive('/projects')}
                tooltipContent="All projects"
              >
                {#snippet child({ props })}
                  <a {...props} href="/projects">
                    <FolderIcon aria-hidden="true" />
                    <span>Projects</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>

            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive('/access')} tooltipContent="Access">
                {#snippet child({ props })}
                  <a {...props} href="/access">
                    <UsersIcon aria-hidden="true" />
                    <span>Access</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
              {#if unknownIdentityCount > 0}
                <Sidebar.MenuBadge>
                  {unknownIdentityCount}
                  <span class="sr-only">identities seen but not granted</span>
                </Sidebar.MenuBadge>
              {/if}
            </Sidebar.MenuItem>

            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive('/audit')} tooltipContent="Audit log">
                {#snippet child({ props })}
                  <a {...props} href="/audit">
                    <ScrollTextIcon aria-hidden="true" />
                    <span>Audit log</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>

            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive('/settings')} tooltipContent="Settings">
                {#snippet child({ props })}
                  <a {...props} href="/settings">
                    <SettingsIcon aria-hidden="true" />
                    <span>Settings</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    </ScrollArea>
  </Sidebar.Content>

  <Sidebar.Footer>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton size="lg" tooltipContent={viewer.subject}>
          <Avatar.Root class="size-8 rounded-lg">
            <Avatar.Fallback class="rounded-lg">{initials}</Avatar.Fallback>
          </Avatar.Root>
          <div class="grid flex-1 text-left text-sm leading-tight">
            <span class="truncate font-medium">{viewer.displayName ?? viewer.subject}</span>
            <span class="text-muted-foreground truncate text-xs">{viewer.subject}</span>
          </div>
          <Badge variant="outline" class="ml-auto">
            {viewer.role}
            {#if viewer.kind === 'service'}
              <KeyRoundIcon class="size-3" aria-hidden="true" />
              <span class="sr-only">service token</span>
            {/if}
          </Badge>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>

  <Sidebar.Rail />
</Sidebar.Root>
