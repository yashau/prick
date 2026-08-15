<script lang="ts">
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import type { Snippet } from 'svelte';

  import { page } from '$app/state';
  import AppSidebar from '$lib/components/app-sidebar.svelte';
  import ThemeToggle from '$lib/components/theme-toggle.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
  import { Kbd } from '$lib/components/ui/kbd/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  interface Crumb {
    label: string;
    href: string;
  }

  /**
   * The trail, derived from the URL rather than threaded down through every
   * page's data.
   *
   * `$derived`, never `$effect`: this is a pure function of `page`, and the
   * moment a breadcrumb is computed in an effect it renders one frame stale on
   * every navigation.
   */
  const crumbs = $derived.by((): Crumb[] => {
    const segments = page.url.pathname.split('/').filter(Boolean);
    const projectSlug = page.params.project as string | undefined;
    const envSlug = page.params.env as string | undefined;

    if (segments[0] !== 'p' || !projectSlug) {
      const [first] = segments;
      const labels: Record<string, string> = {
        projects: 'Projects',
        access: 'Access',
        audit: 'Audit log',
        settings: 'Settings'
      };
      return first ? [{ label: labels[first] ?? first, href: `/${first}` }] : [];
    }

    const project = data.projects.find((entry) => entry.slug === projectSlug);
    const trail: Crumb[] = [
      { label: 'Projects', href: '/projects' },
      { label: project?.name ?? projectSlug, href: `/p/${projectSlug}` }
    ];

    if (envSlug) {
      trail.push({ label: envSlug, href: `/p/${projectSlug}/${envSlug}` });
      if (segments.at(-1) === 'history') {
        trail.push({ label: 'History', href: `/p/${projectSlug}/${envSlug}/history` });
      }
      return trail;
    }

    const tail = segments.at(-1);
    if (tail === 'access') trail.push({ label: 'Access', href: `/p/${projectSlug}/access` });
    if (tail === 'settings') trail.push({ label: 'Settings', href: `/p/${projectSlug}/settings` });

    return trail;
  });
</script>

<Sidebar.Provider>
  <AppSidebar projects={data.projects} viewer={data.viewer} />

  <Sidebar.Inset>
    <header
      class="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur"
    >
      <Sidebar.Trigger class="-ml-1" />
      <Separator orientation="vertical" class="mr-1 data-[orientation=vertical]:h-4" />

      <Breadcrumb.Root>
        <Breadcrumb.List>
          {#each crumbs as crumb, index (crumb.href)}
            {#if index > 0}
              <Breadcrumb.Separator />
            {/if}
            <Breadcrumb.Item>
              {#if index === crumbs.length - 1}
                <Breadcrumb.Page>{crumb.label}</Breadcrumb.Page>
              {:else}
                <Breadcrumb.Link href={crumb.href}>{crumb.label}</Breadcrumb.Link>
              {/if}
            </Breadcrumb.Item>
          {/each}
        </Breadcrumb.List>
      </Breadcrumb.Root>

      <div class="ml-auto flex items-center gap-2">
        <Tooltip.Provider>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <span {...props} class="text-muted-foreground hidden items-center gap-1 sm:flex">
                  <Kbd>{'⌘'}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Open the command palette</Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
        <ThemeToggle />
      </div>
    </header>

    <div class="flex flex-1 flex-col gap-4 p-4 md:p-6">
      {#if data.viewer.bootstrap}
        <!--
          The guard for the bootstrap path.

          `BOOTSTRAP_ADMINS` is evaluated live from a plain `vars` list, which
          is honest -- whoever can run `wrangler deploy` can read MASTER_KEY and
          decrypt everything anyway, so anchoring the first admin to the same
          authority adds no exposure. What it DOES do is create an admin that no
          screen in this app can revoke, so an install must not sit in this
          state indefinitely without saying so.
        -->
        <Alert.Root>
          <TriangleAlertIcon aria-hidden="true" />
          <Alert.Title>Administrator access is still implicit</Alert.Title>
          <Alert.Description>
            You are an administrator because your address is listed in
            <code class="font-mono text-xs">BOOTSTRAP_ADMINS</code>, not because of a grant. Create
            a real global admin grant on the
            <a class="underline underline-offset-4" href="/access">access screen</a>, then remove
            the variable — a grant is revocable and auditable; the variable is neither.
          </Alert.Description>
        </Alert.Root>
      {/if}

      {@render children()}
    </div>
  </Sidebar.Inset>
</Sidebar.Provider>
