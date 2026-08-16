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
```

A `<SUBJECT>` is an email address for a person, or a service token's
`common_name` for a machine:

```
you@example.com
e367826f93b8d71185e03fe518aff3b4.access
```

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

The scope string is split on the **first** colon only, so an environment
component may itself contain colons.

## `prk access grant`

```bash
prk access grant deploy@example.com --role reader --scope api:production
```

```
Granted reader to `deploy@example.com` on `api:production`.
```

| Flag                  | Values                      | Default       |
| --------------------- | --------------------------- | ------------- |
| `--role <ROLE>`       | `reader`, `writer`, `admin` | Required      |
| `--scope <SCOPE>`     | `project:environment`, `*`  | `*:*`         |
| `--expires-in <DAYS>` | A number of days            | Never expires |

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

## Groups

Groups are part of the model and are managed through the web UI or the API.
`prk access explain` reads roles held through a group, so the CLI tells you when
a group is what confers a role.

## Common errors

| Error       | Exit | What happened                                                           |
| ----------- | ---- | ----------------------------------------------------------------------- |
| `FORBIDDEN` | 4    | You are not an admin at the scope you are trying to change              |
| `NOT_FOUND` | 5    | No such identity, grant, project or environment — or not visible to you |
| `CONFLICT`  | 6    | A grant already exists at that scope                                    |

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
