---
title: Multiple servers
description: Sign in to several prick deployments from one machine, control which one each command reaches, and make a write to the wrong organisation a refusal instead of a success.
sidebar:
  order: 1.5
---

One machine can talk to any number of prick deployments: your own, a client's,
a staging copy. Each one is a **profile**, a local name bound to one server URL
and the session signed in to it. A machine that only ever talks to one server
has one profile, created by its first `prk login`, and nothing on this page
changes how it works.

This page is the end-to-end guide. Every flag and subcommand is in
[`prk profile`](/reference/cli/profile/), the file formats and environment
variables are in [Configuration](/reference/configuration/), and every error
code is in [Exit codes and errors](/reference/cli/errors/).

## Why this needs care

A credential for one deployment reaching another is the obvious failure, and
it is the easy one to prevent. The likely failure is quieter: **your own valid
credential, writing a value into the wrong deployment.** Project, environment
and key names collide across organisations, so `api:production` exists in
both, and a write to the wrong one returns `200`. Two deployments of the same
application can even sit behind the same Cloudflare Access organisation, with
you as an administrator of both, and then nothing in a request tells them
apart.

The only thing that can tell two deployments apart is the deployment itself.
Every prick server has an **instance id**: 32 random hex digits, generated once
and stored in its database. A profile records it the first time it talks to its
server, and every check on this page is built on that record.

## Add a second server

Sign in to it:

```bash
prk login https://prick.globex.example
```

```
Signing in to https://prick.globex.example as profile `prick-globex-example`
Signed in to https://prick.globex.example (profile prick-globex-example)
```

Signing in to a URL no profile is for creates a profile. The first profile on a
machine is called `default`; later ones are named after the host, with `-2`,
`-3` appended if that name is taken. Name it yourself with `--profile`:

```bash
prk login --profile globex https://prick.globex.example
```

Or save it first and sign in later. `prk profile add` makes no request:

```bash
prk profile add globex https://prick.globex.example
```

```
Added profile globex for prick.globex.example. Run `prk login --profile globex` to sign in.
```

```bash
prk login --profile globex
```

See what you have:

```bash
prk profile list
```

```
* acme    prick.acme.example    instance 3f9c01ab  signed in
  globex  prick.globex.example  instance a71e09d4  signed in
```

`*` marks the default profile. The host and the first eight digits of the
instance id are shown beside every name, because the name is a label on this
machine and the other two are the same everywhere.

Change the default with `prk profile use globex`. A profile can also carry a
default project and environment, used when neither a flag nor `PRK_PROJECT` /
`PRK_ENV` names one:

```bash
prk profile set globex --default-project api --default-env production
```

## How a command picks its server

First match wins:

| Tier        | Profile form                            | URL form        |
| ----------- | --------------------------------------- | --------------- |
| Flag        | `--profile NAME`                        | `--api-url URL` |
| Environment | `PRK_PROFILE`                           | `PRK_API_URL`   |
| Project     | `.prick.local.toml`, then `.prick.toml` | —               |
| Default     | `default_profile` in `config.toml`      | —               |

- **Both forms at one tier are refused.** `--profile` with `--api-url`, or
  `PRK_PROFILE` with `PRK_API_URL`, is a `SELECTION_CONFLICT`: guessing which
  one you meant is how a command reaches the wrong server.
- **A higher tier wins outright.** `--profile` beats `PRK_API_URL`.
- **An empty value counts as unset**, so `PRK_PROFILE=` neutralises an
  inherited variable.
- **A name that does not exist is refused**, and never falls through to the
  next tier. A renamed name fails with a message naming its successor.
- **A URL** selects the one profile for that URL, and that profile's session
  and pins apply. With no profile for it, only a service token can
  authenticate — the shape CI uses. With two profiles for one URL, name one
  with `--profile`.

`prk profile show` with no name tells you which profile this directory and
command line select, and why:

```bash
prk profile show
```

```
acme (selected from the default profile)
  server:   https://prick.acme.example
  instance: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
  access:   https://northwind.cloudflareaccess.com
  session:  signed in
  default:  yes
```

`prk -v` prints the same on any command:
`talking to prick.acme.example (from the default profile, instance 3f9c01ab)`.

### A write names its server

With two or more profiles, a command that changes data must have its server
chosen by a flag, an environment variable or this checkout's
`.prick.local.toml`. The default alone is refused, and so is a committed
`.prick.toml` alone: it arrives with `git clone`, so it is the repository
author's choice, not yours. It still selects the server for reads and supplies
the project and environment.

```bash
prk secrets set STRIPE_SECRET_KEY -P api -E production
```

```
error: this command changes data, and 2 profiles are configured; name the server with --profile, PRK_PROFILE or .prick.local.toml (`acme`, chosen by the default profile, is not used for writes)
  help: `prk profile list` shows the profiles; `prk profile pin --local` records this checkout's choice in .prick.local.toml.
```

The default is whatever was chosen last, possibly days ago for other work, and
a write is where that mistake costs something. Reads keep using it. This is a
refusal rather than a y/N prompt, so it behaves the same under `--no-input`
and cannot be answered from muscle memory. With one profile there is nothing to
confuse it with, and writes behave as they always do.

The writes are `secrets set`, `rm`, `upload` and `rollback`;
`projects create`, `rename` and `rm`; `env create` and `rm`;
`access grant`, `revoke`, `disable`, `enable` and `rename`; and
`keyring rekey`. `prk run` and `secrets list`, `get`, `download` and
`history` are reads.

### The destination line

Every write names where it is going, on stderr, before anything is sent:

```
writing to prick.globex.example (profile globex, instance a71e09d4)
```

`-q` and `--json` suppress it. Under `--json` the write's result document
carries the same three facts instead, so stderr stays empty:

```json
{
  "key": "STRIPE_SECRET_KEY",
  "rev": 12,
  "created": false,
  "destination": {
    "server": "prick.globex.example",
    "profile": "globex",
    "instance": "a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2"
  }
}
```

One invocation talks to one server. Moving values between deployments takes
two commands, and each one passes every check on this page by itself.

## The instance pin

A profile **pins** the instance id its server reports the first time it talks
to it: at `prk login`, or on the first command after `prk profile add`. The
first time, `prk` says so:

```
pinned globex to instance a71e09d4
```

From then on, before a command sends a request of its own, `prk` asks the
server who it is (`GET /api/v1/whoami`, which carries no secret) and compares
the answer with the pin. A different instance, or none, is refused with exit 3:

```
error: prick.acme.example is a different deployment than profile `acme` is pinned to (expected instance 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d, it reports 77d0c41e9a8b4f2c8e1d6b3a5f7c9e0d); nothing beyond the identity check was sent
  help: If this server was replaced on purpose, remove and re-add the profile: `prk profile remove <NAME>`, then `prk login <URL>`.
```

This holds even when the URL and the Access organisation match, which is the
point: it catches a hostname repointed at another deployment, a deployment
rebuilt on a fresh database, and a profile copied from another machine.

**A mismatch means the server at that URL is not the database you pinned.**
Restoring a D1 backup taken after the instance row existed keeps the instance
id, so such a restore is not a mismatch; a fresh database behind the old
hostname is, and so is a backup from before the row existed. A copy loaded
from another deployment's export shares that deployment's id until it is given
its own. See
[Backup and recovery](/guides/backup-and-recovery). If the replacement was
intended, remove the profile and sign in again, which pins the new instance:

```bash
prk profile remove acme
```

```bash
prk login --profile acme https://prick.acme.example
```

A profile also pins the Access issuer (`https://<team>.cloudflareaccess.com`)
it first signed in through. A later `prk login` through a different issuer is
refused, the fresh token is revoked, and nothing is saved.

A server that reports no instance id leaves its profile unpinned. `prk login`
warns about it, `prk profile list` shows `instance unverified`, and the first
instance the server does report is pinned. A pinned instance never changes.

## Project files

A repository can declare which deployments it belongs to, in a committed
`.prick.toml`:

```toml title=".prick.toml"
project = "api"
env = "staging"

[[allow]]
instance = "3f9c01ab52e84d7a9b0c6e1f2a3b4c5d"
```

`prk` looks for it from the working directory upwards, and stops at the first
directory containing `.git` or at your home directory, so a stray file in a
parent directory cannot steer every repository beneath it.

You do not type the instance id. Select the right profile and let `prk` write
it:

```bash
prk profile pin --profile acme
```

```
Pinned instance 3f9c01ab (prick.acme.example) in /home/you/src/api/.prick.toml.
```

`prk profile pin` adds an `[[allow]]` entry for the selected server's
instance, creating the file if there is none. It rewrites the file, so
comments in it are not kept.

### It allows; it never points

A `.prick.toml` arrives with `git clone`, so it is input from whoever wrote the
repository. It can only **narrow** what your machine does:

- It **selects by instance**, among the profiles you already have. With one
  `[[allow]]`, the profile used is the one pinned to that instance, whatever
  you named it. A profile name is a local label, so a file that named one
  would mean a different server on a colleague's machine.
- **Whatever selected the server**, a flag included, the server's instance must
  be on the allow list, or the command is refused with `INSTANCE_NOT_ALLOWED`
  before anything is sent.
- It **never names a URL or a credential**. `url`, `api_url` and every other
  unrecognised key are refused, so a cloned repository cannot aim a command, or
  a service token in your environment, at a server you did not register.

| Key         | Meaning                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `[[allow]]` | A deployment this code may talk to. At least one. `instance` is required; `issuer` additionally pins Access      |
| `project`   | The project used when neither `-P` nor `PRK_PROJECT` names one                                                   |
| `env`       | The environment used when neither `-E` nor `PRK_ENV` names one                                                   |
| `profile`   | A tie-breaker when two of your profiles are pinned to the one allowed instance. Refused with several `[[allow]]` |

When no profile is pinned to the allowed instance yet, selection falls through
to the default, which is still held to the allow list once the server reports
its instance. A write with two or more profiles is refused in that case, since
only the default chose the server.

A server that reports no instance id cannot satisfy a project file:
`INSTANCE_UNVERIFIED`.

### `.prick.local.toml`

Beside `.prick.toml`, a git-ignored `.prick.local.toml` holds one checkout's own
choice:

```toml title=".prick.local.toml"
instance = "a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2"
```

It also accepts `profile`, `project` and `env`, and its `project` and `env`
override the committed file's. Its `instance` must be on the committed file's
allow list. `prk profile pin --local` writes it.

`prk` refuses a `.prick.local.toml` that git does not ignore, because
committed, it would make the choice for everyone who clones the repository,
which is the decision the shared file is not allowed to make. Add it to
`.gitignore`:

```bash
echo .prick.local.toml >> .gitignore
```

Project and environment defaults come from, highest first: `-P` / `-E` and
`PRK_PROJECT` / `PRK_ENV`, then `.prick.local.toml`, then `.prick.toml`, then
the profile's own `--default-project` / `--default-env`.

## One repository, several organisations

An agency or platform team often runs the same application for several
clients, from one repository. List every deployment it may talk to:

```toml title=".prick.toml"
project = "storefront"

[[allow]]
instance = "3f9c01ab52e84d7a9b0c6e1f2a3b4c5d"

[[allow]]
instance = "a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2"
```

With more than one `[[allow]]`, the committed file **cannot choose**, and a
`profile` key in it is refused. The choice comes from `--profile`,
`PRK_PROFILE`, or a checkout's `.prick.local.toml`, and whichever makes it, the
server must be one of the listed deployments. Run `prk profile pin` once per
deployment to build the list.

A checkout that works for one client keeps a `.prick.local.toml` naming that
client's instance. A checkout that works for both names the profile on each
command. [Work with two organisations](/examples/work-with-two-organisations)
walks through it.

## Two deployments behind one Access organisation

The hardest case is two deployments that differ in nothing a request can see:
the same Access organisation, so the issuer pin is identical; the same
administrator, so `prk whoami` reads the same; the same project, environment
and key names. The instance id is then the only difference, and it is enough:

- each profile is pinned to its own instance, so pointing a profile at the
  other deployment is `INSTANCE_MISMATCH`;
- the project file's allow list holds instance ids, so a repository for one
  client refuses the other's deployment;
- `--expect-instance` pins a script to exactly one of them.

For service tokens, use one per deployment and pin it on the profile: see
[below](#service-tokens-with-several-profiles).

## Rename a profile

```bash
prk profile rename acme acme-prod
```

```
Renamed acme to acme-prod. `--profile acme` now fails with a pointer here.
```

Only the name changes. The session stays signed in, the pins stay, and the
default follows. The old name becomes a **tombstone**:

```bash
prk --profile acme secrets list -P api -E production
```

```
error: profile `acme` was renamed to `acme-prod`
  help: Use the new name. A script can pin its deployment with --expect-instance.
```

A tombstone never falls through to another server. It also keeps the old name
from being reused for a different deployment, since a script written for
`acme` would then reach the wrong one:

```bash
prk profile add acme https://prick.other.example
```

```
error: `acme` was the name of a profile for another deployment (renamed to `acme-prod`); reusing it could send a script written for that deployment to this one
```

A pinned profile can take back a name it left behind. To free a name for
anything else, either forget the tombstone or pass `--reuse-name`:

```bash
prk profile forget acme
```

```bash
prk profile add acme https://prick.other.example --reuse-name
```

After a chain of renames, every old name points at the current one.

## Pin a script with `--expect-instance`

A profile name is a label someone can rename, and a default is whatever was
chosen last. A script that must reach one deployment names its instance:

```bash
prk secrets download --expect-instance 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d --profile acme --format env --output .env -P api -E production
```

Or once, for the whole script:

```bash
export PRK_EXPECT_INSTANCE=3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
```

The command reaches the deployment it names or nothing. Renaming the profile,
changing the default, or reusing the name for another server cannot redirect
it:

```
error: prick.globex.example reports instance a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2, not the expected 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d; nothing beyond the identity check was sent
```

The value must be the full 32 lowercase hex digits; anything else is
`INVALID_INSTANCE`. `prk whoami` prints a server's full instance id. In GitHub
Actions, `PRK_EXPECT_INSTANCE` passes through to the action; see
[GitHub Actions](/guides/using-secrets/github-actions).

## Service tokens with several profiles

A service token in the environment (`PRK_ACCESS_CLIENT_*` or
`CF_ACCESS_CLIENT_*`) pairs with a server chosen by the same kind of deliberate
act: with two or more profiles, it is used only when the server came from
`--profile`, `--api-url`, `PRK_PROFILE` or `PRK_API_URL`. A project file or the
default alone is refused with `SERVICE_TOKEN_REFUSED`, because a token in the
environment and a server chosen by a file are two decisions nobody made
together. With one profile, or none, a service token works exactly as
[Authentication](/guides/authentication#authenticate-a-machine) describes.

Record which token a profile expects, and any other is refused before it is
sent:

```bash
prk profile set acme --service-token-client-id e367826f93b8d71185e03fe518aff3b4.access
```

```
error: profile `acme` expects service token e367826f93b8d71185e03fe518aff3b4.access, but 9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e.access is configured
```

**Use one service token per deployment, and pin it on that deployment's
profile** as above. On the Cloudflare side, two setups keep the deployments
apart:

- **One Service Auth policy that admits any Access service token.** prick's
  grants separate the deployments: each deployment keeps its own grant table, a
  token holds grants only on the deployment that granted it, and any other
  deployment answers it with `404`.
- **Each token with an Access policy scoped to it.** The edge separates the
  deployments: a token reaches only the application whose policy names it.

Either way, `prk` checks which client id it sends, and the pin refuses any
other one before the request leaves the machine.

## Updating from a single-server install

There is nothing to do. An install with a `credentials.json` and no
`config.toml` is read as one profile, `default`, for the server that session
was signed in to. Every command behaves as it did, and a read writes nothing.

`config.toml` is written the first time there is something new to record:
`prk profile add`, a sign-in to a second server, a rename, or the first
instance id your server reports. That first pin is one write, and
`credentials.json` stays where it is.

An older and a newer `prk` can share a machine. Both use `credentials.json`
for the `default` profile, and the older one ignores `config.toml` and
`credentials/`. If the older one signs in to a different server, it overwrites
`credentials.json` with that server's session. The newer one never sends that
session anywhere but the server it records: it hands `credentials.json` to the
profile for that URL, or a new one, and moves `default` to a fresh, empty
credential file, signed out, saying so and naming
`prk login --profile default`. No session file is moved or deleted, so the
older one keeps its sign-in. A profile that has a session of its own is never
touched.

## Troubleshooting

Every refusal below happens before the command sends a request of its own, and
most before any request at all. The `--json` code is in the heading.

### `NO_SERVER` (exit 1)

Nothing selects a server: no flag, no variable, no project file, no default.
Run `prk login <URL>` once, or pass `--profile` / `--api-url`. With profiles
but no default, `prk profile use <NAME>` sets one; removing the default profile
leaves none.

### `SELECTION_CONFLICT` (exit 2)

`--profile` and `--api-url`, or `PRK_PROFILE` and `PRK_API_URL`, are both set.
Use one. An inherited variable can be cleared with `PRK_API_URL=`.

### `PROFILE_UNKNOWN` (exit 2)

No profile has that name. The message lists the ones that exist.

### `PROFILE_RENAMED` (exit 2)

The name was renamed; the message names the new one. Update the script, and
consider pinning it with `--expect-instance` so the next rename cannot break
it.

### `PROFILE_AMBIGUOUS` (exit 2)

Three causes, each named in the message:

- two profiles are for the URL you gave — pick one with `--profile`;
- two profiles are pinned to the instance the project file selects — two
  identities on one deployment. Pass `--profile`, or add `profile = "..."` as
  a tie-breaker in `.prick.toml` (one `[[allow]]`) or `.prick.local.toml`;
- `.prick.local.toml` names an instance no profile is pinned to — sign in to
  that deployment first.

### `PROFILE_REQUIRED` (exit 2)

A write, two or more profiles, and only the default or a committed
`.prick.toml` chose the server. Pass `--profile`, set `PRK_PROFILE`, or record
this checkout's choice with `prk profile pin --local`.

### `SERVICE_TOKEN_REFUSED` (exit 2)

Either a service token is configured and, with two or more profiles, the server
was chosen by a project file or the default — choose it with `--profile`,
`--api-url`, `PRK_PROFILE` or `PRK_API_URL` — or the profile records a
`service_token_client_id` and a different token is configured. Nothing was sent
in either case.

### `INSTANCE_MISMATCH` (exit 3)

The server reports a different instance than the profile is pinned to, or than
`--expect-instance` names. The server at that URL is another deployment, or a
fresh database. Do not work around it until you know why. If the replacement
was intended, `prk profile remove <NAME>`, then `prk login --profile <NAME>
<URL>`.

### `INSTANCE_UNVERIFIED` (exit 3)

The server reports no instance id, and something requires one: the profile's
pin, `--expect-instance`, or a project file. A pinned server that stops
reporting its instance is refused like a mismatch.

### `INSTANCE_NOT_ALLOWED` (exit 3)

The project file's allow list does not include the selected server's instance.
Choose a profile for a deployment the repository lists. If the deployment does
belong to the project, add it with `prk profile pin`.

### `ISSUER_MISMATCH` (exit 3)

The server now signs in through a different Access organisation than the
profile was created against, or an `[[allow]]` entry's `issuer` does not match
the profile's. Nothing was saved. If the move was intended, remove and re-add
the profile.

### `PROJECT_FILE_INVALID` (exit 2)

`.prick.toml` lists no `[[allow]]`, carries a malformed instance id or slug,
names a `profile` while listing several deployments, or `.prick.local.toml`
selects an instance the shared file does not allow or is not ignored by git.
The message names the file and the rule. A file that does not parse, including
one with a key the format does not have such as `url`, is reported here too,
with the parser's line.

### `PROFILE_EDIT_REFUSED` (exit 2)

A change to the profile set was refused: the name is taken or tombstoned, or
`prk login --profile <NAME> <URL>` named an existing profile with a different
URL. A profile's server never changes; remove it and add a new one.

### `INVALID_URL` and `INVALID_INSTANCE` (exit 2)

A server URL must be `https://`, or `http://` to a loopback address, and carry
no `user@`. An instance id is 32 lowercase hex digits.

### `PROFILE_STORE_FAILED` (exit 1)

`config.toml` could not be read, parsed or written. A
`config.toml` written by a newer `prk` is refused with a message saying so;
update `prk`. A hand-edited `config.toml` is validated on every run, and the
message names the field.

## Next steps

- [Work with two organisations](/examples/work-with-two-organisations) — the
  whole flow, with output.
- [`prk profile`](/reference/cli/profile/) — every subcommand and flag.
- [Threat model](/architecture/threat-model#writing-to-the-wrong-organisation) —
  why each control exists.
