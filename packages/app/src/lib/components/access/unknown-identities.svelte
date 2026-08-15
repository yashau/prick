<script lang="ts">
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import SearchIcon from '@lucide/svelte/icons/search';
  import UserIcon from '@lucide/svelte/icons/user';

  import type { UnknownIdentity } from '$lib/client/api';
  import { absoluteTime, pluralise, relativeTime } from '$lib/client/format';
  import CopyButton from '$lib/components/copy-button.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Item from '$lib/components/ui/item/index.js';

  /**
   * "Seen but not granted".
   *
   * This exists because of one fact about Cloudflare Access service tokens:
   * `common_name` is an opaque hex string like
   * `e367826f93b8d71185e03fe518aff3b4.access`, and nobody can map that to
   * "staging deploy" by looking at it. Asking an operator to type it in before
   * anything has ever used it is asking them to transcribe a UUID correctly
   * from a different browser tab.
   *
   * Because denials are audited, they can be read back out of the log. That
   * turns provisioning CI into: point it at prick, watch it 403, click Grant.
   * It is the single highest-value screen in the app, and it costs nothing --
   * the data was already being written.
   */

  let {
    identities,
    onGrant
  }: {
    identities: UnknownIdentity[];
    /** Opens the grant dialog pre-filled with this subject. */
    onGrant: (identity: UnknownIdentity) => void;
  } = $props();
</script>

{#if identities.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <SearchIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>Nothing has been turned away</Empty.Title>
      <Empty.Description>
        Any identity that authenticates with Cloudflare Access and is then denied shows up here,
        so a new CI token does not have to be transcribed by hand.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="space-y-3">
    <Alert.Root>
      <SearchIcon aria-hidden="true" />
      <Alert.Title>
        {pluralise(identities.length, 'identity', 'identities')} authenticated and were denied
      </Alert.Title>
      <Alert.Description>
        Access let them through the edge; no grant covered what they asked for. Granting from here
        avoids retyping an opaque service-token subject.
      </Alert.Description>
    </Alert.Root>

    <Item.Group class="gap-2">
      {#each identities as identity (identity.subject)}
        <!--
          `role="listitem"`, because the registry's `Item.Group` is a
          `div role="list"` and a list whose owned children are the `Grant…` and
          copy-subject buttons is announced as a list of controls with no items
          in it. See the same note in `audit/audit-item.svelte`.
        -->
        <Item.Root variant="outline" role="listitem">
          <Item.Media variant="icon">
            {#if identity.kind === 'service'}
              <KeyRoundIcon aria-hidden="true" />
              <span class="sr-only">service token</span>
            {:else}
              <UserIcon aria-hidden="true" />
              <span class="sr-only">user</span>
            {/if}
          </Item.Media>

          <Item.Content>
            <Item.Title class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-sm break-all">{identity.subject}</code>
              <CopyButton text={identity.subject} label="Copy subject" size="icon-xs" />
              <Badge variant="outline">
                {pluralise(identity.attempts, 'attempt')}
              </Badge>
            </Item.Title>
            <Item.Description>
              First seen
              <time
                datetime={new Date(identity.firstSeenAt).toISOString()}
                title={absoluteTime(identity.firstSeenAt)}
              >
                {relativeTime(identity.firstSeenAt)}
              </time>
              · last
              <time
                datetime={new Date(identity.lastSeenAt).toISOString()}
                title={absoluteTime(identity.lastSeenAt)}
              >
                {relativeTime(identity.lastSeenAt)}
              </time>
            </Item.Description>
          </Item.Content>

          <Item.Actions>
            <Button size="sm" onclick={() => onGrant(identity)}>Grant…</Button>
          </Item.Actions>
        </Item.Root>
      {/each}
    </Item.Group>
  </div>
{/if}
