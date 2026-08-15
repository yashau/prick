<script lang="ts">
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';

  import { Button } from '$lib/components/ui/button/index.js';

  /**
   * A sortable column header for the registry's data-table shell.
   *
   * TanStack owns the sort STATE; this only renders it and toggles it.
   *
   * The prop is typed STRUCTURALLY rather than as `Column<TData, TValue>`. A
   * generic component reached through `renderComponent` has its parameters
   * resolved to `unknown` by `ComponentProps`, so a `Column<SecretListEntry>`
   * no longer matches -- `TData` is invariant. Naming the two methods this
   * component actually calls makes any TanStack column assignable and states
   * the real dependency.
   */
  interface SortableColumn {
    getIsSorted(): false | 'asc' | 'desc';
    toggleSorting(desc?: boolean): void;
  }

  let {
    column,
    label
  }: {
    column: SortableColumn;
    label: string;
  } = $props();

  const direction = $derived(column.getIsSorted());
</script>

<Button
  variant="ghost"
  size="sm"
  class="-ml-2.5 h-8"
  onclick={() => column.toggleSorting(direction === 'asc')}
>
  {label}
  {#if direction === 'asc'}
    <ArrowUpIcon aria-hidden="true" />
    <span class="sr-only">, sorted ascending</span>
  {:else if direction === 'desc'}
    <ArrowDownIcon aria-hidden="true" />
    <span class="sr-only">, sorted descending</span>
  {:else}
    <ChevronsUpDownIcon class="opacity-50" aria-hidden="true" />
    <span class="sr-only">, not sorted</span>
  {/if}
</Button>
