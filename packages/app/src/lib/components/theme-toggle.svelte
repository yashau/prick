<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import MoonIcon from '@lucide/svelte/icons/moon';
  import SunIcon from '@lucide/svelte/icons/sun';
  import { setMode, userPrefersMode } from 'mode-watcher';

  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

  /**
   * Three states, not two: "system" is a real choice and dropping it means a
   * user who has told their OS they need the dark palette has to tell this app
   * again, on every device.
   */
  const options = [
    { value: 'light', label: 'Light', icon: SunIcon },
    { value: 'dark', label: 'Dark', icon: MoonIcon },
    { value: 'system', label: 'System', icon: MonitorIcon }
  ] as const;

  /**
   * The PREFERENCE, not the resolved mode -- so "System" is the row that shows
   * as selected for a user who chose it, rather than whichever of light/dark
   * their OS happens to be reporting. The trigger icon reflects the resolved
   * mode instead (it keys off the `dark` class), which is the right split: the
   * menu answers "what did I choose" and the button answers "what am I
   * looking at".
   */
  const current = $derived(userPrefersMode.current);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon-sm">
        <SunIcon class="size-4 scale-100 rotate-0 dark:scale-0 dark:-rotate-90" aria-hidden="true" />
        <MoonIcon
          class="absolute size-4 scale-0 rotate-90 dark:scale-100 dark:rotate-0"
          aria-hidden="true"
        />
        <span class="sr-only">Change colour theme</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    <DropdownMenu.Group>
      <DropdownMenu.GroupHeading>Theme</DropdownMenu.GroupHeading>
      <!--
        A RADIO group, not three checkboxes. The three options are mutually
        exclusive, and `menuitemcheckbox` announces each one as an independent
        on/off — so a screen reader user hears "Light, not checked. Dark,
        checked. System, not checked." as three unrelated facts rather than one
        choice with three positions. `menuitemradio` is the same click and the
        correct sentence.
      -->
      <DropdownMenu.RadioGroup
        value={current}
        onValueChange={(value) => setMode(value as (typeof options)[number]['value'])}
      >
        {#each options as option (option.value)}
          {@const Icon = option.icon}
          <DropdownMenu.RadioItem value={option.value}>
            <Icon class="mr-2 size-4" aria-hidden="true" />
            {option.label}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>
