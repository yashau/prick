---
title: CLI reference
description: Every prk command, flag, environment variable and exit code.
sidebar:
  order: 1
  label: CLI
---

`prk` is the command-line client. It is a pure HTTP client against your Worker:
it never talks to the Cloudflare API, and it needs no Cloudflare credentials
beyond your Access session.

:::caution[Implementation status]
The interface below is complete and is the single source of truth — the binary
parses with it, `xtask` generates completions and man pages from it, and this
page is written against it (`crates/prk/src/cli.rs`).

The **behaviour** is not complete. Only `prk version` and `prk completions` do
work. Every other command exits with `NOT_IMPLEMENTED` and exit code 1 — a real
error with a real exit code, not a stub that prints and returns success.
:::

```
prk [GLOBAL FLAGS] <COMMAND> [ARGS]
```

Running `prk` with no arguments prints help and exits 2.

## Global flags

Every flag in this table is global: `prk --json secrets list` and
`prk secrets list --json` are the same command.

| Flag | Short | Value | Default | Environment |
|---|---|---|---|---|
| `--json` | | | off | |
| `--color` | | `auto`, `always`, `never` | `auto` | |
| `--quiet` | `-q` | | off | |
| `--verbose` | `-v` | repeatable | off | |
| `--no-input` | | | off | |
| `--yes` | `-y` | | off | |
| `--api-url` | | `<URL>` | | `PRK_API_URL` |
| `--project` | `-P` | `<PROJECT>` | | `PRK_PROJECT` |
| `--env` | `-E` | `<ENVIRONMENT>` | | `PRK_ENV` |
| `--timeout` | | `<SECONDS>` | `30` | |

Notes:

- **`-P` and `-E` are uppercase.** They are global arguments, so a lowercase
  `-p`/`-e` would be consumed on *every* subcommand and could never be used for
  anything else. Uppercase keeps the lowercase letters free.
- `--quiet` and `--verbose` are mutually exclusive; giving both is a usage error.
- `--quiet` suppresses progress and diagnostics. It never suppresses results.
- `--verbose` is a count: `-vv` is more detail than `-v`.
- `--no-input` never prompts. It fails instead of asking, which is what CI wants.
- `--color auto` is defined as "colourise when stderr is a terminal, and respect
  `NO_COLOR`". This build emits no colour, so the setting is currently inert.
- An explicit flag takes precedence over the corresponding environment variable.

## Environment variables

| Variable | Fallback | Purpose |
|---|---|---|
| `PRK_API_URL` | | Base URL of the Worker |
| `PRK_PROJECT` | | Default project |
| `PRK_ENV` | | Default environment |
| `PRK_ACCESS_CLIENT_ID` | `CF_ACCESS_CLIENT_ID` | Access service token client id |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Access service token client secret |

The first three are wired through the argument parser today. The service-token
pair is defined in `crates/prick-auth/src/credential.rs` — including the
precedence order and the `CF-Access-Client-Id` / `CF-Access-Client-Secret`
header spellings — but the HTTP client that would send them is not written yet.

## Commands

### `prk login`

```
prk login <URL> [--storage <BACKEND>]
```

Authenticate against a prick server.

| Argument | Meaning |
|---|---|
| `<URL>` | Base URL of the server |

| Flag | Values | Default |
|---|---|---|
| `--storage` | `file`, `keyring` | `file` |

`file` writes a token file with mode `0600`, in a directory created with mode
`0700`. `keyring` uses the OS keyring and is opt-in: it breaks over SSH and in CI
where there is no session to unlock it, and on macOS the Keychain ACL binds to
the binary's code signature, so every update re-prompts.

### `prk logout`

```
prk logout
```

Discard stored credentials.

### `prk whoami`

```
prk whoami
```

Show the identity the server sees. This is the command to run after a `403`: the
subject it prints is what an administrator needs in order to grant you anything.

### `prk doctor`

```
prk doctor
```

Check connectivity, credentials and configuration. It is specified to continue
past failures rather than stopping at the first, and to report, in order: the
resolved API URL and where it came from, DNS and TCP reachability, the TLS
handshake, `/health` and whether the responder is actually a prick server, which
credential was found and when it expires (never the credential itself), the token
file's permissions, and whether the binary is being invoked through the npm shim.

### `prk projects`

```
prk projects list
prk projects create <NAME> [--slug <SLUG>]
prk projects rename <PROJECT> <NAME>
prk projects rm <PROJECT>
```

`--slug` defaults to a slugified `<NAME>`. `rm` deletes the project and
everything in it.

### `prk env`

```
prk env list
prk env create <NAME>
prk env rm <NAME>
```

Operates within `--project`. `rm` deletes the environment and its secrets.

### `prk secrets`

```
prk secrets list
prk secrets get <KEY>
prk secrets set <KEY> [--stdin] [--description <TEXT>]
prk secrets rm <KEY>
prk secrets upload <FILE> [--dry-run] [--expected-rev <REV>]
prk secrets download [--format <FORMAT>] [--output <FILE>]
prk secrets history <KEY>
prk secrets rollback <KEY> --to <N>
```

| Flag | Command | Meaning |
|---|---|---|
| `--stdin` | `set` | Read the value from stdin instead of prompting |
| `--description <TEXT>` | `set` | Human-readable description stored with the secret |
| `--dry-run` | `upload` | Report what would change and exit without writing |
| `--expected-rev <REV>` | `upload` | Fail unless the environment is still at this revision |
| `--format <FORMAT>` | `download` | `env` (default), `shell`, `yaml`, `json` |
| `--output <FILE>`, `-o` | `download` | Write to a file instead of stdout, created with mode `0600` |
| `--to <N>` | `rollback` | The version to restore |

`set` never takes the value as an argument: it would be in the shell history and
visible in `ps`. The prompt reads the terminal device directly, which is what
lets `--stdin` and an interactive prompt coexist.

`list` returns names and metadata, never values. `get` fetches one secret rather
than downloading the environment to print one line of it.

### `prk run`

```
prk run [--allow-unsafe-env] -- <COMMAND> [ARGS...]
```

Run a command with the environment's secrets in its environment.

| Flag | Meaning |
|---|---|
| `--allow-unsafe-env` | Permit secrets whose names the dynamic loader or a language runtime interprets before the program starts |

Everything after `--` is the child's, including flags `prk` also understands.
Arguments are captured as raw OS strings and passed straight to the process API:
nothing is joined into a command line, so quoting, backslashes and non-UTF-8
bytes survive exactly.

Without `--allow-unsafe-env`, names like `LD_PRELOAD`, `DYLD_*`, `PATH`,
`NODE_OPTIONS` and `BASH_ENV` are refused, because a server that can set them can
run arbitrary code in the child. The full list is in
[Using secrets](/guides/using-secrets/#names-that-are-refused).

### `prk access`

```
prk access list
prk access identities [--denied]
prk access grant <SUBJECT> --role <ROLE> [--scope <SCOPE>] [--expires-in <DAYS>]
prk access revoke <SUBJECT> [--scope <SCOPE>]
```

| Flag | Values | Default |
|---|---|---|
| `--denied` | | off |
| `--role` | `reader`, `writer`, `admin` | required |
| `--scope` | `project:environment`, `*` wildcards | `*:*` |
| `--expires-in` | days | never expires |

`<SUBJECT>` is an email address or a service token's common name.

`--scope` is split on the **first** colon only, so an environment component may
itself contain colons.

`--denied` lists identities that were refused and have no grant. That is how a
service token introduces itself.

### `prk completions`

```
prk completions <SHELL>
```

Write a completion script to stdout. Supported shells are `bash`, `elvish`,
`fish`, `powershell` and `zsh`; run `prk completions --help` for the exact list
your build accepts.

Generated from the same parser definition the binary uses, so a completion script
cannot describe an interface that does not exist.

```bash
prk completions bash > /etc/bash_completion.d/prk
```

### `prk version`

```
prk version
```

Print the version. `prk --version` does the same.

In-repository builds report `0.0.0-dev`. A release stamps the real
`YYYY.MMDD.N` into every manifest immediately before compiling, so the binary,
the git tag and every published package carry the same literal. The documented
consequence: `git checkout <tag> && cargo build` reports `0.0.0-dev` unless you
stamp first.

## Output contract

`data` goes to **stdout**. It is the answer to the question that was asked, and
nothing else ever goes there. Progress, diagnostics and failures go to
**stderr**.

Under `--json` the split is strict:

| Outcome | stdout | stderr |
|---|---|---|
| Success | one JSON document | **empty** |
| Failure | **empty** | one JSON error envelope |

Both halves matter. Diagnostics on stderr during a successful `--json` run break
callers that merge the streams; anything on stdout during a failure means
`prk secrets download --json > file` could write a truncated file that still
parses.

The failure envelope:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "…",
    "hint": "Run `prk login <url>`, or set PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET for a service token."
  }
}
```

`hint` is present only when the failure has an actionable next step.

Without `--json`, a failure is written to stderr as `error: <message>`, followed
by `  help: <hint>` when there is one.

This is enforced rather than reviewed: `clippy::print_stdout` and
`clippy::print_stderr` are denied workspace-wide, and exactly one module lifts
the ban. A secret reaching stderr is a build failure.

## Exit codes

Scripts branch on these, so a value is never reassigned to a different meaning.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unclassified failure |
| 2 | Usage error, emitted by the argument parser |
| 3 | Not authenticated |
| 4 | Not authorized |
| 5 | Not found |
| 6 | Conflict or failed precondition |
| 7 | Cannot reach the server |
| 8 | Server error |
| 9 | Output cannot be represented in the requested format |
| 10 | Rate limited |
| 11 | Request rejected as invalid |

Source: `crates/prick-core/src/classify.rs`.

## Error codes

The stable machine-readable codes emitted under `--json`.

| Code | Exit | Retryable | Meaning |
|---|---|---|---|
| `UNAUTHENTICATED` | 3 | no | No credentials, or they expired and could not be refreshed |
| `FORBIDDEN` | 4 | no | Authenticated, but not granted the role this operation needs |
| `NOT_FOUND` | 5 | no | The project, environment, secret or version does not exist — or is not visible to you |
| `CONFLICT` | 6 | yes | A concurrent writer won |
| `PRECONDITION_FAILED` | 6 | no | `--expected-rev` did not match |
| `VALIDATION_FAILED` | 11 | no | The payload was rejected |
| `PAYLOAD_TOO_LARGE` | 11 | no | The environment would exceed its secret cap |
| `RATE_LIMITED` | 10 | yes | The server asked the client to slow down |
| `SERVER_ERROR` | 8 | yes | The server failed internally |
| `SERVICE_UNAVAILABLE` | 8 | yes | Up but temporarily refusing work, or no admins configured yet |
| `UNREACHABLE` | 7 | yes | DNS, connection refused, or no route |
| `TLS_FAILURE` | 7 | no | The TLS handshake failed — typically a corporate proxy with a private certificate authority |
| `TIMEOUT` | 7 | yes | The request exceeded `--timeout` |
| `NOT_A_PRICK_SERVER` | 7 | no | Something answered, but it is not a prick server |
| `UNKNOWN` | 1 | no | A status with no specific handling |

Codes raised by the client itself rather than by a response:

| Code | Exit | Meaning |
|---|---|---|
| `UNREPRESENTABLE_OUTPUT` | 9 | A value contains a control character the chosen format cannot encode |
| `INVALID_DOTENV` | 11 | A `.env` document could not be parsed unambiguously |
| `INVALID_SCOPE` | 11 | A scope string could not be parsed |
| `UNSAFE_ENVIRONMENT` | 11 | A secret's name is one the loader interprets, and `--allow-unsafe-env` was not given |
| `NOT_IMPLEMENTED` | 1 | The command exists in the interface but has no implementation yet |

"Retryable" means retrying the identical request could plausibly succeed. It is
deliberately conservative: a write that may have partially applied is not listed,
even where the server would tolerate a repeat.

Status is classified **before** the response body is deserialised. Parsing first
is what turns a proxy's HTML error page into an unreadable decoding error instead
of "the URL you configured is not a prick server".

## Next

- [API reference](/reference/api)
- [Configuration](/reference/configuration)
