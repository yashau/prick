<script lang="ts">
  import BookLockIcon from '@lucide/svelte/icons/book-lock';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import UsersIcon from '@lucide/svelte/icons/users';

  import { goto } from '$app/navigation';
  import { api, type ProjectSummary } from '$lib/client/api';
  import * as Command from '$lib/components/ui/command/index.js';

  /**
   * The keyboard entry point to everything.
   *
   * Mounted at the ROOT layout rather than inside `(app)`, so it is reachable
   * from the error page too -- the moment you most want to jump somewhere else
   * is the moment a route 404s.
   */

  let open = $state(false);
  let projects = $state<ProjectSummary[]>([]);
  let loaded = $state(false);

  const isMac = $derived(
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '')
  );

  /**
   * A global key listener is a genuine side effect, which is what `$effect` is
   * for. It is NOT used anywhere in this app to compute a value.
   */
  $effect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      open = !open;
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // Loading the project list on first open rather than on mount: the palette is
  // usually never opened, and this list is only ever names and slugs.
  $effect(() => {
    if (!open || loaded) return;
    loaded = true;
    void api
      .listProjects()
      .then((rows) => {
        projects = rows;
      })
      .catch(() => {
        // A palette that cannot list projects still navigates to the fixed
        // destinations below. Failing silently here is right: there is no
        // action for the user to take and no surface to take it on.
        projects = [];
      });
  });

  async function jump(href: string) {
    open = false;
    await goto(href);
  }
</script>

<Command.Dialog
  bind:open
  title="Command palette"
  description="Jump to a project, an environment, or an admin screen."
>
  <Command.Input placeholder="Search projects and screens…" />
  <Command.List>
    <Command.Empty>Nothing matches that.</Command.Empty>

    <Command.Group heading="Go to">
      <Command.Item onSelect={() => jump('/projects')}>
        <FolderIcon />
        <span>Projects</span>
      </Command.Item>
      <Command.Item onSelect={() => jump('/access')}>
        <UsersIcon />
        <span>Access</span>
      </Command.Item>
      <Command.Item onSelect={() => jump('/audit')}>
        <ScrollTextIcon />
        <span>Audit log</span>
      </Command.Item>
      <Command.Item onSelect={() => jump('/settings')}>
        <SettingsIcon />
        <span>Settings and keyring</span>
      </Command.Item>
    </Command.Group>

    {#if projects.length > 0}
      <Command.Separator />
      <Command.Group heading="Projects">
        {#each projects as project (project.slug)}
          <Command.Item
            value={`${project.name} ${project.slug}`}
            onSelect={() => jump(`/p/${project.slug}`)}
          >
            <BookLockIcon />
            <span>{project.name}</span>
            <Command.Shortcut>{project.slug}</Command.Shortcut>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    <Command.Separator />
    <Command.Group heading="Session">
      <Command.Item
        value="hide revealed values"
        onSelect={async () => {
          const { reveal } = await import('$lib/client/reveal.svelte.js');
          reveal.wipe();
          open = false;
        }}
      >
        <KeyRoundIcon />
        <span>Hide every revealed value</span>
        <Command.Shortcut>{isMac ? '⌘' : 'Ctrl'}+K</Command.Shortcut>
      </Command.Item>
    </Command.Group>
  </Command.List>
</Command.Dialog>
