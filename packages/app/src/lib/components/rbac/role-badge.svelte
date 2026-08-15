<script lang="ts">
  import type { Role } from '@prick/shared';

  import { Badge } from '$lib/components/ui/badge/index.js';

  /**
   * A role, as a word.
   *
   * The variant only reinforces the word; it never replaces it. Colour is not
   * information here — a reader with a monochrome display, or with any of the
   * common colour-vision deficiencies, must be able to tell `admin` from
   * `reader` at a glance, and the only thing that guarantees that is the label.
   *
   * `null` is the disabled case and is rendered as "none" rather than as a
   * blank cell: an empty space and "this identity holds nothing here" are the
   * same pixels and opposite meanings.
   */

  let {
    role,
    /** Softens the badge for a source row, so the effective role stays dominant. */
    muted = false
  }: {
    role: Role | null;
    muted?: boolean;
  } = $props();

  const variant = $derived(
    role === null ? 'outline' : muted ? 'outline' : role === 'admin' ? 'default' : 'secondary'
  );
</script>

<Badge {variant} class="font-mono text-xs">{role ?? 'none'}</Badge>
