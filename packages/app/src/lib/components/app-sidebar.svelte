<script lang="ts">
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import LogOutIcon from '@lucide/svelte/icons/log-out';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
  import UserIcon from '@lucide/svelte/icons/user';
  import UsersIcon from '@lucide/svelte/icons/users';
  import UsersRoundIcon from '@lucide/svelte/icons/users-round';

  import { initialsFor } from '$lib/client/format';
  import { page } from '$app/state';
  import type { ProjectSummary, Viewer } from '$lib/client/api';
  import ProjectSwitcher from '$lib/components/project-switcher.svelte';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
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

  /**
   * `displayName` when Access has one, the address otherwise.
   *
   * `/whoami` now carries the name Cloudflare Access holds, resolved from
   * `/cdn-cgi/access/get-identity` and cached on the identity row, so the shell
   * no longer renders an address where a person's name belongs. It still falls
   * back to `subject`: service tokens have no name, and neither do providers
   * that supply none.
   */
  const initials = $derived(initialsFor(viewer));

  /**
   * `role` is the GLOBAL role and is `null` for a project-scoped admin, who is
   * emphatically not role-less. Naming the scope is what keeps the badge from
   * reading as "you have nothing".
   */
  const roleLabel = $derived(viewer.role ?? 'scoped');

  /**
   * Global admin, which is what install SETTINGS needs.
   *
   * `viewer.role` is the effective role at global scope and already folds in
   * `BOOTSTRAP_ADMINS`, so this is the same question `assertRole(global, admin)`
   * asks on the server — not an approximation of it.
   *
   * The settings screen has no degraded mode: `getKeyringStatus` is global-admin
   * only and the load refuses rather than rendering the panel empty, because a
   * "safe to remove MASTER_KEY_OLD" indicator computed from a status that failed
   * to fetch is the one irreversible mistake in this design. So a scoped admin
   * clicking the link would get a 403 page, and a link that cannot be followed
   * is worse than no link.
   *
   * Users, Groups and Access are NOT gated here, deliberately: they need admin
   * at ANY scope, which a project admin has and `viewer.role` — global only, and
   * `null` for exactly that person — cannot express. Hiding them on this signal
   * would take the screens away from the people delegated administration exists
   * for.
   */
  const isGlobalAdmin = $derived(viewer.role === 'admin');

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

            <!--
              Users and Groups sit beside Access rather than inside it, because
              they answer a different question. Access is "what grants exist";
              these two are "who is there, and why can they do that" — which,
              once a role can arrive through a group, is not derivable from the
              grants list at all.
            -->
            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive('/users')} tooltipContent="Users">
                {#snippet child({ props })}
                  <a {...props} href="/users">
                    <UserIcon aria-hidden="true" />
                    <span>Users</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>

            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={isActive('/groups')} tooltipContent="Groups">
                {#snippet child({ props })}
                  <a {...props} href="/groups">
                    <UsersRoundIcon aria-hidden="true" />
                    <span>Groups</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
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

            {#if isGlobalAdmin}
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
            {/if}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    </ScrollArea>
  </Sidebar.Content>

  <Sidebar.Footer>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Sidebar.MenuButton
                {...props}
                size="lg"
                tooltipContent={viewer.subject}
                class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar.Root class="size-8 rounded-lg">
                  <Avatar.Fallback class="rounded-lg">{initials}</Avatar.Fallback>
                </Avatar.Root>
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <!--
                    The name when there is one, the address otherwise -- the same
                    `displayName ?? subject` fallback every other identity in this UI
                    renders. The address stays reachable: it is this button's tooltip,
                    it heads the menu below, and it is what the account screens key on.
                  -->
                  <span class="truncate font-medium">{viewer.displayName ?? viewer.subject}</span>
                  <span class="text-muted-foreground truncate text-xs">
                    {viewer.role === null ? 'No install-wide role' : `${viewer.role} everywhere`}
                  </span>
                </div>
                <Badge variant="outline" class="ml-auto" title={viewer.role === null
                  ? 'No global grant. Any access you have is scoped to a project or an environment.'
                  : `Global ${viewer.role}`}>
                  {roleLabel}
                  {#if viewer.kind === 'service'}
                    <KeyRoundIcon class="size-3" aria-hidden="true" />
                    <span class="sr-only">service token</span>
                  {/if}
                </Badge>
                <ChevronsUpDownIcon class="size-4" aria-hidden="true" />
              </Sidebar.MenuButton>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            class="w-(--bits-dropdown-menu-anchor-width) min-w-60"
            align="end"
            side="top"
          >
            <DropdownMenu.GroupHeading class="text-muted-foreground font-normal">
              {viewer.subject}
            </DropdownMenu.GroupHeading>
            <DropdownMenu.Separator />
            {#if viewer.kind === 'service'}
              <!--
                A service token authenticates per request with its client id and
                secret. There is no cookie to clear, so there is nothing here to
                honour -- say that rather than offering a button that would do
                nothing.
              -->
              <DropdownMenu.Item disabled>
                <KeyRoundIcon class="size-4" aria-hidden="true" />
                Service tokens hold no session
              </DropdownMenu.Item>
            {:else}
              <DropdownMenu.Item>
                {#snippet child({ props })}
                  <!--
                    `data-sveltekit-reload` is load-bearing. This path is
                    same-origin, so the router would otherwise claim the click and
                    look for a route that does not exist; the endpoint is served by
                    Cloudflare at the edge and never reaches the Worker, so it has
                    to be a real document request.

                    Scope worth knowing: this clears the Access session for the
                    whole team, not just this app, and previously issued tokens
                    stop being accepted after 20-30 seconds. Entra keeps its own
                    session, so signing back in lands on its account picker rather
                    than a password prompt -- which is the point, since picking a
                    different account is the reason to use this.
                  -->
                  <a {...props} href="/cdn-cgi/access/logout" data-sveltekit-reload>
                    <LogOutIcon class="size-4" aria-hidden="true" />
                    Sign out
                  </a>
                {/snippet}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>

  <Sidebar.Rail />
</Sidebar.Root>
