/**
 * The data-table shell: TanStack Table's own Svelte 5 adapter.
 *
 * `createSvelteTable` builds a table whose state lives in rune-backed atoms, so
 * every table API read in a template, `$derived` or `$effect` tracks the state
 * it depends on. Every table in the app imports from here, which keeps the
 * adapter swappable in one place.
 */
export {
  createTable as createSvelteTable,
  FlexRender,
  renderComponent,
  renderSnippet,
} from "@tanstack/svelte-table";
