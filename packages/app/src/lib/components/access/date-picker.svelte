<script lang="ts">
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import {
    DateFormatter,
    getLocalTimeZone,
    today,
    type DateValue
  } from '@internationalized/date';

  import { Button } from '$lib/components/ui/button/index.js';
  import { Calendar } from '$lib/components/ui/calendar/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';

  /**
   * A single-date picker.
   *
   * `date-picker` is NOT a shadcn-svelte registry item -- the registry ships
   * `popover` and `calendar` and documents the picker as the composition of
   * the two. This is that composition and nothing more: no bespoke calendar
   * grid, no hand-rolled keyboard handling. Both come from bits-ui through the
   * registry components.
   */

  let {
    value = $bindable(),
    label,
    placeholder = 'Pick a date',
    /** Days before this are not selectable. Defaults to today. */
    minValue = today(getLocalTimeZone())
  }: {
    value?: DateValue | undefined;
    label: string;
    placeholder?: string;
    minValue?: DateValue;
  } = $props();

  const formatter = new DateFormatter('en-GB', { dateStyle: 'medium' });
  let open = $state(false);
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" class="w-full justify-start font-normal">
        <CalendarIcon aria-hidden="true" />
        {value ? formatter.format(value.toDate(getLocalTimeZone())) : placeholder}
        <span class="sr-only">{label}</span>
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-auto p-0" align="start">
    <Calendar
      type="single"
      bind:value
      {minValue}
      captionLayout="dropdown"
      onValueChange={() => (open = false)}
    />
  </Popover.Content>
</Popover.Root>
