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

:::note[Where this page comes from]
`crates/prk/src/cli.rs` is the single source of truth for the interface — the
binary parses with it, `xtask` generates completions and man pages from it, and
this page is written against it. There is no second description to drift.

Every command listed below is wired: it resolves a credential, builds a request
and talks to your Worker. The API surface it calls is still landing, so if a
subcommand answers `404` or `422` against a current deployment, compare it against
[`docs/openapi.json`](https://github.com/yashau/prick/blob/main/docs/openapi.json),
which is generated from the router and is authoritative for the HTTP side.
:::

```
prk [GLOBAL FLAGS] <COMMAND> [ARGS]
```

Running `prk` with no arguments prints help and exits 2.

## Global flags

Every flag in this table is global: `prk --json secrets list` and
`prk secrets list --json` are the same command.

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

:::danger[`--access-client-secret` is visible to other processes]
A value passed there appears in `ps` output for every user on the machine and in
your shell history. That is a property of how arguments are passed, and nothing the
program does can remove it. Prefer `PRK_ACCESS_CLIENT_SECRET`, or
`--access-client-secret-file`, on any machine you do not exclusively control.

`--access-client-secret-file` reads the secret from a file, or from stdin when the
path is `-`, and strips one trailing newline so a file written by `echo` works. An
empty file is an error rather than an empty credential — the CI failure mode is a
secret that never got injected, and authenticating as nobody produces a `403` that
reads like a permissions problem.

A file **takes precedence** over both the flag and the environment variable, and it
refuses to fall back to `CF_ACCESS_CLIENT_ID` for the id half. Authenticating as
somebody other than the identity whose secret was just read off disk is the failure
mode that rule designs out.
:::

Notes:

- **`-P` and `-E` are uppercase.** They are global arguments, so a lowercase
  `-p`/`-e` would be consumed on _every_ subcommand and could never be used for
  anything else. Uppercase keeps the lowercase letters free.
- `--quiet` and `--verbose` are mutually exclusive; giving both is a usage error.
- `--quiet` suppresses progress and diagnostics. It never suppresses results.
- `--verbose` is a count: `-vv` is more detail than `-v`.
- `--no-input` never prompts. It fails instead of asking, which is what CI wants.
- `--color auto` is defined as "colourise when stderr is a terminal, and respect
  `NO_COLOR`". This build emits no colour, so the setting is currently inert.
- An explicit flag takes precedence over the corresponding environment variable.

## Environment variables

| Variable                   | Fallback                  | Purpose                            |
| -------------------------- | ------------------------- | ---------------------------------- |
| `PRK_API_URL`              |                           | Base URL of the Worker             |
| `PRK_PROJECT`              |                           | Default project                    |
| `PRK_ENV`                  |                           | Default environment                |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | Access service token client id     |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Access service token client secret |

Precedence for the service token is resolved in
`crates/prick-auth/src/credential.rs`: `--access-client-secret-file` first, then
the flags, then `PRK_ACCESS_*`, then `CF_ACCESS_*`. **Both halves must come from
the same place** — a `PRK_` id paired with a `CF_` secret is not a credential.

The pair is sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret`
request headers by `crates/prick-api/src/client.rs`.

`PRK_API_URL` is only needed when you have not run `prk login`, which records the
server it signed in to.

## Commands

### `prk login`

```
prk login <URL> [--storage <BACKEND>] [--no-browser]
```

Authenticate against a prick server.

| Argument | Meaning                |
| -------- | ---------------------- |
| `<URL>`  | Base URL of the server |

| Flag           | Values            | Default |
| -------------- | ----------------- | ------- |
| `--storage`    | `file`, `keyring` | `file`  |
| `--no-browser` |                   | off     |

`file` writes a token file with mode `0600`, in a directory created with mode
`0700`. The write is atomic — temporary file, then rename — and the mode is set at
creation, so there is no window in which a token file exists world-readable.
`keyring` uses the OS keyring and is opt-in: it breaks over SSH and in CI where
there is no session to unlock it, and on macOS the Keychain ACL binds to the
binary's code signature, so every update re-prompts.

`--no-browser` prints the authorization URL instead of opening one, for a machine
with no display. The loopback listener still receives the redirect. It is also
applied automatically when no browser is available.

`prk login` records which server it signed in to, so later commands need neither
`--api-url` nor `PRK_API_URL`. It warns loudly — even under `--json`, which
suppresses every other diagnostic — if `/health` answered `200` to an
unauthenticated probe, because that means Cloudflare Access is not in front of the
hostname.

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

Check connectivity, credentials and configuration. **Every check runs**; the exit
code is decided at the end. A command that reported the first failure and exited
would hide "your token file is world-readable" behind however long it takes to fix
"cannot reach the server".

| Check           | Reports                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `server url`    | The resolved URL, and whether it came from a flag/variable or from the stored login     |
| `token storage` | Whether the token file exists and whether it is owner-only. Never its contents          |
| `access`        | The unauthenticated probe: Access with managed OAuth, Access without it, or **nothing** |
| `reachability`  | Fails when the probe could not complete at all                                          |
| `identity`      | The subject and kind `/whoami` resolved                                                 |
| `credentials`   | Warns when no credential could be resolved                                              |
| `installation`  | Whether the binary is being run through the npm shim rather than natively               |

The probe runs **before** any credential is sent, because it is the only thing that
can tell an unprotected server from a protected one. An unprotected server is a
`FAIL`, not a warning.

Each line is marked `ok`, `warn`, `FAIL` or `skip` — ASCII rather than symbols,
because this output gets pasted into issue trackers. Only `FAIL` makes the command
exit non-zero; a warning does not, since `prk doctor` is run to find out what is
wrong and exiting non-zero for "you installed this through npm" would make it
useless in a health check. Under `--json` it emits
`{ "ok": …, "checks": [{ "name", "status", "detail" }] }`.

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

| Flag                    | Command    | Meaning                                                     |
| ----------------------- | ---------- | ----------------------------------------------------------- |
| `--stdin`               | `set`      | Read the value from stdin instead of prompting              |
| `--description <TEXT>`  | `set`      | Human-readable description stored with the secret           |
| `--dry-run`             | `upload`   | Report what would change and exit without writing           |
| `--expected-rev <REV>`  | `upload`   | Fail unless the environment is still at this revision       |
| `--format <FORMAT>`     | `download` | `env` (default), `shell`, `yaml`, `json`                    |
| `--output <FILE>`, `-o` | `download` | Write to a file instead of stdout, created with mode `0600` |
| `--to <N>`              | `rollback` | The version to restore                                      |

`set` never takes the value as an argument: it would be in the shell history and
visible in `ps`. The prompt reads the terminal device directly, which is what
lets `--stdin` and an interactive prompt coexist.

`list` returns names and metadata, never values. `get` fetches one secret rather
than downloading the environment to print one line of it.

A row whose ciphertext will not decrypt is listed as `UNREADABLE` rather than
dropped, and a trailing warning says not to deploy from that environment until it
is resolved. A listing that is quietly one row shorter is how a deploy goes out
without `DATABASE_URL`.

`history` currently prints the server's JSON verbatim whether or not `--json` was
given — it has no table rendering yet.

### `prk run`

```
prk run [--allow-unsafe-env] -- <COMMAND> [ARGS...]
```

Run a command with the environment's secrets in its environment.

| Flag                 | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
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
prk access explain <SUBJECT>
```

| Flag           | Values                               | Default       |
| -------------- | ------------------------------------ | ------------- |
| `--denied`     |                                      | off           |
| `--role`       | `reader`, `writer`, `admin`          | required      |
| `--scope`      | `project:environment`, `*` wildcards | `*:*`         |
| `--expires-in` | days                                 | never expires |

`<SUBJECT>` is an email address or a service token's common name.

`--scope` is split on the **first** colon only, so an environment component may
itself contain colons.

`--denied` lists identities that were refused and have no grant. That is how a
service token introduces itself; without it, `prk access identities` lists every
subject the server has ever seen authenticate.

`list` and `identities` currently print the server's JSON verbatim whether or not
`--json` was given. There is no `prk` subcommand for groups yet — manage those
through the API or the web UI.

`list` shows **direct** grants only, which with groups in the model is half the
picture. `explain` is the other command: it reads
`GET /identities/{id}/effective-permissions`, so it covers roles held through a
group, and it names what conferred each one rather than only reporting the role.

```
$ prk access explain bob@example.com
bob@example.com	user
groups	contractors, platform
billing:production	admin	via group `platform` on `billing:*`
     reader	a direct grant	on `billing:production`
  -> admin	group `platform`	on `billing:*`
```

The first column of each entry is the scope, spelled the way `--scope` takes one.
Underneath it is every grant that reaches that scope — including grants sitting
higher up, because "the `platform` group has admin on the project" _is_ the answer
to why Bob has the environment. `->` marks the one the server reported as
`decisive`: the one that actually set the role, and therefore the one to remove.

A **disabled** identity reports `none` at every scope with nothing marked, and the
sources still listed — the kill switch outranks every grant, and what re-enabling
would restore is the thing being decided.

Entries are narrowed to the scopes you administer. Sources inside a visible entry
are not, so a project admin can see that the role came from a global grant on a
group even though the global entry itself is invisible to them.

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

| Outcome | stdout            | stderr                  |
| ------- | ----------------- | ----------------------- |
| Success | one JSON document | **empty**               |
| Failure | **empty**         | one JSON error envelope |

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

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success                                              |
| 1    | Unclassified failure                                 |
| 2    | Usage error, emitted by the argument parser          |
| 3    | Not authenticated                                    |
| 4    | Not authorized                                       |
| 5    | Not found                                            |
| 6    | Conflict or failed precondition                      |
| 7    | Cannot reach the server                              |
| 8    | Server error                                         |
| 9    | Output cannot be represented in the requested format |
| 10   | Rate limited                                         |
| 11   | Request rejected as invalid                          |

Source: `crates/prick-core/src/classify.rs`.

## Error codes

The stable machine-readable codes emitted under `--json`.

| Code                  | Exit | Retryable | Meaning                                                                                     |
| --------------------- | ---- | --------- | ------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`     | 3    | no        | No credentials, or they expired and could not be refreshed                                  |
| `FORBIDDEN`           | 4    | no        | Authenticated, but not granted the role this operation needs                                |
| `NOT_FOUND`           | 5    | no        | The project, environment, secret or version does not exist — or is not visible to you       |
| `CONFLICT`            | 6    | yes       | A concurrent writer won                                                                     |
| `PRECONDITION_FAILED` | 6    | no        | `--expected-rev` did not match                                                              |
| `VALIDATION_FAILED`   | 11   | no        | The payload was rejected                                                                    |
| `PAYLOAD_TOO_LARGE`   | 11   | no        | The environment would exceed its secret cap                                                 |
| `RATE_LIMITED`        | 10   | yes       | The server asked the client to slow down                                                    |
| `SERVER_ERROR`        | 8    | yes       | The server failed internally                                                                |
| `SERVICE_UNAVAILABLE` | 8    | yes       | Up but temporarily refusing work, or no admins configured yet                               |
| `UNREACHABLE`         | 7    | yes       | DNS, connection refused, or no route                                                        |
| `TLS_FAILURE`         | 7    | no        | The TLS handshake failed — typically a corporate proxy with a private certificate authority |
| `TIMEOUT`             | 7    | yes       | The request exceeded `--timeout`                                                            |
| `NOT_A_PRICK_SERVER`  | 7    | no        | Something answered, but it is not a prick server                                            |
| `UNKNOWN`             | 1    | no        | A status with no specific handling                                                          |

Codes raised by the client itself rather than by a response:

| Code                     | Exit | Meaning                                                                              |
| ------------------------ | ---- | ------------------------------------------------------------------------------------ |
| `UNREPRESENTABLE_OUTPUT` | 9    | A value contains a control character the chosen format cannot encode                 |
| `INVALID_DOTENV`         | 11   | A `.env` document could not be parsed unambiguously                                  |
| `INVALID_SCOPE`          | 11   | A scope string could not be parsed                                                   |
| `UNSAFE_ENVIRONMENT`     | 11   | A secret's name is one the loader interprets, and `--allow-unsafe-env` was not given |

"Retryable" means retrying the identical request could plausibly succeed. It is
deliberately conservative: a write that may have partially applied is not listed,
even where the server would tolerate a repeat.

Status is classified **before** the response body is deserialised. Parsing first
is what turns a proxy's HTML error page into an unreadable decoding error instead
of "the URL you configured is not a prick server".

## Next

- [API reference](/reference/api)
- [Configuration](/reference/configuration)
