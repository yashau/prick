---
title: CLI reference
description: Every prk command, flag, environment variable and exit code, with worked examples.
sidebar:
  order: 1
  label: Overview
---

`prk` is the command-line client for your prick server: a single static binary
that talks HTTP to your Worker, authenticating with your Cloudflare Access
session.

```bash
prk secrets list --project api --env production
```

```
DATABASE_URL	v4	you@example.com
STRIPE_SECRET_KEY	v2	you@example.com
```

## Before you begin

You need a deployed server and a credential. If you have neither yet, work
through the [Quickstart](/getting-started/quickstart) first, then come back.

```bash
prk login https://prick.example.com
```

Once you have signed in, `prk` remembers which server it signed in to, so no
later command needs `--api-url`.

## The shape of a command

```
prk [GLOBAL FLAGS] <COMMAND> [ARGS]
```

Running `prk` with no arguments prints help and exits 2.

Most commands act on one environment inside one project, so they need to know
which. You can say it three ways, and they are equivalent:

```bash
prk secrets list --project api --env production
```

```bash
prk secrets list -P api -E production
```

```bash
export PRK_PROJECT=api
export PRK_ENV=production
prk secrets list
```

:::tip[Set the project and environment once per shell]
Exporting `PRK_PROJECT` and `PRK_ENV` at the top of a terminal session — or in a
`direnv` file per repository — removes two flags from every command you run for
the rest of the day.
:::

## Commands

| Command                                         | What it does                                            |
| ----------------------------------------------- | ------------------------------------------------------- |
| [`prk login`](/reference/cli/sign-in)           | Sign in to a server through your browser                |
| [`prk logout`](/reference/cli/sign-in)          | Discard stored credentials                              |
| [`prk whoami`](/reference/cli/sign-in)          | Show the identity the server sees                       |
| [`prk doctor`](/reference/cli/sign-in)          | Check connectivity, credentials and configuration       |
| [`prk projects`](/reference/cli/projects)       | Create, list, rename and delete projects                |
| [`prk env`](/reference/cli/env)                 | Create, list and delete environments                    |
| [`prk secrets`](/reference/cli/secrets)         | Read, write, import, export, version and roll back      |
| [`prk run`](/reference/cli/run)                 | Run a program with the environment's secrets in its env |
| [`prk access`](/reference/cli/access)           | Manage identities and grants                            |
| [`prk completions`](/reference/cli/completions) | Generate a shell completion script                      |
| [`prk version`](/reference/cli/completions)     | Print the version                                       |

Every command accepts `--help`:

```bash
prk secrets upload --help
```

## Administered in the web console

The Worker serves a SvelteKit admin UI alongside the API, and part of the model
is administered there:

| Screen                       | Holds                                                              |
| ---------------------------- | ------------------------------------------------------------------ |
| `/groups`                    | [Groups](/guides/access-control#groups), their members and grants  |
| `/audit`                     | The audit log                                                      |
| `/settings`                  | The keyring and the [rekey](/guides/key-rotation) that advances it |
| `/p/<project>/<environment>` | Renaming a secret                                                  |

`prk access explain` reads a role held through a group, so the CLI names the
group when a group is what confers someone's access.

## Global flags

These work on every command, and they work in either position:
`prk --json secrets list` and `prk secrets list --json` are the same command.

| Flag                          | Short | Value                     | Default | Environment                |
| ----------------------------- | ----- | ------------------------- | ------- | -------------------------- |
| `--json`                      |       |                           | off     |                            |
| `--color`                     |       | `auto`, `always`, `never` | `auto`  |                            |
| `--quiet`                     | `-q`  |                           | off     |                            |
| `--verbose`                   | `-v`  | repeatable                | off     |                            |
| `--no-input`                  |       |                           | off     |                            |
| `--yes`                       | `-y`  |                           | off     |                            |
| `--api-url`                   |       | `<URL>`                   |         | `PRK_API_URL`              |
| `--access-client-id`          |       | `<ID>`                    |         | `PRK_ACCESS_CLIENT_ID`     |
| `--access-client-secret`      |       | `<SECRET>`                |         | `PRK_ACCESS_CLIENT_SECRET` |
| `--access-client-secret-file` |       | `<FILE>`, or `-`          |         |                            |
| `--project`                   | `-P`  | `<PROJECT>`               |         | `PRK_PROJECT`              |
| `--env`                       | `-E`  | `<ENVIRONMENT>`           |         | `PRK_ENV`                  |
| `--timeout`                   |       | `<SECONDS>`               | `30`    |                            |

A few of these are worth a sentence.

**`-P` and `-E` are uppercase.** They are global flags, so the uppercase letters
keep `-p` and `-e` free for individual subcommands.

**`--json` changes the contract, not just the formatting.** See
[Scripting with `--json`](/examples/scripting-with-json).

**`--no-input` is the CI flag.** It fails instead of prompting, which is what an
unattended job wants.

```bash
prk secrets download --no-input --format env --output .env
```

**`--verbose` is a count.** `-vv` is more detail than `-v`. It writes to stderr,
so a piped result stays clean.

**`--quiet` suppresses progress and diagnostics, and still prints results.** It
is mutually exclusive with `--verbose`; giving both is a usage error.

**`--color auto`** means "colourise when stderr is a terminal, and respect
`NO_COLOR`". This build emits no colour, so the setting is inert today.

## Environment variables

| Variable                   | Fallback                  | Purpose                              |
| -------------------------- | ------------------------- | ------------------------------------ |
| `PRK_API_URL`              |                           | Base URL of the Worker               |
| `PRK_PROJECT`              |                           | Default project                      |
| `PRK_ENV`                  |                           | Default environment                  |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | Access service token client id       |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Access service token client secret   |
| `PRK_CONFIG_DIR`           |                           | Directory holding `credentials.json` |

`PRK_API_URL` is only needed when you have not run `prk login`, which records
the server it signed in to.

`PRK_CONFIG_DIR` overrides where the stored session lives, which is how you keep
two servers' sessions apart or point a CI job at a scratch directory. See
[`prk login`](/reference/cli/sign-in#where-the-token-is-stored).

The `CF_*` fallbacks exist so that a pipeline already configured for
`cloudflared access` works with no changes.

### Where a setting comes from

For the server URL, first match wins:

1. `--api-url`
2. `PRK_API_URL`
3. The server recorded by your last `prk login`

For the service token:

1. `--access-client-secret-file`
2. `--access-client-id` / `--access-client-secret`
3. `PRK_ACCESS_CLIENT_ID` / `PRK_ACCESS_CLIENT_SECRET`
4. `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`

:::caution[Both halves must come from the same place]
A `PRK_` client id paired with a `CF_` client secret is not a credential. Mixing
them is how a job authenticates as an identity nobody intended, so it is refused
rather than resolved.
:::

:::danger[`--access-client-secret` is visible to other processes]
A value passed there appears in `ps` output for every user on the machine, and
in your shell history. That is a property of how arguments are passed, and
nothing the program does can remove it.

Prefer `PRK_ACCESS_CLIENT_SECRET`, or read it from a file:

```bash
prk secrets list --access-client-id "<id>.access" --access-client-secret-file /run/token
```

`--access-client-secret-file` reads the secret from a file, or from stdin when
the path is `-`, and strips one trailing newline so a file written by `echo`
works. An empty file is an error rather than an empty credential — the CI
failure mode is a secret that never got injected, and authenticating as nobody
produces a `403` that reads like a permissions problem.

A file **takes precedence** over both the flag and the environment variable, and
it will not fall back to `CF_ACCESS_CLIENT_ID` for the id half.
:::

## Output contract

Results go to **stdout**. Progress, diagnostics, warnings and failures go to
**stderr**. That separation is what makes this safe:

```bash
prk secrets download --format json > secrets.json
```

Under `--json` the split is strict:

| Outcome | stdout            | stderr                  |
| ------- | ----------------- | ----------------------- |
| Success | one JSON document | **empty**               |
| Failure | **empty**         | one JSON error envelope |

Both halves matter, so both are guaranteed: a caller that merges the streams
still parses a successful run, and a redirect that fails writes an empty file
rather than a truncated one.

The rule is enforced by the compiler. `clippy::print_stdout` and
`clippy::print_stderr` are denied across the Rust workspace, and exactly one
module lifts the ban — so a secret reaching a log line is a build failure.

## Next steps

- [Exit codes and errors](/reference/cli/errors) — what each failure means and whether to retry.
- [Examples](/examples/) — complete, runnable walkthroughs.
- [Configuration](/reference/configuration) — the server side.

:::note[Where this page comes from]
`crates/prk/src/cli.rs` is the single source of truth for the interface. The
binary parses with it, `xtask` generates completions and man pages from it, and
these pages are written against it — so there is no second description to drift.

The API surface underneath is described by
[`docs/openapi.json`](https://github.com/yashau/prick/blob/main/docs/openapi.json),
which is generated from the router.
:::
