<script lang="ts">
  import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import UserIcon from '@lucide/svelte/icons/user';
  import UsersIcon from '@lucide/svelte/icons/users';

  import type { Role } from '@prick/shared';

  import { expiryLabel } from '$lib/client/format';
  import RoleBadge from '$lib/components/rbac/role-badge.svelte';
  import ScopeLabel from '$lib/components/rbac/scope-label.svelte';
  import type { EffectiveScopeView, PermissionSourceView } from '$lib/components/rbac/types';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import * as Empty from '$lib/components/ui/empty/index.js';
  import * as Table from '$lib/components/ui/table/index.js';

  /**
   * Why this identity can do what it can do.
   *
   * ---------------------------------------------------------------------------
   * THE QUESTION THIS SCREEN ANSWERS
   * ---------------------------------------------------------------------------
   * Not "what is Bob's role" — an answer of `admin` leaves the real question
   * exactly as hard as it was. The question is "why does Bob have production,
   * and what do I remove to stop that", and with groups in the model it is
   * genuinely hard: the answer can be a grant on the environment, a grant on
   * its project, a global grant, any of those held by a group Bob is in, or the
   * `BOOTSTRAP_ADMINS` variable — and none of them are visible from Bob's row.
   *
   * It is also not answerable from the two grant lists side by side.
   * `GET /grants` returns DIRECT grants only; a group's grants live under
   * `/groups/{id}/grants`. So "who can read production" cannot be read off
   * either list, and the person who needs it is reading it during an incident.
   *
   * Every entry therefore carries its SOURCES, one of them marked `decisive`,
   * and this component's whole job is to keep that distinction visible: the row
   * that set the role, and the rows that also reach the scope and would not
   * change anything if they were the only ones left.
   *
   * SOURCES INCLUDE COVERING GRANTS — a global grant appears under an
   * environment entry, because "the platform group has admin everywhere" IS the
   * answer to why Bob has that environment. The "Granted at" column is where
   * the grant sits, which is often broader than the scope it is explaining.
   */

  let {
    scopes,
    /** Named in the empty state and in the disabled banner. */
    subject,
    disabled = false
  }: {
    scopes: EffectiveScopeView[];
    subject: string;
    disabled?: boolean;
  } = $props();

  function scopeKey(entry: EffectiveScopeView): string {
    return `${entry.scopeType}:${entry.projectSlug ?? ''}:${entry.environmentSlug ?? ''}`;
  }

  function whereGranted(source: PermissionSourceView): string {
    if (source.scopeType === 'global') return 'everything';
    if (source.scopeType === 'project') return `project ${source.projectSlug ?? '—'}`;
    if (source.projectSlug === null) return `environment ${source.environmentSlug ?? '—'}`;
    return `${source.projectSlug}/${source.environmentSlug ?? '—'}`;
  }

  /** "a writer grant", "an admin grant". One vowel, and a sentence that reads. */
  function article(role: Role): string {
    return role === 'admin' ? 'an' : 'a';
  }

  /**
   * One sentence naming the row to remove.
   *
   * "Remove this" is the thing the reader came for, and it is stated rather
   * than left to be derived from a table they have to rank themselves.
   */
  function because(entry: EffectiveScopeView): string {
    if (entry.role === null) {
      return `${subject} is disabled, so this confers nothing. The kill switch outranks every grant at every scope; the sources below are what would come back if the identity were re-enabled.`;
    }

    const decisive = entry.sources.find((source) => source.decisive);
    if (decisive === undefined) return '';

    if (decisive.via === 'bootstrap') {
      return `${entry.role} here comes from BOOTSTRAP_ADMINS — a variable, not a row. Nothing in this UI can revoke it; remove the subject from the variable and redeploy.`;
    }

    if (decisive.via === 'group') {
      return `${entry.role} here comes from the ${decisive.group?.slug ?? '—'} group, which holds ${article(decisive.role)} ${decisive.role} grant on ${whereGranted(decisive)}. Removing this identity from that group, or revoking that grant, takes it away.`;
    }

    return `${entry.role} here comes from a direct ${decisive.role} grant on ${whereGranted(decisive)}. Revoking that grant takes it away.`;
  }
</script>

{#if scopes.length === 0}
  <Empty.Root class="border">
    <Empty.Header>
      <Empty.Media variant="icon">
        <ShieldOffIcon aria-hidden="true" />
      </Empty.Media>
      <Empty.Title>No access anywhere</Empty.Title>
      <Empty.Description>
        Nothing grants {subject} a role at any scope — not directly, not through a group, and not
        through BOOTSTRAP_ADMINS. Every request it makes is a 404 or a 403.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  {#if disabled}
    <p class="text-sm font-medium">
      This identity is disabled, so every role below reads <code class="font-mono">none</code>.
      The sources are still listed: deciding whether it is safe to re-enable an identity means
      knowing what it gets back.
    </p>
  {/if}

  <ul class="space-y-4">
    {#each scopes as entry (scopeKey(entry))}
      <li class="rounded-md border">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h3 class="text-sm font-semibold">
            <ScopeLabel
              scopeType={entry.scopeType}
              projectSlug={entry.projectSlug}
              environmentSlug={entry.environmentSlug}
            />
          </h3>
          <span class="flex items-center gap-2 text-sm">
            <span class="text-muted-foreground">Effective role</span>
            <RoleBadge role={entry.role} />
          </span>
        </div>

        <p class="text-muted-foreground px-4 pt-3 text-sm">{because(entry)}</p>

        <div class="px-4 pt-3 pb-4">
          <Table.Root>
            <Table.Caption class="sr-only">
              Every live grant that reaches {entry.scopeType === 'global'
                ? 'every scope in this install'
                : (entry.environmentSlug ?? entry.projectSlug ?? 'this scope')}, strongest first.
            </Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Source</Table.Head>
                <Table.Head class="w-24">Role</Table.Head>
                <Table.Head class="w-48">Granted at</Table.Head>
                <Table.Head class="w-40">Expiry</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each entry.sources as source, index (source.grantId ?? `bootstrap-${String(index)}`)}
                <Table.Row class={source.decisive ? 'bg-muted/50' : undefined}>
                  <Table.Cell>
                    <span class="flex flex-wrap items-center gap-2">
                      {#if source.via === 'group'}
                        <UsersIcon class="size-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          group
                          <a
                            class="font-mono underline underline-offset-4"
                            href="/groups/{source.group?.id ?? ''}"
                          >
                            {source.group?.slug ?? '—'}
                          </a>
                        </span>
                      {:else if source.via === 'bootstrap'}
                        <TerminalIcon class="size-3.5 shrink-0" aria-hidden="true" />
                        <span><code class="font-mono text-xs">BOOTSTRAP_ADMINS</code></span>
                      {:else}
                        <UserIcon class="size-3.5 shrink-0" aria-hidden="true" />
                        <span>direct grant</span>
                      {/if}

                      {#if source.decisive}
                        <!--
                          The word, not just the shaded row. A background tint is
                          invisible to a screen reader and to anyone reading this
                          in high contrast.
                        -->
                        <Badge variant="default">decisive</Badge>
                      {/if}
                    </span>
                  </Table.Cell>
                  <Table.Cell><RoleBadge role={source.role} muted={!source.decisive} /></Table.Cell>
                  <Table.Cell>
                    <ScopeLabel
                      scopeType={source.scopeType}
                      projectSlug={source.projectSlug}
                      environmentSlug={source.environmentSlug}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <span class="text-muted-foreground text-sm">
                      {expiryLabel(source.expiresAt)}
                    </span>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </li>
    {/each}
  </ul>
{/if}
