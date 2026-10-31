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
prk login [URL] [--profile <NAME>] [--storage <BACKEND>] [--no-browser]
```

Sign in to a prick server through your browser. Every session belongs to a
[profile](/reference/cli/profile): `prk login` renews an existing one or
creates a new one.

| Argument | Meaning                                                                         |
| -------- | ------------------------------------------------------------------------------- |
| `[URL]`  | Base URL of the server. Optional when a profile already says which server it is |

| Flag           | Values            | Default | Meaning                                                                     |
| -------------- | ----------------- | ------- | --------------------------------------------------------------------------- |
| `--profile`    | `<NAME>`          |         | The profile to renew or create. A global flag, also read from `PRK_PROFILE` |
| `--storage`    | `file`, `keyring` | `file`  | Where to keep the resulting token. `keyring` is not available in this build |
| `--no-browser` |                   | off     | Print the URL instead of opening one                                        |

### Sign in

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com as profile `default`
Signed in to https://prick.example.com (profile default)
```

Your browser opens, you complete the Cloudflare Access sign-in, and the token
lands on disk. The profile records **which server** it signed in to, so no
later command needs `--api-url` or `PRK_API_URL`.

### Which profile a sign-in is for

| You run                            | What it signs in                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `prk login`                        | The default profile, renewed                                                                                                  |
| `prk login <URL>`                  | The one profile for that URL, renewed. With none, a new profile: `default` if it is the first, otherwise named after the host |
| `prk login --profile <NAME>`       | That profile, renewed. It must exist                                                                                          |
| `prk login <URL> --profile <NAME>` | That profile, renewed when it is for `<URL>`; created when no profile has that name                                           |

A profile named after the host turns `https://prick.staging.example` into
`prick-staging-example`, with `-2`, `-3` and so on appended when that name is
taken or was left behind by a rename. A URL without `--profile` can come from
`--api-url` or `PRK_API_URL` too.

So signing in to a second server adds a second profile, and the first stays
signed in:

```bash
prk login https://prick.globex.example
```

```
Signing in to https://prick.globex.example as profile `prick-globex-example`
Signed in to https://prick.globex.example (profile prick-globex-example)
```

Choose the name yourself with `--profile`:

```bash
prk login https://prick.globex.example --profile globex
```

`prk login` refuses, before it opens a browser, when:

- `--profile` names a profile for a **different** URL. A profile's server
  never changes: `PROFILE_EDIT_REFUSED`, exit 2. Use another name, or
  [remove the profile](/reference/cli/profile#prk-profile-remove) first.
- `--profile` names a profile that a rename left behind, or is not a valid
  name: `PROFILE_EDIT_REFUSED`.
- `--profile` alone names no profile: `PROFILE_UNKNOWN`.
- the URL is shared by several profiles: `PROFILE_AMBIGUOUS`; add `--profile`.
- the URL is not `https://`, or `http://` to a loopback address:
  `INVALID_URL`.
- there is no URL and no default profile: `NO_SERVER`.

### What a sign-in is checked against

After the browser flow and **before the session is saved**, the new session is
checked against everything the profile has pinned:

- the Access issuer it first signed in through ([`ISSUER_MISMATCH`](/reference/cli/errors#issuer_mismatch-exit-3));
- the instance id the server reported before ([`INSTANCE_MISMATCH`](/reference/cli/errors#instance_mismatch-exit-3));
- `--expect-instance` or `PRK_EXPECT_INSTANCE`, when set.

A refusal revokes the fresh token and saves nothing, so a sign-in that reached
the wrong deployment leaves no live credential behind. A profile signing in
for the first time is pinned to the issuer and the instance this sign-in
reports. A server that reports no instance id signs in unpinned, with a
warning:

```
warning: this server reports no instance id, so the profile is not pinned to it
```

### Sign in on a machine your browser cannot reach

This is the remote-shell and container case: you open the URL on your own
machine, and the redirect goes to a `127.0.0.1` address that means something
different there than it does on the machine you ran `prk login` on.

You do not have to tell `prk` which situation you are in. Both routes are open
at once and the first one to produce the redirect completes the login.

```bash
prk login https://prick.example.com --no-browser
```

```
Signing in to https://prick.example.com as profile `default`
Open this URL to continue:
  https://example.cloudflareaccess.com/cdn-cgi/access/sso/oidc/…
If the browser cannot reach this machine, it will fail to load a 127.0.0.1 address.
That is expected. Paste that whole address here and press Enter:
```

Open the URL in a browser anywhere. Then either:

- **The browser reaches this machine** — over an SSH session forwarding the
  port, or under WSL, which shares loopback with Windows. The login finishes on
  its own and there is nothing to paste.
- **It does not** — the browser shows a connection error. That is the expected
  outcome, and the address bar now holds the authorization response. Copy the
  whole address and paste it at the prompt.

```
http://127.0.0.1:54321/callback?code=…&state=…
```

Paste the **whole** address, including everything after the `?`. The
authorization code on its own is refused: the `state` next to it is what proves
the redirect belongs to the login you just started, and a code without it cannot
be checked. Getting this wrong reports
[`REDIRECT_UNREADABLE`](/reference/cli/errors#redirect_unreadable-exit-11).

The paste prompt appears whenever there is a terminal to answer it. With
`--no-input`, or with stdin coming from somewhere other than a terminal, only
the loopback route is used — so a scripted login behaves exactly as it did.

`--json` reports which route completed it, alongside the profile and the
instance it pinned:

```bash
prk login https://prick.example.com --json
```

```json
{
  "api_url": "https://prick.example.com",
  "profile": "default",
  "instance": "3f9c01ab3f9c01ab3f9c01ab3f9c01ab",
  "issuer": "https://example.cloudflareaccess.com",
  "storage": "file",
  "expires_at": 1793450400,
  "redirect": "pasted"
}
```

`instance` is `null` when the server reports none.

`--no-browser` only controls whether a browser is launched here; it is applied
automatically when there is no display to launch one on.

#### Why it is not detected for you

Whether a browser can reach this machine's loopback is not knowable before it
tries. An `ssh -L` tunnel is built entirely on the client side, so a forwarded
port and an unforwarded one are the same `bind` and the same `accept` from
inside `prk` — there is no environment variable or probe that separates them.
The signals that look promising are wrong in both directions: `SSH_CONNECTION`
is unset inside `tmux` and stripped by `sudo`, and WSL looks remote while its
loopback is shared with the browser's. Racing the two routes is correct in every
one of those cases without asking.

### Where the token is stored

| Backend   | Default | Notes                                                                                                                                                                                                  |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`    | Yes     | A file at mode `0600` in a directory at mode `0700`                                                                                                                                                    |
| `keyring` | No      | The OS keyring. Accepted by `--storage` but not available in this build: `prk login` refuses with `STORAGE_UNAVAILABLE` (exit 8) before it opens a browser, rather than quietly writing a file instead |

The file is written atomically — temporary file, then rename — and the mode is
set at creation, so there is never a window in which a token file exists
world-readable. On Windows the DACL is replaced with a single entry for the
current user.

Everything lives in one configuration directory:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/prick`, or `~/.config/prick` |
| macOS    | `~/Library/Application Support/prick`          |
| Windows  | `%LOCALAPPDATA%\prick`                         |

And holds three kinds of file:

| File                    | Holds                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `config.toml`           | The profiles: each one's name, server, credential file and pins. Never a token                               |
| `credentials.json`      | The session of the first profile on the machine — `default`, on a machine that signed in before profiles     |
| `credentials/<id>.json` | Every other profile's session, one file each, named by a random 16-hex-digit id rather than the profile name |

Every session file is the same format and gets the same protection: mode
`0600` in a directory at mode `0700` on Unix, a single-user DACL on Windows.
`config.toml` is written owner-only and atomically too, under a lock file
(`config.toml.lock`) so two `prk` processes changing it at once both persist.
Its format is described under
[Configuration](/reference/configuration#configtoml).

`config.toml` appears the first time there is something to record — a second
profile, a rename, a new default, or the first instance id a server reports.
Until then, a machine with one sign-in has `credentials.json` alone, and `prk`
reads it as the profile `default`.

#### Updating keeps your sign-in

Updating `prk` needs no step and writes nothing. An existing
`credentials.json` becomes the profile `default` and stays where it is, in its
existing format, so a `prk` from before profiles installed on the same machine
keeps reading it, and downgrading works. That older `prk` ignores
`config.toml` and `credentials/`.

If that older `prk` signs in to a different server, it overwrites
`credentials.json` with that server's session. A session records the URL it
was issued for, so it is never sent anywhere else: the next run moves it to
the profile for its URL that has no session of its own, or to a new profile,
and says so:

```
moved the session for prick.globex.example that an older prk wrote into credentials.json to profile `prick-globex-example`; profile `default` is signed out (`prk login --profile default`)
```

A profile that already has a session is never overwritten.

#### The roaming profile on Windows

The directory is the local half of the Windows profile, because a session is
bound to the machine that signed in, and the roaming half is copied to a file
server at sign-out wherever roaming profiles or folder redirection are in
force — outside the DACL above, and into every backup of that share. A
session found in `%APPDATA%\prick` is moved to the local directory the first
time `prk` reads it, and the roaming copy is deleted. `prk logout` removes
both, and `prk doctor` warns about a roaming copy that survived.

#### Moving the directory

Set `PRK_CONFIG_DIR` to use another directory outright, profiles and sessions
together. It suits a CI job that wants a scratch directory with no profiles in
it:

```bash
PRK_CONFIG_DIR="$RUNNER_TEMP/prick" prk run --api-url https://prick.example.com -P api -E production -- ./deploy.sh
```

Several servers on one machine need no separate directories; they are
[profiles](/reference/cli/profile).

:::caution[The keyring backend stays opt-in]
`--storage keyring` is accepted, and this build refuses it rather than falling
back to a file. The file is the default because it works everywhere: over SSH
there is no session keyring to unlock, and on macOS the Keychain ACL binds to
the binary's code signature, so every update would re-prompt, which is
unusable from inside `prk run`.
:::

### The warning you must not ignore

`prk login` probes `/api/v1/health` before it sends anything. If that answers
`200` to an unauthenticated caller, it warns loudly — even under `--json`, which
suppresses every other diagnostic:

```
warning: this server answered an unauthenticated request, so it is NOT protected by Cloudflare Access: anyone who can reach this hostname can read every secret it holds
warning: Put the application behind Cloudflare Access before storing anything in it.
```

That means Cloudflare Access is not in front of the hostname, and your secrets
manager is open to the internet. Stop and fix the Access application before you
store anything. See [Quickstart step 9](/getting-started/quickstart).

## `prk logout`

```
prk logout [--all] [--no-revoke]
```

Revoke the session and discard stored credentials.

| Flag          | Default | Meaning                                                 |
| ------------- | ------- | ------------------------------------------------------- |
| `--all`       | off     | Sign out of every profile, not only the selected one    |
| `--no-revoke` | off     | Discard the local credential without telling the server |

`prk logout` signs out of the profile the command selects — the same
selection every command makes, so `--profile`, `PRK_PROFILE` and a project
file apply — and leaves every other profile signed in:

```bash
prk logout --profile globex
```

```
Signed out of globex.
```

The profile itself stays, with its server and pins, and
`prk login --profile globex` signs it in again. To delete a profile, use
[`prk profile remove`](/reference/cli/profile#prk-profile-remove).

`--all` signs out of every profile, and clears `credentials.json` too when no
profile uses it:

```bash
prk logout --all
```

```
Signed out of acme, globex.
```

Addressed by `--api-url` with no profile for that URL, `prk logout` clears
`credentials.json` only when the session in it is for that URL, and prints
`Signed out.`. Signing out of one server never discards another's session.

If there was nothing to discard, it says so and still exits 0:

```
No stored credentials.
```

Running it twice is harmless — it establishes the state "no credentials", and
that is idempotent.

### Deleting the file is not signing out

A refresh token stays valid at the authorization server until it expires on its
own or someone revokes it. Removing the local copy makes it unreachable from
_this machine_ and does nothing about the copy the server will still honour — so
`prk logout` hands the token back first, then deletes the file.

The refresh token is the one revoked, when there is one. RFC 7009 says a server
should invalidate the access tokens issued from a refresh token it revokes, and
the refresh token is the half worth ending: an access token expires on its own
within minutes, while a refresh token is what keeps a stolen credential alive.

### The local credential goes either way

Revocation needs the network. Deleting the file does not. If a failed request
could fail the command, a laptop with no connectivity could not be signed out at
all — and that is a worse outcome than signing out locally and telling the server
later, because the local credential is the part this machine controls.

So the credential is discarded whatever the server said, and a revocation that
did not happen is a warning naming what is still live rather than a silent
omission:

```
Signed out.
warning: The credential is gone from this machine, but the server was not told. It keeps working until it expires -- revoke the session in Zero Trust > Access if that matters.
```

The same warning, with its own wording, covers an authorization server that
advertises no revocation endpoint at all — there is nothing to ask, and the token
lives out its lifetime.

`--no-revoke` skips the request deliberately, for a machine with no route to the
authorization server where it would only stall. It trades a live credential for
not waiting.

Under `--json`, `revoked` distinguishes the three outcomes — `true` revoked,
`false` attempted and not done, `null` not attempted:

```bash
prk logout --json
```

```json
{ "logged_out": true, "profiles": ["acme"], "revoked": true }
```

`profiles` names every profile that was signed out. With `--all`, `revoked`
reports the worst outcome across them.

The warnings are printed even under `--json`, which otherwise leaves stderr
byte-empty on success. A credential that still works somewhere is worth breaking
that rule for, the same way an unprotected server is.

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
server: prick.example.com (profile default)
instance: 3f9c01ab3f9c01ab3f9c01ab3f9c01ab
role: admin (global)
```

The `server` line names the host and the profile that answered, or
`no profile` for a URL no profile is for. The `instance` line is the id the
server reports, or `not reported`. Together they are the answer to "which
deployment am I talking to?", on any machine, whatever the profile is called
locally.

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
  "bootstrap": false,
  "server": "prick.example.com",
  "profile": "default",
  "instance": "3f9c01ab3f9c01ab3f9c01ab3f9c01ab"
}
```

`profile` and `instance` are `null` when there is no profile, or no reported
instance.

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
ok   server url     https://prick.acme.example (from the default profile)
ok   profile        acme (instance 3f9c01ab)
ok   token storage  /home/you/.config/prick/credentials.json (profile acme) is owner-only
ok   token storage  /home/you/.config/prick/credentials/637b1b2d310b2b96.json (profile globex) is owner-only
ok   api            /api/v1/health answered, version 2026.819.0
ok   access         Cloudflare Access with managed OAuth is in front of this server
ok   identity       you@example.com (user)
ok   instance       instance 3f9c01ab
ok   installation   running as a native binary
```

**Every check runs**, and the exit code is decided at the end, so one report
tells you everything that is wrong at once.

| Check           | Reports                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `server url`    | The resolved URL, and what selected it: the command line, the environment, a project file's path, or the default profile    |
| `profile`       | The profile in use and its instance, or `instance unverified`. `skip` when no profile is for the server                     |
| `token storage` | One line per credential file that exists, naming its profile: whether it is owner-only. Never its contents                  |
| `roaming token` | Windows only, and only when present: a token file left in `%APPDATA%\prick`                                                 |
| `api`           | Whether `/api/v1/health` answers on the API's own path                                                                      |
| `access`        | What is in front of the server: Access with managed OAuth, Access without it, or nothing                                    |
| `identity`      | The subject and kind `/whoami` resolved                                                                                     |
| `instance`      | The instance the server reports. `warn` when it reports none; `FAIL` when it is not the deployment the profile is pinned to |
| `credentials`   | Warns when no credential could be resolved                                                                                  |
| `installation`  | Whether the binary is running through the npm shim rather than natively                                                     |

`token storage` checks every profile's file, not only the selected one's, and
`credentials.json` as well when no profile uses it. With no credential file
at all, it is a single `skip`.

An `instance` failure is the most important line a report can carry: the
server at this URL is a different deployment than the one the profile, the
project's `.prick.toml` or `--expect-instance` requires, and no command sends
it anything.

```
FAIL instance       prick.acme.example is a different deployment than profile `acme` is pinned to (expected instance 3f9c01ab3f9c01ab3f9c01ab3f9c01ab, it reports 7d2e44c07d2e44c07d2e44c07d2e44c0); nothing was sent
```

Each line is marked `ok`, `warn`, `FAIL` or `skip` — plain ASCII, so the report
survives being pasted into an issue tracker. Only `FAIL` sets a non-zero exit
code, which keeps `prk doctor` usable as a health check while still reporting
advisories like "you installed this through npm".

### Reading a failing report

```
ok   server url     https://prick.example.com (from the default profile)
ok   profile        default (instance unverified)
FAIL token storage  /home/you/.config/prick/credentials.json (profile default) is readable by more than its owner; delete it and run `prk login` again
ok   api            /api/v1/health answered, version 0.0.0-dev
FAIL access         this server answered an unauthenticated request, so it is NOT protected by Cloudflare Access: anyone who can reach this hostname can read every secret it holds
warn credentials    no credentials were found for https://prick.example.com
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
      "detail": "https://prick.example.com (from the default profile)"
    },
    {
      "name": "profile",
      "status": "ok",
      "detail": "default (instance 3f9c01ab)"
    },
    {
      "name": "token storage",
      "status": "ok",
      "detail": "/home/you/.config/prick/credentials.json (profile default) is owner-only"
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

- [`prk profile`](/reference/cli/profile) — list, rename and pin the profiles `prk login` creates.
- [Working with several servers](/guides/multiple-servers/)
- [Authentication guide](/guides/authentication) — service tokens, CI, and what the JWT verifier checks.
- [Exit codes and errors](/reference/cli/errors)
- [`prk access`](/reference/cli/access) — once you know your subject, grant it something.
