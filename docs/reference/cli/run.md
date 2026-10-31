---
title: prk run
description: Run a program with an environment's secrets in its environment block.
sidebar:
  order: 6
---

`prk run` fetches an environment's secrets, puts them in a child process's
environment block, and becomes that process.

```
prk run [--allow-unsafe-env] [--allow-prk-vars] -- <COMMAND> [ARGS...]
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
| `--allow-prk-vars`   | Inject secrets named like the variables `prk` itself reads to choose a server and a credential       |

`prk run` is a read: with several profiles it uses the default profile like
any other read, and a project's `.prick.toml` selects and checks the server
as it does for every command. See [`prk profile`](/reference/cli/profile).

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

## Names `prk run` does not inject

A secret named like a variable `prk` reads to choose its server or its
credential is skipped, with a warning naming the key and never the value:

`PRK_API_URL`, `PRK_PROFILE`, `PRK_CONFIG_DIR`, `PRK_EXPECT_INSTANCE`,
`PRK_ACCESS_CLIENT_ID`, `PRK_ACCESS_CLIENT_SECRET`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`

```bash
prk run -P api -E production -- ./deploy.sh
```

```
warning: not injecting `PRK_API_URL`: prk reads it, so a prk inside the command would follow it; pass --allow-prk-vars to inject it anyway
```

A secret is data from the server. With one of these names in the child's
environment, a `prk` the child runs — a deploy script that fetches another
environment, say — would take its server or its identity from that data, and
could be sent somewhere the operator never chose.

The match is by exact name. Every other `PRK_`-prefixed secret, such as
`PRK_FEATURE_FLAG`, is injected as usual. Your own environment passes through
to the child untouched, including any of these variables you set yourself;
only secrets are skipped.

The run continues without them: this is a skip, not a refusal. Inject them
anyway with `--allow-prk-vars`:

```bash
prk run --allow-prk-vars -P api -E production -- ./deploy.sh
```

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
