<script lang="ts">
  import LockIcon from '@lucide/svelte/icons/lock';
  import SearchXIcon from '@lucide/svelte/icons/search-x';
  import ServerCrashIcon from '@lucide/svelte/icons/server-crash';

  import { page } from '$app/state';
  import CopyButton from '$lib/components/copy-button.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import { Kbd } from '$lib/components/ui/kbd/index.js';

  /**
   * One error page for every failure the router can produce.
   *
   * The request id is the point of this screen. It is echoed as `X-Request-Id`
   * and stored on the audit row for the same event, so "paste me the id in the
   * red box" is a complete support interaction: an admin can find the exact
   * event, including a denial the user was never told the reason for.
   *
   * 403 says nothing about WHY, and that is deliberate at the API too: a 404
   * for an invisible project and a 404 for a project that does not exist are
   * indistinguishable on purpose, because the alternative is an oracle for
   * "which project names are in use".
   */

  const status = $derived(page.status);
  const requestId = $derived(page.error?.requestId ?? null);
  const code = $derived(page.error?.code ?? null);
  const hint = $derived(page.error?.hint ?? null);

  const copy = $derived.by(() => {
    if (status === 403) {
      return {
        title: 'Not your grant',
        body: 'You are signed in, but nothing you hold covers this. Ask an administrator to grant you access to this project or environment.'
      };
    }
    if (status === 404) {
      return {
        title: 'Nothing here',
        body: 'This page does not exist, or it belongs to something you cannot see. Those two look the same from here, on purpose.'
      };
    }
    if (status === 401) {
      return {
        title: 'Not signed in',
        body: 'Your session with the identity provider has ended. Reloading will start it again.'
      };
    }
    return {
      title: 'Something broke',
      body: page.error?.message ?? 'The server could not complete that request.'
    };
  });
</script>

<svelte:head>
  <title>{status} · prick</title>
</svelte:head>

<div class="flex min-h-svh items-center justify-center p-6">
  <Empty.Root class="max-w-xl border">
    <Empty.Header>
      <Empty.Media variant="icon">
        {#if status === 403 || status === 401}
          <LockIcon aria-hidden="true" />
        {:else if status === 404}
          <SearchXIcon aria-hidden="true" />
        {:else}
          <ServerCrashIcon aria-hidden="true" />
        {/if}
      </Empty.Media>
      <Empty.Title>
        <!-- The number is never the only signal: it is always paired with prose. -->
        {status} — {copy.title}
      </Empty.Title>
      <Empty.Description>{copy.body}</Empty.Description>
    </Empty.Header>

    <Empty.Content>
      {#if hint}
        <p class="text-muted-foreground text-sm">{hint}</p>
      {/if}

      {#if requestId || code}
        <div
          class="bg-muted/50 flex w-full flex-col gap-2 rounded-md border p-3 text-left text-sm"
        >
          {#if code}
            <div class="flex items-center justify-between gap-3">
              <span class="text-muted-foreground">Code</span>
              <code class="font-mono text-xs">{code}</code>
            </div>
          {/if}
          {#if requestId}
            <div class="flex items-center justify-between gap-3">
              <span class="text-muted-foreground">Request id</span>
              <span class="flex items-center gap-1">
                <code class="font-mono text-xs break-all">{requestId}</code>
                <CopyButton text={requestId} label="Copy request id" size="icon-xs" />
              </span>
            </div>
          {/if}
        </div>
        <p class="text-muted-foreground text-xs">
          An administrator can find the matching row in the audit log with that id.
        </p>
      {/if}

      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button href="/projects">Back to projects</Button>
        <Button variant="outline" onclick={() => location.reload()}>Reload</Button>
      </div>

      <p class="text-muted-foreground text-xs">
        <Kbd>{'⌘'}</Kbd>
        <Kbd>K</Kbd>
        opens the command palette from anywhere.
      </p>
    </Empty.Content>
  </Empty.Root>
</div>
