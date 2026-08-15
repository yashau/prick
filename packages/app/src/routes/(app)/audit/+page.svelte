<script lang="ts">
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { getLocalTimeZone } from '@internationalized/date';
  import type { DateRange } from 'bits-ui';
  import {
    getCoreRowModel,
    getSortedRowModel,
    type ColumnDef,
    type SortingState,
    type Updater,
    type VisibilityState
  } from '@tanstack/table-core';

  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { AuditEntryView } from '$lib/client/api';
  import { ACTIONS, actionLabel, scopeLabel } from '$lib/client/audit';
  import { absoluteTime } from '$lib/client/format';
  import AuditActorCell from '$lib/components/audit/audit-actor-cell.svelte';
  import AuditRowActions from '$lib/components/audit/audit-row-actions.svelte';
  import AuditSummaryCell from '$lib/components/audit/audit-summary-cell.svelte';
  import AuditTimeCell from '$lib/components/audit/audit-time-cell.svelte';
  import OutcomeBadge from '$lib/components/audit/outcome-badge.svelte';
  import CopyButton from '$lib/components/copy-button.svelte';
  import SortHeader from '$lib/components/data-table/sort-header.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { createSvelteTable, FlexRender, renderComponent } from '$lib/components/ui/data-table/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';
  import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { RangeCalendar } from '$lib/components/ui/range-calendar/index.js';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let sorting = $state<SortingState>([]);
  let columnVisibility = $state<VisibilityState>({});
  let detail = $state<AuditEntryView | null>(null);
  let detailOpen = $state(false);
  let actor = $state(page.url.searchParams.get('actor') ?? '');
  let range = $state<DateRange | undefined>(undefined);

  function apply<T>(updater: Updater<T>, current: T): T {
    return typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
  }

  /**
   * Every filter change is a NAVIGATION, not local state.
   *
   * `cursor` is cleared on any filter change: a keyset cursor is only
   * meaningful within the query it was issued for, and carrying it across a
   * narrowing would silently start the new result set partway in.
   */
  async function setParam(key: string, value: string | null) {
    const next = new URL(page.url);
    if (value === null || value === '') next.searchParams.delete(key);
    else next.searchParams.set(key, value);
    next.searchParams.delete('cursor');
    await goto(`${next.pathname}${next.search}`, { keepFocus: true, noScroll: true });
  }

  async function applyRange() {
    const next = new URL(page.url);
    next.searchParams.delete('cursor');

    if (range?.start) {
      next.searchParams.set('since', String(range.start.toDate(getLocalTimeZone()).getTime()));
    } else {
      next.searchParams.delete('since');
    }

    if (range?.end) {
      // End of the chosen day, so "15th to 15th" means the whole 15th rather
      // than the single instant of midnight.
      const end = range.end.toDate(getLocalTimeZone());
      end.setHours(23, 59, 59, 999);
      next.searchParams.set('until', String(end.getTime()));
    } else {
      next.searchParams.delete('until');
    }

    await goto(`${next.pathname}${next.search}`, { keepFocus: true, noScroll: true });
  }

  function openDetail(entry: AuditEntryView) {
    detail = entry;
    detailOpen = true;
  }

  const columns: ColumnDef<AuditEntryView>[] = [
    {
      accessorKey: 'ts',
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'When' }),
      cell: ({ row }) => renderComponent(AuditTimeCell, { entry: row.original })
    },
    {
      accessorKey: 'actorSubject',
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Actor' }),
      cell: ({ row }) => renderComponent(AuditActorCell, { entry: row.original })
    },
    {
      accessorKey: 'action',
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'What happened' }),
      cell: ({ row }) =>
        renderComponent(AuditSummaryCell, { entry: row.original, scopes: data.scopes })
    },
    {
      accessorKey: 'outcome',
      header: () => 'Outcome',
      enableSorting: false,
      cell: ({ row }) => renderComponent(OutcomeBadge, { outcome: row.original.outcome })
    },
    {
      id: 'details',
      header: () => '',
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) =>
        renderComponent(AuditRowActions, { entry: row.original, onOpen: openDetail })
    }
  ];

  const table = createSvelteTable({
    get data() {
      return data.page.entries;
    },
    columns,
    getRowId: (row) => row.id,
    state: {
      get sorting() {
        return sorting;
      },
      get columnVisibility() {
        return columnVisibility;
      }
    },
    onSortingChange: (updater) => (sorting = apply(updater, sorting)),
    onColumnVisibilityChange: (updater) => (columnVisibility = apply(updater, columnVisibility)),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  const hasFilters = $derived(
    [...page.url.searchParams.keys()].some((key) => key !== 'cursor')
  );

  const detailJson = $derived(
    detail ? JSON.stringify(detail.detail ?? {}, null, 2) : ''
  );

  /**
   * The scope of the row open in the sheet.
   *
   * Resolved from `data.scopes`, which the load built from the project list and
   * the environments of the projects this page's rows name. Anything it cannot
   * resolve renders as the raw id rather than disappearing -- a row about a
   * project that has since been deleted still happened.
   */
  const detailScope = $derived(detail ? scopeLabel(detail, data.scopes) : null);
</script>

<svelte:head>
  <title>Audit log · prick</title>
</svelte:head>

<PageHeader
  title="Audit log"
  description="Append-only, and written inside the same transaction as the change it records — an un-audited mutation is not possible."
/>

<div class="flex flex-wrap items-end gap-2">
  <InputGroup.Root class="max-w-xs">
    <InputGroup.Addon>
      <SearchIcon aria-hidden="true" />
    </InputGroup.Addon>
    <InputGroup.Input
      bind:value={actor}
      placeholder="Actor contains…"
      aria-label="Filter by actor subject"
      autocomplete="off"
      spellcheck="false"
      onkeydown={(event) => {
        if (event.key === 'Enter') void setParam('actor', actor);
      }}
    />
  </InputGroup.Root>

  <NativeSelect
    aria-label="Filter by project"
    value={page.url.searchParams.get('project') ?? ''}
    onchange={(event) => setParam('project', event.currentTarget.value)}
  >
    <NativeSelectOption value="">Every project</NativeSelectOption>
    {#each data.projects as project (project.slug)}
      <NativeSelectOption value={project.slug}>{project.name}</NativeSelectOption>
    {/each}
  </NativeSelect>

  <NativeSelect
    aria-label="Filter by action"
    value={page.url.searchParams.get('action') ?? ''}
    onchange={(event) => setParam('action', event.currentTarget.value)}
  >
    <NativeSelectOption value="">Every action</NativeSelectOption>
    {#each ACTIONS as action (action)}
      <NativeSelectOption value={action}>{actionLabel(action)}</NativeSelectOption>
    {/each}
  </NativeSelect>

  <NativeSelect
    aria-label="Filter by outcome"
    value={page.url.searchParams.get('outcome') ?? ''}
    onchange={(event) => setParam('outcome', event.currentTarget.value)}
  >
    <NativeSelectOption value="">Every outcome</NativeSelectOption>
    <NativeSelectOption value="success">Succeeded</NativeSelectOption>
    <NativeSelectOption value="denied">Denied</NativeSelectOption>
    <NativeSelectOption value="error">Error</NativeSelectOption>
  </NativeSelect>

  <Popover.Root>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="outline">
          <CalendarIcon aria-hidden="true" />
          {#if range?.start && range?.end}
            {range.start.toString()} → {range.end.toString()}
          {:else}
            Any date
          {/if}
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-auto p-0" align="start">
      <RangeCalendar bind:value={range} numberOfMonths={2} captionLayout="dropdown" />
      <Separator />
      <div class="flex justify-end gap-2 p-2">
        <Button
          variant="ghost"
          size="sm"
          onclick={() => {
            range = undefined;
            void applyRange();
          }}
        >
          Clear
        </Button>
        <Button size="sm" onclick={applyRange}>Apply</Button>
      </div>
    </Popover.Content>
  </Popover.Root>

  {#if hasFilters}
    <Button variant="ghost" href="/audit">Reset filters</Button>
  {/if}
</div>

{#if data.page.entries.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <ScrollTextIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>{hasFilters ? 'Nothing matches those filters' : 'Nothing recorded yet'}</Empty.Title>
      <Empty.Description>
        {#if hasFilters}
          Widen the range, or clear the filters to see the whole log.
        {:else}
          Every project, environment, grant and secret change writes a row here, including
          denials and decrypt failures.
        {/if}
      </Empty.Description>
    </Empty.Header>
    {#if hasFilters}
      <Empty.Content>
        <Button variant="outline" href="/audit">Reset filters</Button>
      </Empty.Content>
    {/if}
  </Empty.Root>
{:else}
  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">Audit entries, newest first.</Table.Caption>
      <Table.Header>
        {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row>
            {#each headerGroup.headers as header (header.id)}
              <Table.Head
                aria-sort={header.column.getIsSorted() === 'asc'
                  ? 'ascending'
                  : header.column.getIsSorted() === 'desc'
                    ? 'descending'
                    : undefined}
              >
                {#if !header.isPlaceholder}
                  <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
                {/if}
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <Table.Body>
        {#each table.getRowModel().rows as row (row.id)}
          <Table.Row>
            {#each row.getVisibleCells() as cell (cell.id)}
              <Table.Cell>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>

  {#if data.page.cursor}
    <div>
      <Button variant="outline" href="{page.url.pathname}?{new URLSearchParams([
        ...[...page.url.searchParams.entries()].filter(([key]) => key !== 'cursor'),
        ['cursor', data.page.cursor]
      ]).toString()}">
        Load the next page
      </Button>
    </div>
  {/if}
{/if}

<Sheet.Root bind:open={detailOpen}>
  <Sheet.Content side="right" class="w-full sm:max-w-lg">
    <Sheet.Header>
      <Sheet.Title>{detail ? actionLabel(detail.action) : 'Entry'}</Sheet.Title>
      <Sheet.Description>
        {detail ? absoluteTime(detail.ts) : ''}
      </Sheet.Description>
    </Sheet.Header>

    {#if detail}
      <ScrollArea class="h-full px-4 pb-6">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-muted-foreground">Outcome</dt>
          <dd><OutcomeBadge outcome={detail.outcome} /></dd>

          <dt class="text-muted-foreground">Actor</dt>
          <dd class="font-mono text-xs break-all">
            {detail.actorSubject}
            <Badge variant="outline">{detail.actorKind}</Badge>
          </dd>

          {#if detailScope}
            <dt class="text-muted-foreground">Scope</dt>
            <dd class="font-mono text-xs break-all">{detailScope}</dd>
          {/if}

          {#if detail.targetKey}
            <dt class="text-muted-foreground">Key</dt>
            <dd class="font-mono text-xs break-all">{detail.targetKey}</dd>
          {/if}

          {#if detail.requestId}
            <dt class="text-muted-foreground">Request id</dt>
            <dd class="flex items-center gap-1">
              <code class="font-mono text-xs break-all">{detail.requestId}</code>
              <CopyButton text={detail.requestId} label="Copy request id" size="icon-xs" />
            </dd>
          {/if}

          <dt class="text-muted-foreground">Entry id</dt>
          <dd class="font-mono text-xs break-all">{detail.id}</dd>
        </dl>

        <Separator class="my-4" />

        <p class="mb-2 text-sm font-medium">Detail</p>
        <!--
          Safe to render verbatim: the audit detail union has no member with a
          field that can hold a secret value. Key names appear throughout and
          are stored in plaintext anyway.
        -->
        <pre class="bg-muted/50 overflow-x-auto rounded-md p-3 font-mono text-xs">{detailJson}</pre>
      </ScrollArea>
    {/if}
  </Sheet.Content>
</Sheet.Root>
