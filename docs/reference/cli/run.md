---
title: prk run
description: Run a program with an environment's secrets in its environment block.
sidebar:
  order: 6
---

`prk run` fetches an environment's secrets, puts them in a child process's
environment block, and becomes that process.

```
prk run [--allow-unsafe-env] -- <COMMAND> [ARGS...]
```

```bash
prk run --project api --env production -- npm start
```

Secrets reach the child through its environment block and nowhere else — no
temporary `.env`, no fifo, no file descriptor passed by path. Nothing is written
to disk.

| Flag                 | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `--allow-unsafe-env` | Permit secrets whose names the dynamic loader or a language runtime reads before your program starts |

## Everything after `--` belongs to the child

The separator is what makes this unambiguous, including for flags `prk` also
understands:

```bash
prk run -P api -E production -- npm test --json -q
```

`--json` and `-q` there go to `npm`. Put `prk`'s own flags before the separator:

```bash
prk run --allow-unsafe-env -P api -E production -- ./deploy.sh
```

Arguments are captured as raw OS strings and handed straight to the process API.
Nothing is ever joined into a command line, so quoting, backslashes and
non-UTF-8 bytes survive exactly as typed:

```bash
prk run -P api -E production -- sh -c 'echo $(id)'
```

## Your program's exit code is preserved

On Unix `prk` replaces itself with the child through `execvp`. On Windows it
waits and exits with the child's status. Either way the exit code and signal
disposition are the command's own, so a script cannot tell it ran under
`prk run`:

```bash
prk run -P api -E production -- false
echo $?
```

```
1
```

Two exit codes come from `prk` itself, and they are the ones a shell uses for
the same conditions:

| Exit | Meaning                                |
| ---- | -------------------------------------- |
| 127  | The command was not found on `PATH`    |
| 126  | It was found but could not be executed |

```bash
prk run -P api -E production -- nmp start
```

```
error: command not found: nmp
  help: Check the spelling and that the program is on PATH. `prk run` never invokes a shell, so shell builtins and aliases are not available; write `prk run -- sh -c '...'` if you need one.
```

:::note[`prk run` never invokes a shell]
That is what keeps quoting predictable — but it also means shell builtins,
aliases, pipes and redirections are not available. Ask for a shell explicitly
when you want one:

```bash
prk run -P api -E production -- sh -c 'migrate && npm start'
```

:::

## Names that are refused

Some environment variable names are read by the dynamic loader or a language
runtime **before** your program's own code runs. A server that can set them can
run arbitrary code in the child, so `prk run` refuses them by default.

```bash
prk run -P api -E production -- ./server
```

```
error: refusing to set `LD_PRELOAD` in the child environment: it is interpreted before the program starts, so its value controls what code runs. Pass --allow-unsafe-env to override.
  help: Rename the secret, or pass --allow-unsafe-env if the child really is meant to be configured this way.
```

Refused by exact name:

`BASH_ENV`, `ENV`, `GIT_SSH_COMMAND`, `GLIBC_TUNABLES`, `IFS`, `NODE_OPTIONS`,
`NODE_REPL_EXTERNAL_MODULE`, `PATH`, `PERL5OPT`, `PERL5LIB`, `PYTHONPATH`,
`PYTHONSTARTUP`, `PYTHONHOME`, `RUBYLIB`, `RUBYOPT`

Refused by prefix: `LD_*` and `DYLD_*` — which covers `LD_PRELOAD`, `LD_AUDIT`,
`LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES` and their many siblings. A prefix
rule rather than a list, because the loaders keep adding new ones.

The comparison is case-sensitive and exact, matching the loader's own: a
variable named `ld_preload` is genuinely inert, and `PATHS` or `LOAD_BALANCER`
are ordinary names.

### Overriding the guard

```bash
prk run --allow-unsafe-env -P api -E production -- ./server
```

:::caution[`--allow-unsafe-env` widens who can run code on this machine]
With it, anyone who can write a secret in that environment can execute arbitrary
code in the child. Reach for it only when you control the write side as tightly
as you control the machine.
:::

## Seeing what was injected

`prk run` writes diagnostics to stderr, so `-v` does not disturb the child's own
output:

```bash
prk run -vv -P api -E production -- node -e 'console.log("up")'
```

```
injecting 12 secrets into the child environment
variables: DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY, …
up
```

Names only — never values.

## Common errors

| Error                | Exit | What happened                                                            |
| -------------------- | ---- | ------------------------------------------------------------------------ |
| `UNSAFE_ENVIRONMENT` | 11   | A secret's name is loader-controlled and `--allow-unsafe-env` was absent |
| `LAUNCH_FAILED`      | 127  | The command was not found on `PATH`                                      |
| `LAUNCH_FAILED`      | 126  | The command was found but is not executable                              |
| `FORBIDDEN`          | 4    | You have no read grant on this environment                               |
| `RESPONSE_TOO_LARGE` | 12   | The environment holds more secret data than one response can carry       |

## Next steps

- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Workers, CI.
- [`prk secrets download`](/reference/cli/secrets#prk-secrets-download) — when the consumer needs a file.
