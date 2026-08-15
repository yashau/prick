<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import SearchIcon from '@lucide/svelte/icons/search';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import {
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    type ColumnDef,
    type ColumnFiltersState,
    type RowSelectionState,
    type SortingState,
    type Updater,
    type VisibilityState
  } from '@tanstack/table-core';
  import { toast } from 'svelte-sonner';

  import type { SecretListEntry } from '$lib/client/api';
  import { pluralise } from '$lib/client/format';
  import { reveal } from '$lib/client/reveal.svelte.js';
  import type { SecretsController } from '$lib/client/secrets.svelte.js';
  import SelectCheckbox from '$lib/components/data-table/select-checkbox.svelte';
  import SortHeader from '$lib/components/data-table/sort-header.svelte';
  import AddSecretDialog from '$lib/components/secrets/add-secret-dialog.svelte';
  import ExportDialog from '$lib/components/secrets/export-dialog.svelte';
  import ImportDialog from '$lib/components/secrets/import-dialog.svelte';
  import RenameDialog from '$lib/components/secrets/rename-dialog.svelte';
  import SecretActionsCell from '$lib/components/secrets/secret-actions-cell.svelte';
  import SecretKeyCell from '$lib/components/secrets/secret-key-cell.svelte';
  import SecretMetaCell from '$lib/components/secrets/secret-meta-cell.svelte';
  import SecretValueCell from '$lib/components/secrets/secret-value-cell.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import { ButtonGroup } from '$lib/components/ui/button-group/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { createSvelteTable, FlexRender, renderComponent } from '$lib/components/ui/data-table/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as InputGroup from '$lib/components/ui/input-group/index.js';
  import { Kbd } from '$lib/components/ui/kbd/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * The secrets table.
   *
   * Sorting, filtering and selection come from TanStack through the registry's
   * `data-table` shell -- none of it is hand-rolled. The cells that matter are
   * components rendered through `renderComponent`, which is what keeps the
   * masked value cell (`input-group`) a single self-contained control rather
   * than markup smeared across a column definition.
   */

  let { controller }: { controller: SecretsController } = $props();

  let sorting = $state<SortingState>([{ id: 'key', desc: false }]);
  let columnFilters = $state<ColumnFiltersState>([]);
  let rowSelection = $state<RowSelectionState>({});
  let columnVisibility = $state<VisibilityState>({});
  let filter = $state('');

  let renaming = $state<SecretListEntry | null>(null);
  let renameOpen = $state(false);
  let pendingDelete = $state<string[]>([]);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  function apply<T>(updater: Updater<T>, current: T): T {
    return typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
  }

  function askRename(row: SecretListEntry) {
    renaming = row;
    renameOpen = true;
  }

  function askDelete(keys: string[]) {
    pendingDelete = keys;
    deleteOpen = true;
  }

  const columns: ColumnDef<SecretListEntry>[] = [
    {
      id: 'select',
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) =>
        renderComponent(SelectCheckbox, {
          checked: table.getIsAllRowsSelected(),
          indeterminate: table.getIsSomeRowsSelected(),
          label: 'Select every secret',
          onCheckedChange: (value: boolean) => table.toggleAllRowsSelected(value)
        }),
      cell: ({ row }) =>
        renderComponent(SelectCheckbox, {
          checked: row.getIsSelected(),
          label: `Select ${row.original.key}`,
          onCheckedChange: (value: boolean) => row.toggleSelected(value)
        })
    },
    {
      accessorKey: 'key',
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Key' }),
      cell: ({ row }) => renderComponent(SecretKeyCell, { row: row.original }),
      filterFn: 'includesString'
    },
    {
      id: 'value',
      enableSorting: false,
      header: () => 'Value',
      cell: ({ row }) => renderComponent(SecretValueCell, { row: row.original, controller })
    },
    {
      accessorKey: 'updatedAt',
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Last change' }),
      cell: ({ row }) => renderComponent(SecretMetaCell, { row: row.original })
    },
    {
      id: 'actions',
      enableSorting: false,
      enableHiding: false,
      header: () => '',
      cell: ({ row }) =>
        renderComponent(SecretActionsCell, {
          row: row.original,
          controller,
          onRename: askRename,
          onDelete: askDelete
        })
    }
  ];

  const table = createSvelteTable({
    get data() {
      return controller.rows;
    },
    columns,
    // Keyed by the secret name rather than the row index, so a selection
    // survives a sort, a filter and a refresh after a write.
    getRowId: (row) => row.key,
    state: {
      get sorting() {
        return sorting;
      },
      get columnFilters() {
        return columnFilters;
      },
      get rowSelection() {
        return rowSelection;
      },
      get columnVisibility() {
        return columnVisibility;
      }
    },
    onSortingChange: (updater) => (sorting = apply(updater, sorting)),
    onColumnFiltersChange: (updater) => (columnFilters = apply(updater, columnFilters)),
    onRowSelectionChange: (updater) => (rowSelection = apply(updater, rowSelection)),
    onColumnVisibilityChange: (updater) => (columnVisibility = apply(updater, columnVisibility)),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel()
  });

  const selectedKeys = $derived(table.getSelectedRowModel().rows.map((row) => row.original.key));
  const visibleRows = $derived(table.getRowModel().rows);

  /** `/` focuses the filter, the way every table on the internet behaves. */
  $effect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      searchInput?.focus();
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  async function confirmDelete() {
    deleting = true;
    try {
      await controller.remove(pendingDelete);
      toast.success(`Deleted ${pluralise(pendingDelete.length, 'secret')}.`);
      rowSelection = {};
      deleteOpen = false;
      pendingDelete = [];
    } catch (error) {
      toast.error('Delete failed', {
        description: error instanceof Error ? error.message : 'Something went wrong.'
      });
    } finally {
      deleting = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <InputGroup.Root class="max-w-xs">
      <InputGroup.Addon>
        <SearchIcon aria-hidden="true" />
      </InputGroup.Addon>
      <InputGroup.Input
        bind:ref={searchInput}
        bind:value={filter}
        placeholder="Filter keys"
        aria-label="Filter secrets by key name"
        autocomplete="off"
        spellcheck="false"
        oninput={() => table.getColumn('key')?.setFilterValue(filter)}
      />
      <InputGroup.Addon align="inline-end">
        <Kbd>/</Kbd>
      </InputGroup.Addon>
    </InputGroup.Root>

    <ButtonGroup class="ml-auto">
      <ImportDialog {controller} />
      <ExportDialog {controller} />
    </ButtonGroup>

    <Popover.Root>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="outline">Columns</Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content class="w-56" align="end">
        <p class="mb-2 text-sm font-medium">Visible columns</p>
        <div class="space-y-2">
          {#each table.getAllColumns().filter((column) => column.getCanHide()) as column (column.id)}
            <div class="flex items-center gap-2">
              <Checkbox
                id="column-{column.id}"
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(value === true)}
              />
              <Label for="column-{column.id}" class="capitalize">{column.id}</Label>
            </div>
          {/each}
        </div>
      </Popover.Content>
    </Popover.Root>

    <AddSecretDialog {controller} />
  </div>

  {#if controller.unreadableCount > 0}
    <Alert.Root variant="destructive">
      <ShieldAlertIcon aria-hidden="true" />
      <Alert.Title>
        {pluralise(controller.unreadableCount, 'value')} in this environment cannot be decrypted
      </Alert.Title>
      <Alert.Description>
        Each affected row is marked below. This is never treated as a missing key: an export of
        this environment will fail rather than quietly produce a shorter file, and every attempt
        is recorded in the audit log with outcome <code class="font-mono">error</code>.
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if selectedKeys.length > 0}
    <div class="bg-muted/50 flex flex-wrap items-center gap-3 rounded-md border p-2">
      <span class="text-sm font-medium">{pluralise(selectedKeys.length, 'secret')} selected</span>
      <Button variant="ghost" size="sm" onclick={() => (rowSelection = {})}>Clear</Button>
      <Button
        variant="destructive"
        size="sm"
        class="ml-auto"
        onclick={() => askDelete(selectedKeys)}
      >
        <Trash2Icon aria-hidden="true" />
        Delete selected
      </Button>
    </div>
  {/if}

  <div class="rounded-md border">
    <Table.Root>
      <Table.Caption class="sr-only">
        Secrets in {controller.environment}. Values are hidden until revealed.
      </Table.Caption>
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
        {#each visibleRows as row (row.id)}
          <Table.Row data-state={row.getIsSelected() ? 'selected' : undefined}>
            {#each row.getVisibleCells() as cell (cell.id)}
              <Table.Cell class={cell.column.id === 'value' ? 'min-w-72' : undefined}>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/each}
          </Table.Row>
        {:else}
          <Table.Row>
            <Table.Cell colspan={columns.length} class="p-0">
              <Empty.Root>
                <Empty.Header>
                  <Empty.Media variant="icon">
                    <KeyRoundIcon aria-hidden="true" />
                  </Empty.Media>
                  <Empty.Title>
                    {filter ? `Nothing matches "${filter}"` : 'No secrets here yet'}
                  </Empty.Title>
                  <Empty.Description>
                    {#if filter}
                      Clear the filter to see the rest of this environment.
                    {:else}
                      Add one by hand, or import an existing
                      <code class="font-mono text-xs">.env</code> file and check the diff before
                      it is applied.
                    {/if}
                  </Empty.Description>
                </Empty.Header>
                <Empty.Content>
                  {#if filter}
                    <Button variant="outline" onclick={() => {
                      filter = '';
                      table.getColumn('key')?.setFilterValue('');
                    }}>
                      Clear filter
                    </Button>
                  {:else}
                    <div class="flex flex-wrap justify-center gap-2">
                      <AddSecretDialog {controller} />
                      <ImportDialog {controller} />
                    </div>
                  {/if}
                </Empty.Content>
              </Empty.Root>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>

  <div class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
    <span>{pluralise(visibleRows.length, 'row')} shown</span>
    <span aria-hidden="true">·</span>
    <span>Environment revision <code class="font-mono">{controller.rev}</code></span>
    {#if reveal.anyRevealed}
      <Badge variant="outline">{reveal.size} revealed</Badge>
      <Button variant="ghost" size="xs" onclick={() => reveal.wipe()}>Hide all</Button>
    {/if}
  </div>
</div>

<RenameDialog {controller} bind:row={renaming} bind:open={renameOpen} />

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title class="flex items-center gap-2">
        <TriangleAlertIcon class="text-destructive size-4" aria-hidden="true" />
        Delete {pluralise(pendingDelete.length, 'secret')}
      </AlertDialog.Title>
      <AlertDialog.Description>
        <span class="block">
          {pendingDelete.join(', ')}
        </span>
        <span class="mt-2 block">
          The current value is removed and a tombstone version is recorded, so the history stays
          intact and a later key of the same name continues the version sequence rather than
          restarting at 1. The value itself is not recoverable from this app.
        </span>
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
      <button
        type="button"
        class={buttonVariants({ variant: 'destructive' })}
        disabled={deleting}
        onclick={confirmDelete}
      >
        {deleting ? 'Deleting…' : 'Delete'}
      </button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
