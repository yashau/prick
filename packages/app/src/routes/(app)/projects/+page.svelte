<script lang="ts">
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

  import type { ProjectSummary } from '$lib/client/api';
  import { absoluteTime, pluralise, relativeTime } from '$lib/client/format';
  import PageHeader from '$lib/components/page-header.svelte';
  import CreateProjectDialog from '$lib/components/projects/create-project-dialog.svelte';
  import DeleteProjectDialog from '$lib/components/projects/delete-project-dialog.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let deleting = $state<ProjectSummary | null>(null);
  let deleteOpen = $state(false);

  const createErrors = $derived(
    form && 'action' in form && form.action === 'create' && 'errors' in form ? form.errors : {}
  );

  function askDelete(project: ProjectSummary) {
    deleting = project;
    deleteOpen = true;
  }
</script>

<svelte:head>
  <title>Projects · prick</title>
</svelte:head>

<PageHeader
  title="Projects"
  description="Every environment, secret and grant hangs off a project."
>
  {#snippet actions()}
    <CreateProjectDialog errors={createErrors} />
  {/snippet}
</PageHeader>

{#if data.projects.length === 0}
  <!--
    The registry's `empty`, not a bespoke "no projects yet" div. Every list in
    this app has a first-run state and every first-run state carries the
    primary action, so an install that has just been deployed is never a dead
    end.
  -->
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <FolderPlusIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>No projects yet</Empty.Title>
      <Empty.Description>
        A project holds environments; environments hold secrets. Start with one per application.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <CreateProjectDialog errors={createErrors} />
    </Empty.Content>
  </Empty.Root>
{:else}
  <Card.Root class="p-0">
    <Table.Root>
      <Table.Caption class="sr-only">
        Projects, their environment counts and when they last changed.
      </Table.Caption>
      <Table.Header>
        <Table.Row>
          <!--
            `w-full` here and `max-w-0` on the matching cell: the trick that
            makes `truncate` work in an auto-layout table. Every other column
            is a fixed width, so this one absorbs whatever is left over, and
            the zero max-width is what gives the cell's contents a definite
            box to be clipped against instead of widening the table.
          -->
          <Table.Head class="w-full max-w-0">Project</Table.Head>
          <Table.Head class="w-32">Environments</Table.Head>
          <Table.Head class="w-44">Last change</Table.Head>
          <Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.projects as project (project.slug)}
          <!--
            THE WHOLE ROW IS THE LINK, and it is still one anchor.

            The hit area comes from a pseudo-element on the name's own `<a>`
            stretched over the row, rather than a click handler on the `<tr>`.
            A handler would have to reimplement what an anchor already does --
            middle-click, ctrl-click, "copy link address", the status bar
            preview, Enter from the keyboard, and one link per row in a screen
            reader's list -- and would get some of them wrong. The row is the
            positioning context; the overlay is the anchor.

            The cost is that text in the row can no longer be selected, since
            the overlay sits above it. The slug is the only thing here anyone
            would want to copy, and it is selectable on the project's own page.
          -->
          <Table.Row class="relative h-16 has-[a:focus-visible]:bg-muted/50">
            <Table.Cell class="max-w-0">
              <!--
                No underline and no ring: the row's own tint is the whole
                affordance, for hover and for keyboard focus alike, and
                decorating one word inside a target the size of the row points
                at the wrong thing. `has-[a:focus-visible]` on the row above is
                therefore the only focus indicator this list has.
              -->
              <a
                href="/p/{project.slug}"
                class="font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                <span class="block truncate">{project.name}</span>
              </a>
              <!--
                Slug and description share one line so that a row is two lines
                whether or not a description exists. A third line that only
                some rows have is the entire reason the heights differed.
              -->
              <div class="text-muted-foreground truncate text-xs">
                <span class="font-mono">{project.slug}</span>
                {#if project.description}
                  <span aria-hidden="true">·</span>
                  {project.description}
                {/if}
              </div>
            </Table.Cell>
            <Table.Cell>
              <Badge variant={project.environmentCount === 0 ? 'outline' : 'secondary'}>
                <LayersIcon aria-hidden="true" />
                {pluralise(project.environmentCount, 'environment')}
              </Badge>
            </Table.Cell>
            <Table.Cell>
              <time datetime={new Date(project.updatedAt).toISOString()} title={absoluteTime(project.updatedAt)}>
                {relativeTime(project.updatedAt)}
              </time>
            </Table.Cell>
            <!--
              Above the overlay, so the menu button is still reachable rather
              than being a hole that navigates to the project.
            -->
            <Table.Cell class="relative z-10">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button {...props} variant="ghost" size="icon-sm">
                      <MoreHorizontalIcon aria-hidden="true" />
                      <span class="sr-only">Actions for {project.name}</span>
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item>
                    {#snippet child({ props })}
                      <a {...props} href="/p/{project.slug}">Open</a>
                    {/snippet}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item>
                    {#snippet child({ props })}
                      <a {...props} href="/p/{project.slug}/settings">Settings</a>
                    {/snippet}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item>
                    {#snippet child({ props })}
                      <a {...props} href="/p/{project.slug}/access">Access</a>
                    {/snippet}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item variant="destructive" onSelect={() => askDelete(project)}>
                    Delete…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </Card.Root>
{/if}

<DeleteProjectDialog project={deleting} bind:open={deleteOpen} />
