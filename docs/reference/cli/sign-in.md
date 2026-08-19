---
title: Sign in and diagnose
description: prk login, logout, whoami and doctor — getting a credential onto a machine and proving it works.
sidebar:
  order: 2
---

Four commands cover getting a credential onto a machine and confirming it
works: `prk login`, `prk logout`, `prk whoami` and `prk doctor`.

## `prk login`

```
prk login <URL> [--storage <BACKEND>] [--no-browser]
```

Sign in to a prick server through your browser.

| Argument | Meaning                |
| -------- | ---------------------- |
| `<URL>`  | Base URL of the server |

| Flag           | Values            | Default | Meaning                              |
| -------------- | ----------------- | ------- | ------------------------------------ |
| `--storage`    | `file`, `keyring` | `file`  | Where to keep the resulting token    |
| `--no-browser` |                   | off     | Print the URL instead of opening one |

### Sign in

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com
Signed in to https://prick.example.com
```

Your browser opens, you complete the Cloudflare Access sign-in, and the token
lands on disk. `prk login` also records **which server** it signed in to, so no
later command needs `--api-url` or `PRK_API_URL`.

### Sign in on a machine with no browser

```bash
prk login https://prick.example.com --no-browser
```

```
Signing in to https://prick.example.com
Open this URL to continue:
  https://example.cloudflareaccess.com/cdn-cgi/access/sso/oidc/…
```

Open the URL on a machine that has a browser. The loopback listener on the
remote machine still receives the redirect, provided the port is reachable —
which it is over an SSH session that forwards it. `--no-browser` is also applied
automatically when no browser is available.

### Where the token is stored

```bash
prk login https://prick.example.com --storage keyring
```

| Backend   | Default | Notes                                                        |
| --------- | ------- | ------------------------------------------------------------ |
| `file`    | Yes     | A file at mode `0600` in a directory at mode `0700`          |
| `keyring` | No      | The OS keyring. Opt-in, because it breaks over SSH and in CI |

The file is written atomically — temporary file, then rename — and the mode is
set at creation, so there is never a window in which a token file exists
world-readable. On Windows the DACL is replaced with a single entry for the
current user.

The file is called `credentials.json` and lives here:

| Platform | Path                                           |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/prick`, or `~/.config/prick` |
| macOS    | `~/Library/Application Support/prick`          |
| Windows  | `%APPDATA%\prick`                              |

Set `PRK_CONFIG_DIR` to override that path outright — useful for a CI job that
wants a scratch directory, or for keeping two servers' sessions apart:

```bash
PRK_CONFIG_DIR=~/.config/prick-staging prk login https://staging.prick.example.com
```

:::caution[The keyring is opt-in for a reason]
Over SSH there is no session keyring to unlock, and on macOS the Keychain ACL
binds to the binary's code signature — so every update re-prompts, which is
unusable from inside `prk run`. Pick it only on a desktop you sit in front of.
:::

### The warning you must not ignore

`prk login` probes `/api/v1/health` before it sends anything. If that answers
`200` to an unauthenticated caller, it warns loudly — even under `--json`, which
suppresses every other diagnostic:

```
warning: this server answered an unauthenticated request
warning: Put the application behind Cloudflare Access before storing anything in it.
```

That means Cloudflare Access is not in front of the hostname, and your secrets
manager is open to the internet. Stop and fix the Access application before you
store anything. See [Quickstart step 9](/getting-started/quickstart).

## `prk logout`

```
prk logout
```

Discard stored credentials.

```bash
prk logout
```

```
Signed out.
```

If there was nothing to discard, it says so and still exits 0:

```
No stored credentials.
```

Running it twice is harmless — it establishes the state "no credentials", and
that is idempotent.

## `prk whoami`

```
prk whoami
```

Show the identity the server sees. **This is the command to run after a `403`** —
the subject it prints is exactly what an administrator needs in order to grant
you anything.

```bash
prk whoami
```

```
you@example.com (user)
role: admin (global)
```

A service token prints its `common_name` instead:

```
e367826f93b8d71185e03fe518aff3b4.access (service)
```

The role line is your **global** role, and only that. A project-scoped admin
prints no role line here and is still an administrator of that project — use
[`prk access explain`](/reference/cli/access#prk-access-explain) for the full
picture.

If you are an administrator only because you are named in `BOOTSTRAP_ADMINS`,
`whoami` says so:

```
warning: you are an administrator by BOOTSTRAP_ADMINS alone; the self-heal turns that into a real, revocable grant on the next authenticated request
```

Under `--json`:

```bash
prk whoami --json
```

```json
{
  "kind": "user",
  "subject": "you@example.com",
  "identity_id": "0198f3c2-7f0a-7a11-9d4c-2f9b1d5e8c30",
  "role": "admin",
  "bootstrap": false
}
```

## `prk doctor`

```
prk doctor
```

Check connectivity, credentials and configuration. Run it first whenever
something is not working.

```bash
prk doctor
```

```
ok   server url     https://prick.example.com (from the stored login)
ok   token storage  /home/you/.config/prick/credentials.json is owner-only
ok   api            /api/v1/health answered, version 2026.819.0
ok   access         Cloudflare Access with managed OAuth is in front of this server
ok   identity       you@example.com (user)
ok   installation   running as a native binary
```

**Every check runs**, and the exit code is decided at the end, so one report
tells you everything that is wrong at once.

| Check           | Reports                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `server url`    | The resolved URL, and whether it came from a flag/variable or the stored login           |
| `token storage` | Whether the token file exists and is owner-only. Never its contents                      |
| `api`           | Whether `/api/v1/health` answers on the API's own path                                   |
| `access`        | What is in front of the server: Access with managed OAuth, Access without it, or nothing |
| `identity`      | The subject and kind `/whoami` resolved                                                  |
| `credentials`   | Warns when no credential could be resolved                                               |
| `installation`  | Whether the binary is running through the npm shim rather than natively                  |

Each line is marked `ok`, `warn`, `FAIL` or `skip` — plain ASCII, so the report
survives being pasted into an issue tracker. Only `FAIL` sets a non-zero exit
code, which keeps `prk doctor` usable as a health check while still reporting
advisories like "you installed this through npm".

### Reading a failing report

```
ok   server url     https://prick.example.com (from the stored login)
FAIL token storage  /home/you/.config/prick/credentials.json is readable by more than its owner; delete it and run `prk login` again
ok   api            /api/v1/health is reachable and refuses an anonymous caller
FAIL access         this server answered an unauthenticated request
warn credentials    no credentials configured
ok   installation   running as a native binary
```

Three things to notice:

- A `401` on the `api` check is a **success**. It means something answered on
  the API's own path and Access refused an anonymous caller, which is the
  correct configuration.
- The `access` probe runs **before** any credential is sent, because it is the
  only thing that can tell an unprotected server from a protected one. An
  unprotected server is a `FAIL`, never a warning.
- `credentials` warning plus a missing `identity` line means the checks that
  need a credential could not run. Fix that first, then re-run.

### In a health check

```bash
prk doctor --json
```

```json
{
  "ok": true,
  "checks": [
    {
      "name": "server url",
      "status": "ok",
      "detail": "https://prick.example.com (from the stored login)"
    },
    {
      "name": "token storage",
      "status": "ok",
      "detail": "/home/you/.config/prick/credentials.json is owner-only"
    }
  ]
}
```

Under `--json` the command exits 0 even when a check failed — read the `ok`
field instead, which is what a monitoring script wants:

```bash
prk doctor --json | jq -e '.ok' > /dev/null || echo "prick is unhealthy"
```

## Next steps

- [Authentication guide](/guides/authentication) — service tokens, CI, and what the JWT verifier checks.
- [Exit codes and errors](/reference/cli/errors)
- [`prk access`](/reference/cli/access) — once you know your subject, grant it something.
