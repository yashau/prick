<script lang="ts">
  import { page } from '$app/state';

  // Environments screen. Server-rendered: it carries names, slugs and counts,
  // never a value.
  //
  // TODO(build order step 15): shadcn-svelte registry components --
  // card, tabs, badge, button, separator, progress, hover-card, item.
</script>

<h1>{page.params.project}</h1>
<p>Environments</p>
