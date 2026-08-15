<script lang="ts">
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';

  /**
   * Row/header selection for the data-table shell.
   *
   * `indeterminate` is a real third state, not a styling flourish: with it, a
   * partially selected page reads as "some" to assistive technology instead of
   * lying in one direction or the other.
   */
  let {
    checked,
    indeterminate = false,
    label,
    onCheckedChange
  }: {
    checked: boolean;
    indeterminate?: boolean;
    /** Never rendered visually; this is the control's accessible name. */
    label: string;
    onCheckedChange: (value: boolean) => void;
  } = $props();
</script>

<Checkbox
  {checked}
  {indeterminate}
  aria-label={label}
  onCheckedChange={(value) => onCheckedChange(value === true)}
/>
