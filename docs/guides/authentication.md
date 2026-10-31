---
title: Authentication
description: Sign a person in with prk login, authenticate a machine with an Access service token, and understand what the Worker verifies.
sidebar:
  order: 1
---

Read this before any other guide. Every prick command talks to a Worker behind
Cloudflare Access, so nothing works until the machine running the command can
present an Access credential.

There are two kinds of credential:

| Credential           | Who uses it                 | How you get it                                                             |
| -------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Access SSO session   | People                      | `prk login <url>`, browser round trip                                      |
| Access service token | CI, cron, anything headless | Created in the Cloudflare dashboard, supplied as two environment variables |

Identity comes entirely from a verified Access JWT: whichever of the two the
caller presents, the Worker reads the subject off the signed token rather than
from anything it stores.

:::note[Before you begin]
The Worker has to exist first. If you have not deployed it and attached an
Access application to its hostname, start with the
[Quickstart](/getting-started/quickstart).
:::

## Sign in as a person

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com as profile `default`
Signed in to https://prick.example.com (profile default)
```

Your browser opens, you complete the Access sign-in, and the token lands on
disk. The sign-in creates a **profile**: a local name, `default` for the first
one, bound to this server and the session signed in under it. Later commands
use it, so they need neither `--api-url` nor `PRK_API_URL`. The profile also
pins the deployment's instance id and the Access issuer it signed in through;
see [Pointing at a server](#pointing-at-a-server).

Confirm the server agrees about who you are:

```bash
prk whoami
```

```
you@example.com (user)
server: prick.example.com (profile default)
instance: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
role: admin (global)
```

**This is the command to run when you get a `403`.** The subject it prints is
what an administrator needs in order to grant you anything. The role line is
your **global** role, and only that — a project-scoped admin prints no role here
and is still an admin of that project.

### What the handshake does

1. **Probe `/api/v1/health`.** Three outcomes, all handled:
   - `401` with a `WWW-Authenticate` header pointing at discovery — normal,
     continue.
   - `401` without it — managed OAuth is not enabled on the Access application.
     The error names the dashboard path that enables it.
   - `200` with a JSON body to an unauthenticated caller — **a loud warning**,
     because Access is not in front of this hostname.
2. Discover the authorization server via RFC 8414 / RFC 9728 metadata, and with
   it the RFC 8707 `resource` indicator naming what the token is for. Access
   refuses an authorization request that omits it, and the refusal arrives at
   the loopback callback as `invalid_target` rather than in the browser.
3. Register a client dynamically for `http://127.0.0.1:<ephemeral>/callback`.
   The port is whatever the OS assigns, so two concurrent logins do not collide,
   and the address is the literal `127.0.0.1` because the redirect URI must
   match byte for byte.
4. PKCE with S256.
5. Open the browser, accept exactly one request on the loopback listener, and
   compare `state` in constant time.
6. Exchange the code.
7. Check the new session against the profile's pins: the Access issuer, and
   the instance id the server reports to the new token. A session that fails
   either check is revoked and never saved.
8. Store the tokens in the profile's credential file.

Refresh is transparent: a token within a minute of expiring is renewed before
the request goes out, and the renewal is written back — so a short Access
session is invisible and the next invocation does not repeat the work.

### On a machine with no browser

```bash
prk login https://prick.example.com --no-browser
```

`prk` prints the authorization URL instead of opening one. The loopback listener
still receives the redirect, provided the port is reachable — which it is over a
forwarding SSH session.

### Where the token is stored

| Backend   | Default | Notes                                                                                                                     |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `file`    | Yes     | A file at mode `0600` in a directory at mode `0700`. Works over SSH, in containers and in CI                              |
| `keyring` | No      | The OS keyring. Not available in this build: `--storage keyring` refuses with `STORAGE_UNAVAILABLE` before sign-in starts |

The file is written **atomically** — to a temporary file, then renamed — and
created at mode `0600` on Unix, so there is never a window in which a token file
exists world-readable. On Windows the DACL is replaced with a single entry for
the current user.

The keyring backend is not available yet. When it lands it stays opt-in, because over SSH there is no session keyring to talk to,
and on macOS the Keychain ACL binds to the binary's code signature, so every
update re-prompts — which is unusable from inside `prk run`.

Each profile has its own credential file, so renewing or signing out of one
never touches another. Paths, and the `PRK_CONFIG_DIR` override, are in
[Install](/getting-started/install#where-prk-keeps-its-files).

### Signing out

```bash
prk logout
```

```
Signed out of default.
```

This revokes the selected profile's session at the authorization server and
then deletes its credential file. The profile itself stays, ready for the next
`prk login`; `prk logout --all` signs out of every profile, and
`prk profile remove` deletes one. Both halves matter: a refresh token stays valid until it expires or
is revoked, so deleting the file alone would leave a working credential behind
on a machine you thought you had signed out of.

The file is deleted whether or not the revocation succeeded, and a revocation
that did not happen is warned about rather than passed over silently. See
[`prk logout`](/reference/cli/sign-in#prk-logout) for the failure cases and for
`--no-revoke`.

## Authenticate a machine

CI uses an Access **service token**, not `prk login`.

### 1. Create the token

In the Cloudflare dashboard, go to **Zero Trust → Access controls → Service
credentials → Service Tokens** and create a service token. The client secret
starts with `cfast_` and is shown once; the client id ends in `.access`.

### 2. Let it through Access

A service token is authorised only by an Access policy whose action is
**Service Auth**. The Allow policy that admits your people rejects it at the
edge, before prick ever sees the request, so the token needs a policy of its
own:

1. Under **Zero Trust → Access controls → Policies**, add a reusable policy with
   the action **Service Auth** and an **include** rule using the **Service
   Token** selector, set to this token. The **Any Access Service Token**
   selector admits every service token in the account instead, which leaves
   prick's grants as the only boundary between them.
2. Attach it to your prick application, alongside the people's Allow policy.

Access evaluates Service Auth policies before Allow policies, so the two sit
side by side without interfering. Keep the people's policy on **Allow**: a
Service Auth policy admits no one through a login page, and `prk login` stops
working the moment the people's policy carries that action.

:::note[Strict service token authentication]
With this Zero Trust organization setting on, a request carrying service token
headers is authorised only by a Service Auth policy, and a refusal is a `401` or
`403` rather than a redirect to the login page. It is always on for
organizations created on or after 2026-10-05; older organizations can turn it
on. prk sends both headers on every request and reports either form of refusal.
:::

### 3. Give it to the job

```bash
export PRK_ACCESS_CLIENT_ID="<client id>.access"
```

```bash
export PRK_ACCESS_CLIENT_SECRET="<client secret>"
```

| Variable                   | Fallback                  | Purpose                     |
| -------------------------- | ------------------------- | --------------------------- |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | Service token client id     |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Service token client secret |

They are sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` request
headers. The `CF_*` fallbacks mean a pipeline already configured for
`cloudflared access` works with no changes.

:::caution[Both halves must come from the same place]
A `PRK_ACCESS_CLIENT_ID` paired with a `CF_ACCESS_CLIENT_SECRET` is not a
credential. Mixing them is how a job authenticates as an identity nobody
intended, so it is refused.
:::

### 4. Run the job, and expect a `404`

Access lets it in; prick refuses it, because authentication is not authorization
and the token has no grant yet. A project the token cannot see is reported as
absent (`NOT_FOUND`, exit 5) rather than forbidden. That denial is **recorded**, which is how the
token introduces itself:

```bash
prk access identities --denied
```

```
e367826f93b8d71185e03fe518aff3b4.access	service	1 attempt(s)
```

### 5. Grant it

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
```

A service token's identity is its `common_name`, and nobody maps that string to
"the staging deploy job" from memory — which is why step 4 exists, and why you
should name it straight away:

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access "staging deploy job"
```

The full walkthrough, including the GitHub Actions workflow, is
[Give CI read-only access](/examples/ci-read-only).

### Rotating the secret

Cloudflare's **Rotate** on a service token issues a new client secret and keeps
the client id. The client id is the identity prick grants to, so every grant
survives a rotation. Through the API, `previous_client_secret_expires_at` keeps
the old secret valid until the time you give, which lets you update the job
before the old secret stops working; without it, the old secret stops working at
once. A leaked secret takes the immediate cut — see
[Respond to a leaked secret](/examples/rotate-a-leaked-key#a-leaked-credential).

### Keeping the secret out of `ps`

```bash
prk secrets list --access-client-id "<id>.access" --access-client-secret-file /run/token
```

`--access-client-secret` exists for pipelines that have nothing else, but a
value passed there appears in `ps` output for every user on the machine and in
your shell history. `--access-client-secret-file` reads the secret from a file —
or from stdin when the path is `-` — and strips one trailing newline, so a file
written by `echo` works.

A file is treated as an explicit act: it takes precedence over both the flag and
`PRK_ACCESS_CLIENT_SECRET`, and it **refuses to fall back** to the `CF_*` pair
for the client id. Authenticating as somebody other than the identity whose
secret was just read off disk is the failure mode that rule designs out.

## Pointing at a server

Every command talks to exactly one server, and on a workstation that server is
a **profile**. `prk login <url>` creates one; with one profile, every command
uses it and you never name it.

```bash
prk profile list
```

```
* default  prick.example.com  instance 3f9c01ab  signed in
```

A second `prk login <other-url>` creates a second profile rather than
replacing the first, and from then on you choose between them. A command picks
its server from, highest first:

| Tier        | Profile form                            | URL form        |
| ----------- | --------------------------------------- | --------------- |
| Flag        | `--profile NAME`                        | `--api-url URL` |
| Environment | `PRK_PROFILE`                           | `PRK_API_URL`   |
| Project     | `.prick.local.toml`, then `.prick.toml` | —               |
| Default     | the default profile                     | —               |

Both forms at one tier are refused rather than guessed between. With two or
more profiles, a command that changes data must name its server; the default
alone is refused. [Multiple servers](/guides/multiple-servers) covers all of
it, including project files and renaming.

CI has no profiles and needs none. It names the server by URL and
authenticates with a service token:

| Variable      | Equivalent flag   | Meaning                   |
| ------------- | ----------------- | ------------------------- |
| `PRK_API_URL` | `--api-url`       | Base URL of the Worker    |
| `PRK_PROJECT` | `-P`, `--project` | Project to operate on     |
| `PRK_ENV`     | `-E`, `--env`     | Environment to operate on |

```bash
export PRK_API_URL=https://prick.example.com
```

An explicit flag wins over the environment variable of the same name. The
project and environment shorts are **uppercase**: `-P` and `-E`. See
[Global flags](/reference/cli/#global-flags).

For CI, add `--no-input` so a missing credential fails immediately rather than
waiting on a prompt nobody can answer:

```bash
prk secrets download --no-input --format env --output .env
```

## What keeps servers apart

These hold for every profile, on every command:

- **One credential per profile.** Each profile's session lives in its own
  file, and an invocation loads exactly one: the selected profile's. Nothing
  searches other profiles for a session that might work.
- **A credential is never sent to another URL.** A session records the server
  it was issued for, and is used only for that URL. A profile's server never
  changes; changing it means removing the profile, which discards its
  credential. Renewal and revocation go to the session's own authorization
  server and write back only to its own file.
- **The server proves which deployment it is before the command's own first
  request.** When a profile, `--expect-instance` or a project file applies,
  `prk` first asks the server for its instance id, on a request that carries no
  secret, and refuses a server that is not the deployment the profile is
  pinned to. A profile is pinned the first time it talks to its server, on the
  same trust you gave the URL when you signed in to it.
- **The Access issuer is pinned.** A later sign-in to the same URL through a
  different Access organisation is refused, and nothing is saved.

A bare `--api-url` or `PRK_API_URL` with no profile for that URL, no
expectation and no project file sends no extra request. That is the CI shape.

### Service tokens and several deployments

With one profile, or none, a service token is sent to whichever server was
selected. With two or more profiles, a service token from the environment is
paired only with a server chosen by `--profile`, `--api-url`, `PRK_PROFILE` or
`PRK_API_URL`; a project file or the default alone is refused, so a cloned
repository or a stale default cannot steer the token anywhere.

Use **one service token per deployment**, and pin it on the profile:

```bash
prk profile set acme --service-token-client-id e367826f93b8d71185e03fe518aff3b4.access
```

`prk` then refuses any other client id for that profile before sending a
request. On the Cloudflare side, either setup keeps deployments apart:

- **One Service Auth policy admitting any Access service token.** prick's
  grants do the separating: a token is granted only on the deployment that
  granted it, and any other deployment answers it with `404`.
- **Each token with an Access policy scoped to it.** The edge does the
  separating: a token reaches only the application whose policy names it.

## What the verifier checks

Every request carries an Access JWT, in the `Cf-Access-Jwt-Assertion` header or
the `CF_Authorization` cookie as a fallback. The Worker verifies it itself
rather than trusting that Access ran:

- The signing algorithm comes from the **JWKS entry matched by `kid`**, never
  from the token header. This is what rejects `alg: none` and RS256→HS256
  confusion.
- `iss` must equal `https://<ACCESS_TEAM>.cloudflareaccess.com` exactly.
- `aud` is a list: an **array** on tokens issued to people, a single **string** on tokens issued
  to service tokens. Either way the check is exact membership, `.includes(ACCESS_AUD)`.
- `exp` is required and is checked with no skew allowance.
- `nbf` is checked **only if present**. Service tokens do not carry one, and a
  verifier that requires it rejects every machine client.
- `iat` is checked only if present, with a 30-second skew allowance.

Claims then resolve to an identity:

| Claims                                    | Identity                                    |
| ----------------------------------------- | ------------------------------------------- |
| `sub` non-empty **and** `email` present   | `user`, subject is the lower-cased email    |
| `common_name` present **and** `sub` empty | `service`, subject is the `common_name`     |
| Both `email` and `common_name`            | Rejected — Access does not issue that shape |
| Neither                                   | Rejected — nothing to key a grant on        |

## When something goes wrong

Run this first — it checks the whole chain at once:

```bash
prk doctor
```

| Symptom                                                             | Cause                                                     | Fix                                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `UNAUTHENTICATED`, exit 3                                           | No credential, or an expired one                          | `prk login <url>`, or set the service-token variables                                                        |
| `INSTANCE_MISMATCH`, exit 3                                         | The server is not the deployment the profile is pinned to | Find out why before anything else; see [Multiple servers](/guides/multiple-servers#instance_mismatch-exit-3) |
| `PROFILE_REQUIRED`, exit 2                                          | A write with several profiles named no server             | Pass `--profile`                                                                                             |
| `FORBIDDEN`, exit 4                                                 | Authenticated, but no grant covers this scope             | Ask an admin for a grant; `prk whoami` shows the subject to grant                                            |
| A service token gets Access's login page, or a non-JSON `401`/`403` | No Service Auth policy admits the token                   | Step 2 of [Authenticate a machine](#authenticate-a-machine)                                                  |
| `NOT_A_PRICK_SERVER`, exit 7                                        | The URL answered but is not this Worker                   | Point `--api-url` at the Worker's hostname, not at a proxy                                                   |
| `SERVICE_UNAVAILABLE` with `NO_ADMINS_CONFIGURED`                   | Nobody can administer this install                        | Set `BOOTSTRAP_ADMINS` and redeploy                                                                          |
| Login warns that `/health` returned 200 unauthenticated             | Access is not attached to the hostname                    | Fix the Access application before storing anything                                                           |

Every code, and what to do about it, is in
[Exit codes and errors](/reference/cli/errors).

## Next steps

- [Multiple servers](/guides/multiple-servers) — profiles, project files and the instance pin.
- [Access control](/guides/access-control) — grants, roles and scopes.
- [Give CI read-only access](/examples/ci-read-only)
- [Configuration](/reference/configuration) — the server side.
