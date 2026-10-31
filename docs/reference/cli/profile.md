---
title: prk profile
description: Save several prick servers under local names, choose between them, and pin a repository to the deployment it belongs to.
sidebar:
  order: 2.5
---

A **profile** is a local name for one prick server, plus the session signed in
to it. `prk login` creates one the first time you sign in, so a machine that
talks to one server needs nothing on this page. `prk profile` is for the
machine that talks to several.

```
prk profile list
prk profile show [NAME]
prk profile add <NAME> <URL> [--default] [--reuse-name]
prk profile use <NAME>
prk profile rename <OLD> <NEW>
prk profile forget <NAME>
prk profile set <NAME> [--default-project <SLUG>] [--default-env <SLUG>] [--service-token-client-id <ID>]
prk profile remove <NAME> [--no-revoke]
prk profile pin [--local]
```

## Names, servers and instances

A profile has three identifying parts, and only one of them identifies the
server:

| Part     | Example                            | What it is                                                         |
| -------- | ---------------------------------- | ------------------------------------------------------------------ |
| Name     | `acme`                             | A label on this machine. You choose it and can rename it any time  |
| Server   | `https://prick.acme.example`       | The URL it signs in to. A profile's server is fixed for its life   |
| Instance | `3f9c01ab3f9c01ab3f9c01ab3f9c01ab` | The id the deployment reports about itself. Permanent per database |

A profile name is the slug grammar: lowercase letters, digits and single
hyphens, at most 64 characters. It never becomes a path and never leaves this
machine, so `prod` on your laptop and `prod` on a colleague's can be two
different deployments.

The **instance id** is what tells deployments apart. Two deployments of prick
can share an Access organisation and every project, environment and key name,
and nothing in a request distinguishes them. The first time a profile talks to
its server — at `prk login`, or the first command afterwards — it records the
instance id the server reports. This is **pinning**. From then on, a server
at that URL reporting any other instance, or none, is refused with
[`INSTANCE_MISMATCH` or `INSTANCE_UNVERIFIED`](/reference/cli/errors#profile-and-server-selection)
(exit 3) before any command sends a request of its own. A profile that has
not been pinned yet shows `instance unverified`.

A profile also pins the Cloudflare Access issuer it first signed in through.
A later sign-in through a different issuer is refused and nothing is saved.

Every display of a profile shows the host and the instance next to the name,
because those are the same on every machine.

## Which profile a command uses

First match wins. Each tier is described in full under
[Configuration](/reference/configuration#which-server-a-command-talks-to).

| Tier        | Profile form                            | URL form        |
| ----------- | --------------------------------------- | --------------- |
| Flag        | `--profile NAME`                        | `--api-url URL` |
| Environment | `PRK_PROFILE`                           | `PRK_API_URL`   |
| Project     | `.prick.local.toml`, then `.prick.toml` |                 |
| Default     | the default profile (`prk profile use`) |                 |

`--profile` and `--api-url` together are refused, and so are `PRK_PROFILE` and
`PRK_API_URL` together. A name that does not exist is refused; it never falls
through to the next tier.

Two rules apply on top of the table once two or more profiles exist:

- A command that **changes data** needs its server named by a flag, an
  environment variable or this checkout's `.prick.local.toml`. The default
  profile, or a committed `.prick.toml`, alone is refused with
  `PROFILE_REQUIRED`. Reads, including `prk run` and
  `prk secrets download`, use the default.
- A **service token** from `PRK_ACCESS_CLIENT_*` or `CF_ACCESS_CLIENT_*` pairs
  only with a server chosen by `--profile`, `--api-url`, `PRK_PROFILE` or
  `PRK_API_URL`. Paired with a project file or the default, it is refused
  with `SERVICE_TOKEN_REFUSED`.

## `prk profile list`

Every profile, with its server, instance and sign-in state. `*` marks the
default.

```bash
prk profile list
```

```
* acme    prick.acme.example    instance 3f9c01ab    signed in
  globex  prick.globex.example  instance unverified  signed out
```

The state is `signed in`, `signed out`, or `credential unreadable` when the
profile's credential file exists and cannot be read. With no profiles:

```
No profiles. Run `prk login <URL>` to create one.
```

Under `--json`, an array with one object per profile:

```bash
prk profile list --json
```

```json
[
  {
    "name": "acme",
    "default": true,
    "api_url": "https://prick.acme.example",
    "server": "prick.acme.example",
    "instance": "3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
    "issuer": "https://acme.cloudflareaccess.com",
    "signed_in": true,
    "expires_at": 1793450400,
    "credential_unreadable": false,
    "project": "api",
    "env": "production",
    "service_token_client_id": null
  }
]
```

| Field                     | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `name`                    | The profile's name                                               |
| `default`                 | Whether it is the default profile                                |
| `api_url`                 | Its server's base URL                                            |
| `server`                  | The host part of `api_url`                                       |
| `instance`                | The pinned instance id, or `null` while unverified               |
| `issuer`                  | The pinned Access issuer, or `null` before the first sign-in     |
| `signed_in`               | Whether a session for this server is stored                      |
| `expires_at`              | When the stored access token expires, in Unix seconds, or `null` |
| `credential_unreadable`   | `true` when the credential file exists and cannot be read        |
| `project`, `env`          | The profile's default project and environment, or `null`         |
| `service_token_client_id` | The only service-token client id it accepts, or `null`           |

No field ever carries a token.

## `prk profile show`

```
prk profile show [NAME]
```

One profile. Without a name, the profile **this command line and this
directory** select, and what selected it — the question to ask when a command
reached a server you did not expect.

```bash
prk profile show
```

```
acme (selected from the default profile)
  server:   https://prick.acme.example
  instance: 3f9c01ab3f9c01ab3f9c01ab3f9c01ab
  access:   https://acme.cloudflareaccess.com
  session:  signed in
  project:  api
  default:  yes
```

The source reads `from the command line`, `from the environment`,
`from the default profile`, or the path of the project file that chose it.
Lines for an unset issuer, project, environment or service token are left
out.

Under `--json` the object has the fields of [`list`](#prk-profile-list), and,
when no name was given, `source`: one of `flag`, `environment`, `local_file`,
`project_file` or `default`.

```bash
prk --profile globex profile show --json
```

```json
{ "name": "globex", "source": "flag", "…": "…" }
```

When the selection is a URL that no profile is for, there is no profile to
show, and the answer says so:

```json
{ "api_url": "https://prick.example.com", "profile": null, "source": "flag" }
```

## `prk profile add`

```
prk profile add <NAME> <URL> [--default] [--reuse-name]
```

Save a server as a profile without signing in. No request is made; the
profile is pinned the first time it is used.

| Argument | Meaning                                                     |
| -------- | ----------------------------------------------------------- |
| `<NAME>` | Lowercase letters, digits and single hyphens                |
| `<URL>`  | The server's base URL: `https://`, or `http://` to loopback |

| Flag           | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `--default`    | Make it the default profile                                             |
| `--reuse-name` | Accept a name a renamed profile left behind, for a different deployment |

```bash
prk profile add globex https://prick.globex.example
```

```
Added profile globex for prick.globex.example. Run `prk login --profile globex` to sign in.
```

A profile added when there is no default becomes the default, so the first
profile on a machine always is. `--json` prints
`{"name": …, "api_url": …, "default": …}`.

The URL is normalised (trailing slashes removed, scheme and host lowercased,
`:443` or `:80` dropped) and refused with `INVALID_URL` when it is not
`https://`, unless it is `http://` to `localhost`, an IPv4 address in
`127.0.0.0/8` or `[::1]`. Addresses are parsed, so `127.evil.example.com` is a
remote name. A URL carrying
`user@` is refused too. Every request carries a credential, so a plaintext
URL to a remote host is never accepted.

## `prk profile use`

```
prk profile use <NAME>
```

Make a profile the default.

```bash
prk profile use acme
```

```
Default profile is now acme.
```

The default answers reads when nothing else selects a server. With two or
more profiles, a write still has to name its server: the default is whatever
was chosen last, possibly for other work.

## `prk profile rename`

```
prk profile rename <OLD> <NEW>
```

Rename a profile. Only the name changes: the credential file, the session,
the instance pin and the issuer pin stay as they are, and if it was the
default, the default follows.

```bash
prk profile rename prod acme
```

```
Renamed prod to acme. `--profile prod` now fails with a pointer here.
```

The old name is kept as a **tombstone** in `config.toml`, so anything still
using it fails loudly rather than reaching whatever later takes the name:

```bash
prk --profile prod whoami
```

```
error: profile `prod` was renamed to `acme`
  help: Use the new name. A script can pin its deployment with --expect-instance.
```

The rules for tombstoned names:

- A tombstoned name cannot be given to a new profile, by `prk profile add` or
  by `prk login --profile`, unless `prk profile add` gets `--reuse-name`. A
  script written when `prod` meant one deployment must not start writing to
  another one.
- Renaming a profile back onto a name it had before is always allowed: the
  tombstone points at that very profile.
- A chain of renames points every old name at the current one: after
  `prod → acme → acme-eu`, both `prod` and `acme` name `acme-eu`.
- A name that `prk login` picks for you skips tombstoned names.

`--json` prints `{"from": …, "to": …, "instance": …}`.

## `prk profile forget`

```
prk profile forget <NAME>
```

Drop a tombstone, so the name is free for anything.

```bash
prk profile forget prod
```

```
`prod` is free to use.
```

A name that is not a tombstone is refused with `PROFILE_EDIT_REFUSED`.
`--json` prints `{"forgotten": …}`.

## `prk profile set`

```
prk profile set <NAME> [--default-project <SLUG>] [--default-env <SLUG>] [--service-token-client-id <ID>]
```

Change a profile's defaults, and the service token it expects. An empty
string clears a value; a flag you leave out leaves its value as it is.

| Flag                        | Meaning                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `--default-project`         | The project used when nothing more specific names one            |
| `--default-env`             | The environment used when nothing more specific names one        |
| `--service-token-client-id` | Refuse any service token from the environment but this client id |

```bash
prk profile set acme --default-project api --default-env production
```

```
Updated profile acme.
```

The profile's project and environment come last in their precedence: `-P` and
`-E`, `PRK_PROJECT` and `PRK_ENV`, and both project files win over them.

With `--service-token-client-id` set, a service token whose client id is
anything else is refused with `SERVICE_TOKEN_REFUSED` before it is sent:

```bash
prk profile set acme --service-token-client-id e367826f93b8d71185e03fe518aff3b4.access
```

```bash
prk profile set acme --default-env ""
```

`--json` prints `{"name", "project", "env", "service_token_client_id"}`
after the change.

## `prk profile remove`

```
prk profile remove <NAME> [--no-revoke]
```

Also `prk profile rm`. Sign out of a profile and delete it: the session is
revoked at the authorization server, its credential file is deleted, and the
profile leaves `config.toml`.

| Flag          | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `--no-revoke` | Discard the session without telling the server |

It asks first. `--yes` answers; under `--no-input` without `--yes` it refuses
and removes nothing:

```bash
prk profile rm globex --yes
```

```
Removed profile globex (prick.globex.example).
```

Removing the default profile leaves **no default**. Choosing another would
decide which deployment an unqualified command reaches, so that is yours to
do with `prk profile use`. Tombstones that pointed at the removed profile go
with it, so an old name no longer answers "renamed to" a profile that is gone.
A failed revocation is a warning, and the local
credential goes either way — the same rule as
[`prk logout`](/reference/cli/sign-in#the-local-credential-goes-either-way).
`--json` prints `{"removed": …, "server": …}`.

This is also how to accept a replaced deployment. A profile pinned to an
instance refuses a server that reports another one, so after a deliberate
rebuild with a fresh database, remove the profile and sign in again:

```bash
prk profile remove acme
prk login https://prick.acme.example --profile acme
```

## `prk profile pin`

```
prk profile pin [--local]
```

Record the selected server's instance in this project's `.prick.toml`, so the
repository selects that deployment on every machine and refuses every other.

```bash
prk profile pin --profile acme
```

```
Pinned instance 3f9c01ab (prick.acme.example) in /home/you/src/api/.prick.toml.
```

It signs in to the selected server the way any command does, reads the
instance it reports, and adds an `[[allow]]` entry for it. The file is the
`.prick.toml` found by searching up from the current directory, or a new one
in the current directory. The file is rewritten, so comments in it are not
kept. When the file then lists more than one deployment, its `profile` key is
removed, because a file that allows several deployments cannot also choose
one.

| Flag      | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| `--local` | Write the choice to `.prick.local.toml` beside `.prick.toml` |

`--local` sets `instance` in `.prick.local.toml`, for one checkout of a
repository that allows several deployments. The instance must already be in
`.prick.toml`'s allow list; run `prk profile pin` without `--local` first. It
warns when git does not ignore `.prick.local.toml`, because every command
refuses that file until it is ignored.

A server that reports no instance id has nothing to pin, and the command
fails. `--json` prints `{"instance": …, "server": …, "file": …}`.

The file formats are described under
[Configuration](/reference/configuration#pricktoml).

## Errors

| Code                   | Exit | When                                                                                                        |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `PROFILE_UNKNOWN`      | 2    | The name selects no profile, or is not a valid name                                                         |
| `PROFILE_RENAMED`      | 2    | The name is a tombstone; the message names the current one                                                  |
| `PROFILE_AMBIGUOUS`    | 2    | A URL or an instance matches several profiles                                                               |
| `PROFILE_EDIT_REFUSED` | 2    | `add`, `use`, `rename`, `forget`, `set` or `remove` was refused: name taken, tombstoned, unknown or invalid |
| `INVALID_URL`          | 2    | `add` got a URL that is not https, or carries `user@`                                                       |
| `PROFILE_STORE_FAILED` | 1    | `config.toml` could not be read, parsed, validated or written                                               |
| `ERROR`                | 1    | `remove` was not confirmed, `set` got a value that is not a slug, or `pin` had nothing to pin               |

Every code, with its fix, is in
[Exit codes and errors](/reference/cli/errors#profile-and-server-selection).

## Next steps

- [Working with several servers](/guides/multiple-servers/) — the guide to everything on this page.
- [Work with two organisations](/examples/work-with-two-organisations/) — a complete walkthrough.
- [Configuration](/reference/configuration#which-server-a-command-talks-to) — the precedence table and the file formats.
