<script lang="ts">
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * The loading state for the secrets table.
   *
   * A skeleton that MATCHES the final layout, not a centred spinner: this
   * screen is client-rendered by design (`ssr = false` in the layout above it),
   * so the first paint is always empty and a spinner would make the whole page
   * jump when the rows land. Same column widths, same row height, same count
   * as a typical environment.
   */
  let { rows = 5 }: { rows?: number } = $props();
</script>

<Table.Root>
  <Table.Caption class="sr-only">Loading secrets…</Table.Caption>
  <Table.Header>
    <Table.Row>
      <Table.Head class="w-10"></Table.Head>
      <Table.Head class="w-[28%]">Key</Table.Head>
      <Table.Head>Value</Table.Head>
      <Table.Head class="w-44">Last change</Table.Head>
      <Table.Head class="w-12"></Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each { length: rows } as _, index (index)}
      <Table.Row>
        <Table.Cell><Skeleton class="size-4 rounded-sm" /></Table.Cell>
        <Table.Cell><Skeleton class="h-5 w-40" /></Table.Cell>
        <Table.Cell><Skeleton class="h-9 w-full" /></Table.Cell>
        <Table.Cell>
          <Skeleton class="h-3 w-20" />
          <Skeleton class="mt-1 h-3 w-28" />
        </Table.Cell>
        <Table.Cell><Skeleton class="size-8 rounded-md" /></Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table.Root>
