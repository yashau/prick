---
title: Cloudflare Workers
description: Using prk run with wrangler dev, including the environment variable you must set for process.env to be forwarded.
sidebar:
  order: 4
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

Two entirely separate things share a word here. Keep them apart:

- **Your own Worker's** secrets in production are Cloudflare Worker secrets,
  installed with `wrangler secret put`. prick does not manage those.
- **Local development** of that Worker needs the same values on your machine, and
  that is what `prk run` is for.

## Local development

```bash
prk run --project api --env development -- wrangler dev
```

:::danger[You must also set CLOUDFLARE_INCLUDE_PROCESS_ENV]
By default, `wrangler dev` does **not** expose the parent process's environment
to your Worker. `prk run` will have set the variables perfectly and `env.MY_VAR`
will still be `undefined`.

Set this and they are forwarded:

```bash
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true
```

See Cloudflare's
[environment variables documentation](https://developers.cloudflare.com/workers/configuration/environment-variables/)
for what this flag does and where local values come from.
:::

Both together:

```bash
CLOUDFLARE_INCLUDE_PROCESS_ENV=true prk run --project api --env development -- wrangler dev
```

## The alternative: `.dev.vars`

Wrangler's own convention for local values is a `.dev.vars` file beside your
`wrangler.jsonc`, in `KEY=value` form. If you prefer that to the environment,
generate it:

```bash
prk secrets download --format env --output .dev.vars --project api --env development
```

Written with mode `0600`. Make sure `.dev.vars` is in `.gitignore` — it is
plaintext on disk, and it does not expire.

Prefer `prk run` where you can. Nothing is written, and there is no stale file to
forget about after a rotation.

## Deploying your Worker

`wrangler deploy` reads secrets from Cloudflare, not from the environment, so
`prk run` does not help at deploy time. To push a value from prick into a
Worker secret:

```bash
prk secrets get STRIPE_SECRET_KEY --project api --env production | wrangler secret put STRIPE_SECRET_KEY
```

That value now exists in two places and will drift on the next rotation. Decide
deliberately which system is authoritative.

## prick's own Worker

prick's Worker reads `MASTER_KEY` as an ordinary Worker secret, and it must not
be stored in prick. Bootstrapping a secrets manager out of itself does not work,
and `MASTER_KEY` is the key that everything else depends on. See
[Configuration](/reference/configuration) and
[Backup and recovery](/guides/backup-and-recovery).

## Next

- [GitHub Actions](/guides/using-secrets/github-actions)
- [Configuration](/reference/configuration)
