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
      {#each options as option (option.value)}
        {@const Icon = option.icon}
        <DropdownMenu.CheckboxItem
          checked={current === option.value}
          onCheckedChange={() => setMode(option.value)}
        >
          <Icon class="mr-2 size-4" aria-hidden="true" />
          {option.label}
        </DropdownMenu.CheckboxItem>
      {/each}
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>
