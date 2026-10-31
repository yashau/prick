<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import {
    createSortedRowModel,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    sortFn_text,
    tableFeatures,
    type ColumnDef,
    type SortingState,
    type Updater
  } from '@tanstack/table-core';
  import type { Snippet } from 'svelte';

  import type { ServiceTokenRecord } from '#lib/client/api.js';
  import SortHeader from '#lib/components/data-table/sort-header.svelte';
  import TokenActionsCell from '#lib/components/service-tokens/token-actions-cell.svelte';
  import TokenClientIdCell from '#lib/components/service-tokens/token-client-id-cell.svelte';
  import TokenExpiryCell from '#lib/components/service-tokens/token-expiry-cell.svelte';
  import TokenLastSeenCell from '#lib/components/service-tokens/token-last-seen-cell.svelte';
  import TokenNameCell from '#lib/components/service-tokens/token-name-cell.svelte';
  import TokenStatusCell from '#lib/components/service-tokens/token-status-cell.svelte';
  import { createSvelteTable, FlexRender, renderComponent } from '#lib/components/ui/data-table/index.js';
  import * as Empty from '#lib/components/ui/empty/index.js';
  import * as Table from '#lib/components/ui/table/index.js';

  /**
   * The managed service tokens, through the registry's TanStack shell.
   *
   * Every cell is its own component, and every action is a callback: the page
   * owns the API calls and the dialogs, so this table renders and nothing else.
   */

  let {
    tokens,
    onRotate,
    onRefresh,
    onRevoke,
    empty
  }: {
    tokens: ServiceTokenRecord[];
    onRotate: (token: ServiceTokenRecord) => void;
    onRefresh: (token: ServiceTokenRecord) => void;
    onRevoke: (token: ServiceTokenRecord) => void;
    /** Rendered inside the empty state, typically the create button. */
    empty?: Snippet;
  } = $props();

  let sorting = $state<SortingState>([{ id: 'name', desc: false }]);

  function apply<T>(updater: Updater<T>, current: T): T {
    return typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
  }

  const features = tableFeatures({
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic }
  });

  /** A token that never expires sorts after every one that does. */
  const expirySortKey = (token: ServiceTokenRecord): number =>
    token.cloudflare?.expiresAt ?? Number.MAX_SAFE_INTEGER;

  const columns: ColumnDef<typeof features, ServiceTokenRecord>[] = [
    {
      id: 'name',
      accessorFn: (token) => (token.name ?? token.cloudflareName).toLowerCase(),
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Name' }),
      cell: ({ row }) => renderComponent(TokenNameCell, { token: row.original }),
      sortFn: 'text'
    },
    {
      id: 'clientId',
      enableSorting: false,
      header: () => 'Client id',
      cell: ({ row }) => renderComponent(TokenClientIdCell, { token: row.original })
    },
    {
      id: 'status',
      accessorFn: (token) => token.status,
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Status' }),
      cell: ({ row }) => renderComponent(TokenStatusCell, { token: row.original }),
      sortFn: 'text'
    },
    {
      id: 'expiry',
      accessorFn: expirySortKey,
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Expiry' }),
      cell: ({ row }) => renderComponent(TokenExpiryCell, { token: row.original }),
      sortFn: 'basic'
    },
    {
      id: 'lastSeen',
      accessorFn: (token) => token.cloudflare?.lastSeenAt ?? 0,
      header: ({ column }) => renderComponent(SortHeader, { column, label: 'Last seen' }),
      cell: ({ row }) => renderComponent(TokenLastSeenCell, { token: row.original }),
      sortFn: 'basic'
    },
    {
      id: 'actions',
      enableSorting: false,
      header: () => '',
      cell: ({ row }) =>
        renderComponent(TokenActionsCell, { token: row.original, onRotate, onRefresh, onRevoke })
    }
  ];

  const table = createSvelteTable({
    features,
    get data() {
      return tokens;
    },
    columns,
    getRowId: (token) => token.id,
    state: {
      get sorting() {
        return sorting;
      }
    },
    onSortingChange: (updater) => (sorting = apply(updater, sorting))
  });

  const rows = $derived(table.getRowModel().rows);
</script>

<div class="rounded-md border">
  <Table.Root>
    <Table.Caption class="sr-only">
      Service tokens this deployment manages, with Cloudflare's view of each.
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
                <FlexRender {header} />
              {/if}
            </Table.Head>
          {/each}
        </Table.Row>
      {/each}
    </Table.Header>
    <Table.Body>
      {#each rows as row (row.id)}
        <Table.Row data-status={row.original.status}>
          {#each row.getAllCells() as cell (cell.id)}
            <Table.Cell>
              <FlexRender {cell} />
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
                <Empty.Title>No service tokens</Empty.Title>
                <Empty.Description>
                  A service token lets a CI job or a server call prick without a person signing
                  in. Create one here and it can hold a grant from the moment it exists.
                </Empty.Description>
              </Empty.Header>
              {#if empty}
                <Empty.Content>{@render empty()}</Empty.Content>
              {/if}
            </Empty.Root>
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>
