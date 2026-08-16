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

In the Cloudflare dashboard, under **Zero Trust → Access → Applications**, add a
self-hosted application for the hostname from step 3, and add a policy for the
people who should reach it.

From the application's **Overview** tab, copy the **Application Audience (AUD)
tag** — you need it in the next step.

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

You want Access to intercept this — a redirect to your Access login, or a `403`.

:::danger[A `200` here means your secrets manager is open to the internet]
If that command returns `200` with a JSON body, Access is **not** protecting
this hostname. Stop and fix the Access application before storing anything.
:::

When authenticated, the endpoint answers:

```json
{ "service": "prick", "status": "ok", "version": "0.0.0-dev" }
```

The version reads `0.0.0-dev` for an in-tree build; releases stamp the real
value at build time.

## 10. Install the CLI

```bash
npm install -g @yashau/prick
```

:::caution[Not published yet]
No release has been cut, so this package does not exist on npm today. Build the
binary locally instead:

```bash
mise run build:rust
```

It lands at `target/release/prk`. See [Install](/getting-started/install) for
the full set of routes.
:::

## 11. Sign in

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com
Signed in to https://prick.example.com
```

`prk login` probes `/api/v1/health`, discovers the authorization server,
registers a client for a loopback redirect, runs the PKCE handshake in your
browser, and stores the resulting token in a file only you can read. The whole
handshake — and the service-token path CI uses instead — is described in
[Authentication](/guides/authentication).

Then confirm the server agrees about who you are:

```bash
prk whoami
```

```
you@example.com (user)
role: admin (global)
```

If `BOOTSTRAP_ADMINS` names your address, that first authenticated request also
converts the implicit admin into a real, revocable grant.

## 12. Check everything at once

```bash
prk doctor
```

```
ok   server url     https://prick.example.com (from the stored login)
ok   token storage  /home/you/.config/prick/credentials.json is owner-only
ok   api            /api/v1/health answered, version 0.0.0-dev
ok   access         Cloudflare Access with managed OAuth is in front of this server
ok   identity       you@example.com (user)
ok   installation   running as a native binary
```

Six `ok` lines means you are done. Any `FAIL` is explained in
[Exit codes and errors](/reference/cli/errors).

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
