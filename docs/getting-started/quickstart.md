---
title: Quickstart
description: Deploy the Worker to your own Cloudflare account, put Cloudflare Access in front of it, and sign in with the CLI.
sidebar:
  order: 2
---

This takes you from an empty Cloudflare account to a deployed,
Access-protected server you can sign in to. Allow about twenty minutes.

## Before you begin

You need:

- A Cloudflare account with Workers, D1 and Zero Trust (Cloudflare Access).
- A hostname you control on that account. Access attaches to a hostname, not to
  a Worker.
- [mise](https://mise.jdx.dev), which pins every tool this repository uses.

## 1. Clone and install

```bash
git clone https://github.com/yashau/prick && cd prick
```

```bash
mise trust
```

```bash
mise run bootstrap
```

`bootstrap` installs the pnpm workspace from the lockfile and the git hooks.
`wrangler` comes with it, and every command below runs it through pnpm so you
get the pinned version.

## 2. Create the D1 database

```bash
pnpm --dir packages/app exec wrangler d1 create prick
```

Copy the returned `database_id` into `packages/app/wrangler.jsonc`. The value
checked in is the placeholder `00000000-0000-0000-0000-000000000000`, and a
deploy against it will not work. The id is not a secret.

## 3. Point the Worker at your hostname

`wrangler.jsonc` sets `"workers_dev": false` and `"preview_urls": false`, and CI
asserts both. That means the Worker has nowhere to go until you give it a route,
so uncomment and edit the `routes` block:

```jsonc title="packages/app/wrangler.jsonc"
"routes": [
  { "pattern": "prick.example.com", "custom_domain": true }
],
```

:::danger[Leave workers.dev switched off]
Cloudflare Access attaches to a hostname. A `*.workers.dev` hostname, or a
per-version preview URL, that Access is not in front of serves this Worker with
no authentication at all — every project, every environment, every reveal
endpoint, open to the internet.

Those two settings are what make the whole authorization model's assumption
true.
:::

## 4. Generate and install the master key

```bash
openssl rand -base64 32
```

```bash
pnpm --dir packages/app exec wrangler secret put MASTER_KEY
```

`MASTER_KEY` must be base64 that decodes to **exactly 32 bytes**. It is
validated when the key ring is built, before any route runs, so a bad value
makes the Worker refuse every request — including `/health` — rather than
failing later on the first secret read.

:::danger[Back this up now, before you store anything]
There is no recovery path. A D1 export without `MASTER_KEY` is just ciphertext.
Read [Backup and recovery](/guides/backup-and-recovery) before you continue.
:::

## 5. Create the Access application

In the Cloudflare dashboard, under **Zero Trust → Access controls →
Applications**, add a self-hosted application for the hostname from step 3, and
attach an **Allow** policy for the people who should reach it. Policies are
reusable: create one under **Access controls → Policies**, or pick an existing
one from the application's policy list.

From the application's **Overview** tab, copy the **Application Audience (AUD)
tag** — you need it in the next step.

### Turn on managed OAuth

Still on the application: open **Additional settings → OAuth**, enable **Managed
OAuth**, leave **Allow loopback clients** on, and **Save**.

This is what gives `prk login` an authorization server to talk to. Access
authenticates a browser by redirecting it to a login page, which a CLI cannot
follow; managed OAuth is what makes it answer a credential-less API request with
a `401` and a pointer to discovery instead.

:::caution[Two things catch people here]
The toggle does nothing until the page is **saved**. Every other control on that
screen is a switch, so a switch with a separate Save button reads as already
applied — and until you press it, `prk login` still fails with "managed OAuth is
not enabled".

**Allow loopback clients** must stay on. `prk login` registers a client for
`http://127.0.0.1:<port>/callback` and the registration is refused without it.
:::

You can check it from a shell before installing anything:

```bash
curl -si https://prick.example.com/api/v1/health | head -1
```

A `401` means managed OAuth is on. A `302` to your Access login means it is not
— the browser flow works, but the CLI has nothing to use.

## 6. Fill in the vars

Edit the `vars` block in `packages/app/wrangler.jsonc`:

```jsonc title="packages/app/wrangler.jsonc"
"vars": {
  "ACCESS_TEAM": "your-team",
  "ACCESS_AUD": "<the AUD tag from step 5>",
  "BOOTSTRAP_ADMINS": "you@example.com",
  "REQUIRE_CTX_ACCESS": "false",
  "SECRET_MAX_BYTES": "65536",
  "ENV_MAX_SECRETS": "500",
  "BODY_MAX_BYTES": "1048576"
}
```

`ACCESS_TEAM` is the `<team>` in `https://<team>.cloudflareaccess.com`. It and
`ACCESS_AUD` are both asserted by the JWT verifier, and an empty `ACCESS_AUD` is
refused — a verifier that accepts tokens minted for a different Access
application is not a verifier.

`BOOTSTRAP_ADMINS` is how the first administrator comes to exist. Put your own
email there. See [Access control](/guides/access-control#the-first-administrator).

Every var is described in [Configuration](/reference/configuration).

## 7. Apply the database migrations

```bash
pnpm --dir packages/app exec wrangler d1 migrations apply prick --remote
```

Migrations are applied **before** the deploy, and they are additive only. That
ordering is what makes "old code, new schema" the only state that exists in the
window between the two steps.

## 8. Deploy

To deploy a named release rather than whatever is on `main`, check out its
`app-v` tag and stamp the version first, so `/health` reports it:

```bash
git checkout app-v2026.815.0
```

```bash
mise run app:set
```

Check the resolved configuration first if you want to be careful:

```bash
pnpm --dir packages/app exec wrangler deploy --dry-run
```

Then:

```bash
pnpm --dir packages/app exec wrangler deploy
```

## 9. Verify that Access is actually in front of it

**Do not skip this step.** It is the one that catches the failure this whole
design exists to prevent.

```bash
curl -i https://prick.example.com/api/v1/health
```

You want Access to intercept this. With managed OAuth on from step 5 that is a
`401` carrying a `WWW-Authenticate` header — which is also exactly what `prk
login` looks for. Without it, a redirect to your Access login or a `403`.

:::danger[A `200` here means your secrets manager is open to the internet]
If that command returns `200` with a JSON body, Access is **not** protecting
this hostname. Stop and fix the Access application before storing anything.
:::

When authenticated, the endpoint answers:

```json
{ "service": "prick", "status": "ok", "version": "0.0.0-dev" }
```

The version reads `0.0.0-dev` unless you deployed a stamped release — see
step 8.

## 10. Install the CLI

```bash
npm install -g @yashau/prick
```

The package ships a prebuilt binary for each platform and picks the right one.
[Install](/getting-started/install) covers the other routes — a release tarball,
or a local build with `mise run build:rust`.

## 11. Sign in

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com as profile `default`
Signed in to https://prick.example.com (profile default)
```

`prk login` probes `/api/v1/health`, discovers the authorization server,
registers a client for a loopback redirect, runs the PKCE handshake in your
browser, and stores the resulting token in a file only you can read. The whole
handshake — and the service-token path CI uses instead — is described in
[Authentication](/guides/authentication).

This first sign-in creates your first **profile**, named `default`: a local
name for this server and the session signed in to it. Later commands use it
without `--api-url`, and it pins the server's instance id, so a different
deployment answering at this hostname later is refused. To add a second
server, see [Multiple servers](/guides/multiple-servers).

Then confirm the server agrees about who you are:

```bash
prk whoami
```

```
you@example.com (user)
server: prick.example.com (profile default)
instance: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
role: admin (global)
```

If `BOOTSTRAP_ADMINS` names your address, that first authenticated request also
converts the implicit admin into a real, revocable grant.

## 12. Check everything at once

```bash
prk doctor
```

```
ok   server url     https://prick.example.com (from the default profile)
ok   profile        default (instance 3f9c01ab)
ok   token storage  /home/you/.config/prick/credentials.json (profile default) is owner-only
ok   api            /api/v1/health is reachable and refuses an anonymous caller
ok   access         Cloudflare Access with managed OAuth is in front of this server
ok   identity       you@example.com (user)
ok   instance       instance 3f9c01ab
ok   installation   running as a native binary
```

Eight `ok` lines means you are done. Any `FAIL` is explained in
[Exit codes and errors](/reference/cli/errors).

## Optional: manage service tokens from prick

CI authenticates with an Access service token. With two more settings and one
more policy, a global admin creates and manages those tokens with
`prk access token`, and never opens the Zero Trust dashboard for one again.

1. Create a Cloudflare **account** API token, under **Manage account → Account
   API tokens**, for the account that owns the Access application, with exactly
   one permission: **Account → Access: Service Tokens → Edit**. Leave out a
   client IP filter; a Worker's egress addresses are not fixed.
2. Install it, and put the account's 32-character hex id beside the other vars
   from step 6:

   ```bash
   pnpm --dir packages/app exec wrangler secret put CF_API_TOKEN
   ```

   ```jsonc title="packages/app/wrangler.jsonc"
   "CF_ACCOUNT_ID": "0123456789abcdef0123456789abcdef"
   ```

3. Under **Zero Trust → Access controls → Policies**, add a reusable policy with
   the action **Service Auth** and an include rule using **Any Access Service
   Token**, and attach it to the application from step 5, next to the people's
   Allow policy.
4. Deploy again, as in step 8.

`prk doctor`, run as a global admin, reports whether service tokens are
available and, if not, what the Worker is missing.
[Authentication](/guides/authentication#authenticate-a-machine) takes it from
there. [Configuration](/reference/configuration#service-token-management)
explains what the Worker holding that token means.

## Store your first secret

```bash
prk projects create "API service" --slug api
```

```
Created project `API service` (api).
```

```bash
prk env create Production --slug production --project api
```

```
Created environment `Production` (production).
```

```bash
prk secrets set DATABASE_URL --project api --env production
```

```
Value for DATABASE_URL:
```

```
Added `DATABASE_URL` (rev 1).
```

```bash
prk run --project api --env production -- printenv DATABASE_URL
```

## Next steps

- [Onboard a new service](/examples/onboard-a-service) — the full version of what you just started.
- [Authentication](/guides/authentication) — get CI authenticated too.
- [Access control](/guides/access-control) — convert `BOOTSTRAP_ADMINS` into real grants.
- [Backup and recovery](/guides/backup-and-recovery) — do this before you depend on it.
