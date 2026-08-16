---
title: Using secrets
description: How prk run injects secrets into a child process, and what it refuses to inject.
sidebar:
  order: 4
---

There are two ways to get a secret into a program. Prefer the first.

```bash
prk run --project api --env production -- ./deploy.sh
```

fetches the environment's secrets, puts them in the child process's environment
block, and runs the command. Nothing touches disk.

```bash
prk secrets download --format env --output .env --project api --env production
```

writes a file at mode `0600`. Use this only when the consumer genuinely needs a
file — Docker's `--env-file`, for instance — and delete it afterwards.

:::note[Before you begin]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication). Full flags are in
[`prk run`](/reference/cli/run).
:::

## How `prk run` runs things

The command and its arguments are captured as raw OS strings and handed straight
to the process API. **Nothing is ever joined into a command line**, so there is
no quoting to get wrong, and non-UTF-8 arguments survive byte for byte.

```bash
prk run --project api --env production -- sh -c 'echo "$DATABASE_URL" | wc -c'
```

Everything after `--` belongs to the child, including flags that prick also
understands:

```bash
prk run --project api --env production -- npm test --json
```

That `--json` reaches `npm`. It is not prick's `--json`.

| Platform | Behaviour                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unix     | `prk` calls `execvp` and **becomes** the child. Exit codes and signals are correct by construction, and job control (`SIGTSTP`/`SIGCONT`) works because there is no supervisor left in the process tree |
| Windows  | There is no `exec`, so `prk` spawns and waits, inside a job object with `KILL_ON_JOB_CLOSE` (no orphaned grandchildren) and behind a console control handler (Ctrl-C reaches the child)                 |

## Names that are refused

A handful of environment variables are read by the dynamic loader or a language
runtime **before the program's own first instruction**. Whoever controls their
value controls what the program does — so a compromised server that can set
`LD_PRELOAD` gets arbitrary code execution on every machine that runs
`prk run`. The server stores secrets; it does not get to choose what code runs.

Those names are refused by default:

| Refused                |                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any name starting with | `LD_`, `DYLD_`                                                                                                                                                                                                |
| Exact names            | `BASH_ENV`, `ENV`, `GIT_SSH_COMMAND`, `GLIBC_TUNABLES`, `IFS`, `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, `PATH`, `PERL5OPT`, `PERL5LIB`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `RUBYLIB`, `RUBYOPT` |

Source: `crates/prick-core/src/keyname.rs`.

A single refused name fails the whole launch. It is not dropped from the set:
a child started with a silently missing variable is a debugging problem, and a
child started with a silently _present_ one is a breach.

Override only if the child really is meant to be configured that way:

```bash
prk run --allow-unsafe-env --project api --env production -- ./legacy-wrapper.sh
```

The error you get without it is `UNSAFE_ENVIRONMENT`, exit code 11, and it names
the offending variable.

## The environment is not a secure channel

`prk run` injects through the process environment, which on Linux is readable at
`/proc/<pid>/environ` by the same user and by root, and appears in a core dump.
This is a deliberate, documented trade — the alternative mechanisms are worse for
the same threat — but it is worth knowing before you decide what to store. See
[Threat model](/architecture/threat-model).

## Checking what was injected

```bash
prk run -vv --project api --env production -- node -e 'console.log("up")'
```

```
injecting 12 secrets into the child environment
variables: DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY, …
up
```

Names only — never values. Diagnostics go to stderr, so the child's own output
stays clean.

## Recipes

- [Docker](/guides/using-secrets/docker)
- [package.json scripts](/guides/using-secrets/package-json)
- [Cloudflare Workers](/guides/using-secrets/cloudflare-workers)
- [GitHub Actions](/guides/using-secrets/github-actions)

## Next steps

- [`prk run`](/reference/cli/run) — every flag, and the exit codes it preserves.
- [Onboard a new service](/examples/onboard-a-service)
