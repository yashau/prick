---
title: Quickstart
description: Deploy the Worker to your own Cloudflare account, put Cloudflare Access in front of it, and sign in with the CLI.
sidebar:
  order: 2
---

This takes you from an empty Cloudflare account to a deployed, Access-protected
Worker.

:::caution[Where this stops]
Deployment works. Signing in and reading or writing secrets does not: `prk login`
and every secrets command are argument definitions only in this build, and the
Worker mounts no route other than `GET /api/v1/health`. Steps 1–9 are real.
Steps 10–11 describe the intended flow and are marked where they will fail
today.
:::

## What you need

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
`wrangler` comes with it — every command below runs it through pnpm rather than
from a global install, so it is the pinned version.

## 2. Create the D1 database

```bash
pnpm --dir packages/app exec wrangler d1 create prick
```

Copy the returned `database_id` into `packages/app/wrangler.jsonc`. The value
checked in is the placeholder `00000000-0000-0000-0000-000000000000`; a deploy
against it will not work. The id is not a secret.

## 3. Point the Worker at your hostname

`wrangler.jsonc` sets `"workers_dev": false` and `"preview_urls": false`, and CI
asserts both. That means the Worker has nowhere to go until you give it a route,
so uncomment and edit the `routes` block:

```jsonc title="packages/app/wrangler.jsonc"
"routes": [
  { "pattern": "prick.example.com", "custom_domain": true }
],
```

:::danger[Do not enable workers.dev]
Cloudflare Access attaches to a hostname. A `*.workers.dev` hostname, or a
per-version preview URL, that Access is not in front of serves this Worker with
no authentication at all — every project, every environment, every reveal
endpoint, open to the internet. Those two settings are what make the whole
authorization model's assumption true.
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
makes the Worker refuse every request including `/health` rather than failing
later on the first secret read.

:::danger[Back this up now, before you store anything]
There is no recovery path. A D1 export without `MASTER_KEY` is just ciphertext.
Read [Backup and recovery](/guides/backup-and-recovery) before you continue.
:::

## 5. Create the Access application

In the Cloudflare dashboard, under **Zero Trust → Access → Applications**, add a
self-hosted application for the hostname from step 3, and add a policy for the
people who should reach it.

From the application's **Overview** tab, copy the **Application Audience (AUD)
tag**.

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
`ACCESS_AUD` are both asserted by the JWT verifier; an empty `ACCESS_AUD` is
refused, because a verifier that accepts tokens minted for a different Access
application is not a verifier.

`BOOTSTRAP_ADMINS` is how the first administrator exists. See
[Access control](/guides/access-control).

Every var is described in [Configuration](/reference/configuration).

## 7. Apply the database migrations

```bash
pnpm --dir packages/app exec wrangler d1 migrations apply prick --remote
```

Migrations are applied **before** the deploy, and they are additive only. That
ordering is what makes "old code, new schema" the only state that exists in the
window between the two steps.

## 8. Deploy

```bash
pnpm --dir packages/app exec wrangler deploy
```

Check the resolved configuration first if you want to be careful:

```bash
pnpm --dir packages/app exec wrangler deploy --dry-run
```

## 9. Verify that Access is actually in front of it

```bash
curl -i https://prick.example.com/api/v1/health
```

You want to see Access intercept this — a redirect to your Access login, or a
`403`. If you get `200` with a JSON body, **Access is not protecting this
hostname**. Stop and fix that before storing anything. An unprotected secrets
manager is the failure this design exists to prevent.

When authenticated, that endpoint answers:

```json
{ "status": "ok", "version": "0.0.0-dev" }
```

The version reads `0.0.0-dev` in-tree; releases stamp the real value at build
time.

## 10. Install the CLI

```bash
npm install -g @yashau/prick
```

:::caution[Not published yet]
No release has been cut, so this package does not exist on npm today. Build the
binary locally instead with `mise run build:rust`; it lands at
`target/release/prk`.
:::

## 11. Sign in

```bash
prk login https://prick.example.com
```

:::caution[Not implemented]
`prk login` currently exits with `NOT_IMPLEMENTED`. The intended handshake —
probe, discover, register, PKCE, browser round trip, store — is described in
[Authentication](/guides/authentication), along with the service-token path for
CI.
:::

## Next

- [Authentication](/guides/authentication)
- [Access control](/guides/access-control) — convert `BOOTSTRAP_ADMINS` into real grants.
- [Backup and recovery](/guides/backup-and-recovery)
