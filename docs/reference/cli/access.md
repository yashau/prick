---
title: prk access
description: Identities and grants — who can reach which project and environment, and why.
sidebar:
  order: 7
---

Cloudflare Access decides who reaches the server. `prk access` decides what they
can do once they are through.

```
prk access list
prk access identities [--denied]
prk access grant <SUBJECT> --role <ROLE> [--scope <SCOPE>] [--expires-in <DAYS>]
prk access revoke <SUBJECT> [--scope <SCOPE>]
prk access disable <SUBJECT>
prk access enable <SUBJECT>
prk access rename <SUBJECT> <NAME>
prk access rename <SUBJECT> --clear
prk access explain <SUBJECT>
prk access token create <NAME> [--role <ROLE> --scope <SCOPE>] [--expires-in <DAYS>] [--duration <HOURS>h|forever] [--secret-file <PATH>|-]
prk access token list [--all]
prk access token rotate <TOKEN> [--grace <DURATION>] [--secret-file <PATH>|-] [--yes]
prk access token refresh <TOKEN>
prk access token revoke <TOKEN> [--yes]
prk access token adopt <CLIENT_ID> [--name <NAME>]
prk access token reconcile [--apply] [--yes]
```

A `<SUBJECT>` is an email address for a person, or a service token's
`common_name` for a machine:

```
you@example.com
e367826f93b8d71185e03fe518aff3b4.access
```

:::note[Which server a write reaches]
`grant`, `revoke`, `disable`, `enable`, `rename` and every `token` subcommand
but `list` change data. Before sending the change, each prints the server it is
going to on stderr, `writing to prick.acme.example (profile acme, instance 3f9c01ab)`,
unless `-q` or `--json` is given; under `--json` its result carries the same
facts as a `destination` object with `server`, `profile` and `instance`. With
two or more profiles, a write needs its server named by `--profile`,
`PRK_PROFILE`, `--api-url`, `PRK_API_URL` or this checkout's
`.prick.local.toml`: the default profile, or a committed `.prick.toml`, alone is
refused with
[`PROFILE_REQUIRED`](/reference/cli/errors#profile_required-exit-2). See
[Working with several servers](/guides/multiple-servers/).
:::

## Roles

| Role     | Can                                         |
| -------- | ------------------------------------------- |
| `reader` | Read secret metadata and values             |
| `writer` | Everything a reader can, plus write secrets |
| `admin`  | Everything a writer can, plus manage grants |

## Scopes

A scope is written `project:environment`, and `*` is a wildcard.

| Scope                | Covers                                 |
| -------------------- | -------------------------------------- |
| `*:*`                | Everything on the server (the default) |
| `billing:*`          | Every environment in `billing`         |
| `billing:production` | One environment                        |

`*:something` is not a scope the server has — an environment only exists inside
a project.

Slugs cannot contain a colon, so `project:environment` is unambiguous.

## `prk access grant`

```bash
prk access grant deploy@example.com --role reader --scope api:production
```

```
Granted reader to `deploy@example.com` on `api:production`.
```

| Flag                  | Values                                        | Default       |
| --------------------- | --------------------------------------------- | ------------- |
| `--role <ROLE>`       | `reader`, `writer`, `admin`                   | Required      |
| `--scope <SCOPE>`     | `project:environment`, either half may be `*` | `*:*`         |
| `--expires-in <DAYS>` | A number of days                              | Never expires |

Grant a whole project:

```bash
prk access grant alice@example.com --role admin --scope billing:*
```

Grant temporary access to a contractor:

```bash
prk access grant contractor@example.com --role reader --scope api:staging --expires-in 30
```

`--expires-in` is converted to an absolute deadline before it is stored, so the
expiry is a fixed moment rather than something the server has to recompute.

:::note[The identity must have authenticated at least once]
The server learns a subject exists when it first authenticates. Granting to a
subject it has never seen fails:

```
error: no identity has authenticated as `deploy@example.com`, so there is nothing to grant a role to yet; have it make one request, then check `prk access identities --denied`
```

Run the job once, let it get a `403`, then grant. `prk access identities
--denied` lists exactly the identities in that state.

A token made with [`prk access token create`](#prk-access-token-create) has an
identity from the moment it exists, so it can be granted straight away.
:::

## `prk access identities`

Every identity the server has seen authenticate.

```bash
prk access identities
```

```
you@example.com	user
alice@example.com	user
e367826f93b8d71185e03fe518aff3b4.access	service
old-ci@example.com	user	DISABLED
```

With nothing to show:

```
No identities have authenticated yet.
```

### Finding a service token that needs a grant

```bash
prk access identities --denied
```

```
e367826f93b8d71185e03fe518aff3b4.access	service	3 attempt(s)
```

```
Grant one of these with `prk access grant <SUBJECT> --role reader --scope <PROJECT>:<ENVIRONMENT>`.
```

`--denied` lists identities that were refused and hold no grant. That is how a
service token introduces itself, and it saves copying an opaque identifier
between two consoles.

If nothing is waiting:

```
Nothing has been denied and left ungranted.
```

## `prk access list`

Grants held **directly**.

```bash
prk access list
```

```
alice@example.com	admin	billing:*
deploy@example.com	reader	api:production
e367826f93b8d71185e03fe518aff3b4.access	writer	api:staging
```

Columns are subject, role, scope.

:::caution[This is half the picture]
`list` shows **direct** grants. Roles held through a group come from
[`prk access explain`](#prk-access-explain), which reads both halves and names
what conferred each one.
:::

## `prk access explain`

What an identity can do, and what conferred it.

```bash
prk access explain bob@example.com
```

```
bob@example.com	user
groups	contractors, platform
billing:production	admin	via group `platform` on `billing:*`
     reader	a direct grant	on `billing:production`
  -> admin	group `platform`	on `billing:*`
```

Read it like this:

- The first column of an entry is the **scope**, spelled the way `--scope` takes
  one.
- Underneath are all the grants that reach that scope, including ones sitting
  higher up — "the `platform` group has admin on the project" _is_ the answer to
  why Bob has the environment.
- `->` marks the grant the server reported as **decisive**: the one that
  actually set the role, and therefore the one to remove.

So to take away Bob's admin on `billing:production`, remove him from the
`platform` group. Revoking the direct `reader` grant would change nothing.

A disabled identity reports `none` at every scope with nothing marked decisive,
and its sources still listed — the kill switch outranks every grant, and what
re-enabling would restore is the thing being decided.

Entries are narrowed to the scopes you administer. Sources inside a visible
entry are not, so a project admin can see that a role came from a global grant
on a group even though the global entry itself is invisible to them.

If there is nothing to report:

```
No role at any scope you administer -- no grant, no group grant, and not named in BOOTSTRAP_ADMINS.
```

## `prk access revoke`

```bash
prk access revoke deploy@example.com --scope api:production
```

```
Revoke `deploy@example.com` on `api:production`? [y/N]
```

```
Revoked `deploy@example.com` on `api:production`.
```

The scope defaults to `*:*`, so pass the one you mean. Revoking a grant that
does not exist tells you where to look instead:

```
error: `deploy@example.com` holds no direct grant on `api:production`. `prk access list` shows what they do hold directly -- but a role reaching this scope through a group is revoked by removing them from the group, which this command cannot do.
```

## `prk access disable`

The kill switch. Checked **before** grants are resolved, so it outranks every
grant at every scope — including roles held through a group, and including
`BOOTSTRAP_ADMINS`.

```bash
prk access disable bob@example.com
```

```
Disable `bob@example.com`? [y/N]
```

```
Disabled `bob@example.com`.
It now resolves to no role at any scope, whatever its grants say -- including BOOTSTRAP_ADMINS. Re-enable with `prk access enable bob@example.com`.
```

One write, rather than hunting for grant rows and risking a miss. This is the
command to reach for when a laptop is lost or a token leaks.

Everything the identity attempts afterwards gets the same `403` an ungranted
identity gets — but the audit row carries `disabled: true`, so an operator
reading the log can tell "re-enable them" from "grant them something". See
[Access control](/guides/access-control#a-kill-switch-refusal-is-distinguishable-in-the-log).

:::note[Disabling requires global admin]
An administrator of one project flipping this switch would be revoking access to
projects they have nothing to do with, so the operation is reserved for global
admins.
:::

## `prk access enable`

```bash
prk access enable bob@example.com
```

```
Enabled `bob@example.com`.
Its grants are in force again; `prk access explain bob@example.com` shows exactly what that restored.
```

Enabling asks for no confirmation — restoring access is the reversible half.
Check what you are about to restore first:

```bash
prk access explain bob@example.com
```

## `prk access rename`

Give an identity a display name. For service tokens this is not cosmetic: an
access list of `e367826f93b8d71185e03fe518aff3b4.access` rows is unreadable,
which is how a stale token survives three audits.

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access "staging deploy job"
```

```
Named `e367826f93b8d71185e03fe518aff3b4.access` `staging deploy job`.
```

Changing an existing name names both:

```
Renamed `e367826f93b8d71185e03fe518aff3b4.access` from `staging deploy` to `staging deploy job`.
```

Clear it with `--clear`, which reports the old label on the way out so you can
put it back:

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access --clear
```

```
Cleared the display name on `e367826f93b8d71185e03fe518aff3b4.access`; it was `staging deploy job`.
```

`--clear` is a separate flag rather than an empty `NAME`, so a shell variable
that unexpectedly expands to nothing cannot erase a label.

## `prk access token`

Cloudflare Access service tokens, created and managed by the server. The Worker
holds the Cloudflare API token and asks Cloudflare on your behalf; `prk` never
holds a Cloudflare credential.

:::note[Global admin, on a configured server]
Every `token` subcommand requires **global** admin. Project admins grant an
existing token within their project with [`prk access grant`](#prk-access-grant),
using its client id as the subject.

The server needs the `CF_API_TOKEN` secret and the `CF_ACCOUNT_ID` var; see
[Configuration](/reference/configuration#service-token-management). Against a
server without them, `prk` reads `/api/v1/capabilities` first and stops before
sending anything, saying what the server is missing (exit 8). A Worker from a
release without service-token management answers `404` there, and `prk` stops
with exit 5 and asks for a newer Worker. A caller who is not a global admin
stops with exit 4.
:::

A `<TOKEN>` is any of the three things that name a managed token:

```
e367826f93b8d71185e03fe518aff3b4.access   the client id
"staging deploy"                          the display name
0192f1c4-7a2e-7b3d-9c41-5e8f0a6d2b17      the token's id
```

### `prk access token create`

```bash
prk access token create "staging deploy" --role reader --scope api:production
```

The Worker asks Cloudflare for a new service token, then records its identity
and the grant in one transaction. The identity's subject is the client id and
its display name is `<NAME>`, so the token reads as `staging deploy` wherever
prick lists identities. Its first request is already authorized.

`prk` prints the client id and the client secret. **The secret is shown once**:
prick stores no copy of it and nothing derived from it. A lost secret is
replaced with [`rotate`](#prk-access-token-rotate).

| Flag                   | Values                                        | Default                       |
| ---------------------- | --------------------------------------------- | ----------------------------- |
| `--role <ROLE>`        | `reader`, `writer`, `admin`                   | No grant                      |
| `--scope <SCOPE>`      | `project:environment`, either half may be `*` | `*:*`, with `--role` only     |
| `--expires-in <DAYS>`  | A number of days, for the grant               | The grant never expires       |
| `--duration <HOURS>`   | Whole hours such as `8760h`, or `forever`     | `8760h`, one year             |
| `--secret-file <PATH>` | A file path, or `-` for stdout                | The secret goes to the screen |

`--duration` is the token's own lifetime in Cloudflare, at most `87600h`.
`--expires-in` is the lifetime of the grant in prick. They are independent: an
expired grant leaves a working token that holds nothing, and an expired token
cannot authenticate whatever it is granted.

`--scope` and `--expires-in` need `--role`. A `--role` with no `--scope` is a
global grant, the same default as `prk access grant`, so name the scope unless
global is what you mean. Without `--role`, the token is created holding no
grant, ready for `prk access grant`.

#### Sending the secret somewhere other than a terminal

`--secret-file <PATH>` writes the secret to an owner-only file and prints only
the client id. `--secret-file -` writes the secret alone to stdout, for a pipe:

```bash
prk access token create "staging deploy" --role reader --scope api:production --secret-file - | gh secret set PRK_ACCESS_CLIENT_SECRET
```

The client id goes to stderr, outside the pipe, so it can be stored as
`PRK_ACCESS_CLIENT_ID`. It is not secret. `--secret-file -` cannot be combined
with `--json`.

If recording the token fails after Cloudflare issued it, the Worker deletes the
Cloudflare token again before reporting the error, so nothing usable is left
behind. In Cloudflare the token is named `prick:<instance id>:<id>`; that name is
how a deployment recognises its own tokens in an account it shares with another.

### `prk access token list`

```bash
prk access token list
```

The tokens this server manages, each with its display name, client id, status
and Cloudflare's view of it: expiry, last use, and whether Cloudflare has
reported it leaked. `--all` includes revoked tokens.

A status of `missing` is a token prick still considers live that Cloudflare no
longer has, because someone deleted it in the dashboard.
[`reconcile`](#prk-access-token-reconcile) retires it. When Cloudflare cannot be
asked, the list still prints from prick's records, without Cloudflare's columns,
and reports no token as missing.

### `prk access token rotate`

```bash
prk access token rotate "staging deploy"
```

A new client secret for the same client id. The identity and every grant it
holds are unchanged, so the only thing to update is the secret the job reads.

By default the old secret stops working **immediately**, which is the right
answer to a leak, and the command asks for confirmation first; `--yes` answers
it. For a scheduled rotation, keep the old secret valid while the job moves
over:

```bash
prk access token rotate "staging deploy" --grace 24h --secret-file - | gh secret set PRK_ACCESS_CLIENT_SECRET
```

| Flag                   | Values                                         | Default                 |
| ---------------------- | ---------------------------------------------- | ----------------------- |
| `--grace <DURATION>`   | `30m`, `24h`, `7d` and so on, at most 30 days  | The old secret ends now |
| `--secret-file <PATH>` | A file path, or `-` for stdout, as on `create` | The screen              |
| `--yes`                |                                                | Ask                     |

The new secret is shown once, like the first.

### `prk access token refresh`

```bash
prk access token refresh "staging deploy"
```

Extends the token's expiry in Cloudflare by its duration. No new secret, and
nothing about the identity changes.

### `prk access token revoke`

```bash
prk access token revoke "staging deploy"
```

Asks for confirmation (`--yes` answers it), then disables the token's identity —
[the kill switch](#prk-access-disable), which outranks every grant — and marks
the record revoked, in one transaction. Then it deletes the token in Cloudflare.
Access is gone the moment the transaction commits.

The grants stay, as the record of what the token held;
[`prk access explain`](#prk-access-explain) still lists them. If the Cloudflare
delete fails, the command fails with `UPSTREAM_FAILED` while prick already
refuses the token, and [`reconcile --apply`](#prk-access-token-reconcile)
finishes the job.

A token that is the last usable global administrator, with `BOOTSTRAP_ADMINS`
empty, is refused with `LAST_ADMIN`.

### `prk access token adopt`

```bash
prk access token adopt e367826f93b8d71185e03fe518aff3b4.access --name "legacy deploy"
```

Brings a token made in the Cloudflare dashboard under this server's management,
so it can be rotated, refreshed and revoked here. Its identity is created if the
token has never authenticated, and reused, grants and all, if it has. `--name`
sets the display name. No secret is involved.

Adopting changes nothing in Cloudflare: the token keeps its name and any policy
that names it. Once adopted, though, the token's life is managed here, and
**revoking it deletes it in Cloudflare** — which also ends its access to every
other Access application that admits it. `revoke` warns before doing that to an
adopted token. Adopting a token already managed here is a `CONFLICT`.

### `prk access token reconcile`

```bash
prk access token reconcile
```

Compares this server's records with Cloudflare's, and reports what disagrees:

| Kind                | Means                                                              | With `--apply`                    |
| ------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `orphan`            | A `prick:<this instance>:` token in Cloudflare with no record here | Deleted from Cloudflare           |
| `missing`           | A live record whose token was deleted in the dashboard             | Retired: the identity is disabled |
| `revoke_incomplete` | A revoked record whose token still exists in Cloudflare            | Deleted from Cloudflare           |
| `foreign`           | A token named for another prick deployment sharing the account     | Never touched                     |

Without `--apply` nothing changes. `--apply` repairs each entry, with its own
audit row, after asking for confirmation; `--yes` answers it. Tokens whose
Cloudflare name does not start with `prick:` were made by hand and are not
considered; adopt one to bring it in.

Reconcile is safe to run while tokens are being created or revoked:

- An entry less than five minutes old is reported as **skipped**, with the
  reason, and never repaired. A create or revoke may still be in flight, and
  judging it would delete a token another request is recording.
- `--apply` re-checks each entry immediately before repairing it, and skips any
  that has stopped being eligible since the listing — a row that committed, a
  token Cloudflare now answers for, a revoke that landed — saying so.
- `--apply` refuses, changing nothing, when more than ten live tokens read as
  `missing`, or when two or more do and that is every live token. That pattern
  is far more often `CF_ACCOUNT_ID` naming the wrong account than tokens
  deleted in the dashboard. The answer is a `CONFLICT` naming the account id;
  retire tokens that really are gone one at a time with `revoke`.

## Groups

Groups are part of the model and are managed through the web UI or the API.
`prk access explain` reads roles held through a group, so the CLI tells you when
a group is what confers a role.

## Common errors

| Error                 | Exit | What happened                                                                                                                                                                                                                                       |
| --------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORBIDDEN`           | 4    | You are not an admin at the scope you are trying to change                                                                                                                                                                                          |
| `NOT_FOUND`           | 5    | No such identity, grant, project or environment — or not visible to you                                                                                                                                                                             |
| `CONFLICT`            | 6    | A grant already exists at that scope, a token is already adopted, or revoking it would remove the last global admin (`LAST_ADMIN`)                                                                                                                  |
| `SERVICE_UNAVAILABLE` | 8    | `prk access token` on a server without `CF_API_TOKEN` and `CF_ACCOUNT_ID`, or whose token Cloudflare refuses: the server code is [`SERVICE_TOKENS_UNCONFIGURED`](/reference/cli/errors#service_unavailable-with-service_tokens_unconfigured-exit-8) |
| `SERVER_ERROR`        | 8    | The Cloudflare API failed while the server managed a token: the server code is [`UPSTREAM_FAILED`](/reference/cli/errors#server_error-with-upstream_failed-exit-8)                                                                                  |

A malformed scope fails locally, before any request:

```bash
prk access grant alice@example.com --role admin --scope "API:production"
```

```
error: `API` is not a usable project name: it must be lowercase letters, digits and single hyphens, at most 64 characters. Did you mean `api`?
```

## Next steps

- [Access control](/guides/access-control) — the model behind these commands, and how the first admin exists.
- [Give CI read-only access to one environment](/examples/ci-read-only)
- [`prk whoami`](/reference/cli/sign-in#prk-whoami) — the subject to grant.
