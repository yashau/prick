<script lang="ts">
  import { page } from '$app/state';

  // The secrets table. Client-rendered only -- see +layout.ts in this
  // directory for why.
  //
  // TODO(build order step 15): shadcn-svelte registry components --
  // data-table, table, input, input-group, button, button-group, checkbox,
  // dropdown-menu, dialog, alert-dialog, badge, tooltip, switch, skeleton,
  // empty, sonner, popover, separator, kbd, textarea, field.
  //
  // Specifically NOT hand-rolled:
  //   `data-table`  -- TanStack headless + the shadcn shell gives sorting,
  //                    filtering and selection.
  //   `input-group` -- the masked value cell is one control: mono input + eye
  //                    toggle + copy button.
  //
  // Behaviour that belongs here rather than in a component:
  //   - Copy FETCHES the value on demand instead of reading it out of memory,
  //     so every copy produces an audit row with reason "copy".
  //   - Clipboard cleared after 30 s, but only if the document still has focus.
  //   - No `execCommand` fallback: it requires putting the value in the DOM.
  //   - Secret inputs carry data-1p-ignore / data-lpignore / data-bwignore so
  //     password managers do not capture and sync secret values.
</script>

<h1>{page.params.project} / {page.params.env}</h1>
<p>Secrets</p>
