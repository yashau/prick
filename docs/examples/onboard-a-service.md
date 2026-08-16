---
title: Onboard a new service
description: From an empty server to a running application — project, environments, secrets, and prk run.
sidebar:
  order: 2
---

You have a new service called `api`. By the end of this page it has a project,
a staging and a production environment, its secrets loaded, and it starts with
`prk run`.

## Before you begin

- A deployed prick server, and `prk login` done.
- Admin at the scope you are creating in. `prk whoami` should print a role, or
  an administrator needs to grant you one.

## 1. Create the project

```bash
prk projects create "API service" --slug api
```

```
Created project `API service` (api).
```

The **slug** is what everything else addresses. Pass it explicitly when the
display name would not derive the one you want — here `"API service"` would have
become `api-service`.

## 2. Create the environments

```bash
prk env create Production --slug production --project api
```

```
Created environment `Production` (production).
```

```bash
prk env create Staging --slug staging --project api
```

```
Created environment `Staging` (staging).
```

Check what you have:

```bash
prk env list --project api
```

```
production	Production	rev 0	0 secret(s)
staging	Staging	rev 0	0 secret(s)
```

## 3. Stop typing the flags

```bash
export PRK_PROJECT=api
export PRK_ENV=staging
```

Every command below now runs against `api:staging` until you change it. Put
these in a `direnv` file per repository if you switch between services often.

## 4. Add secrets

```bash
prk secrets set DATABASE_URL
```

```
Value for DATABASE_URL:
```

Paste the value at the prompt — it is masked, and it reads the terminal directly
so nothing lands in your shell history.

```
Added `DATABASE_URL` (rev 1).
```

Add a description while you are there, so the next person knows what they are
looking at:

```bash
prk secrets set STRIPE_SECRET_KEY --description "Test mode, rotates quarterly"
```

```
Added `STRIPE_SECRET_KEY` (rev 2).
```

Descriptions are stored in plaintext beside the key name, so never put a value
in one.

### From a script or a password manager

```bash
op read "op://vault/stripe/test-key" | prk secrets set STRIPE_SECRET_KEY --stdin
```

Anything that writes to stdout works — `--stdin` takes the value from the pipe.

## 5. Check your work

```bash
prk secrets list
```

```
DATABASE_URL	v1	you@example.com
STRIPE_SECRET_KEY	v1	you@example.com
```

Values never appear in a listing. To read one back:

```bash
prk secrets get DATABASE_URL
```

```
postgres://app:hunter2@db.staging.example.com:5432/app
```

That read is audited, as every reveal is.

## 6. Run the application

```bash
prk run -- npm start
```

The secrets land in the process's environment block and nowhere else — no
temporary file, nothing on disk. `prk` then becomes your program, so its exit
code and signal handling are its own.

Confirm what was injected without printing any values:

```bash
prk run -vv -- node -e 'console.log("started")'
```

```
injecting 2 secrets into the child environment
variables: DATABASE_URL, STRIPE_SECRET_KEY
started
```

## 7. Copy the shape to production

Staging is set up and working. Export its keys as a template:

```bash
prk secrets download --format env --output template.env
```

```
Wrote 2 secrets to template.env.
```

Edit `template.env` so it holds the **production** values, then load it:

```bash
prk secrets upload template.env --dry-run --env production
```

```
2 added, 0 changed, 0 removed (dry run; nothing was written).
```

The dry run says exactly what would happen. When it reads right:

```bash
prk secrets upload template.env --env production
```

```
2 added, 0 changed, 0 removed.
```

Then delete the file — it holds production secrets in plaintext:

```bash
rm template.env
```

:::caution[`upload` replaces by default]
Keys the file does not name are **deleted**, because "upload this environment"
means the environment ends up matching the file. Pass `--merge` when you only
mean to add.
:::

## 8. Let your team in

Find out who has authenticated:

```bash
prk access identities
```

```
you@example.com	user
alice@example.com	user
```

Give Alice write access to staging, and read-only on production:

```bash
prk access grant alice@example.com --role writer --scope api:staging
```

```
Granted writer to `alice@example.com` on `api:staging`.
```

```bash
prk access grant alice@example.com --role reader --scope api:production
```

```
Granted reader to `alice@example.com` on `api:production`.
```

Confirm it reads the way you meant:

```bash
prk access explain alice@example.com
```

```
alice@example.com	user
groups	none
api:staging	writer	via a direct grant on `api:staging`
  -> writer	a direct grant	on `api:staging`
api:production	reader	via a direct grant on `api:production`
  -> reader	a direct grant	on `api:production`
```

:::note[Someone has to authenticate before you can grant to them]
The server learns a subject exists the first time it authenticates. If Alice has
never signed in, have her run `prk login` once — she will get an empty world
rather than an error — and then grant.
:::

## What you have now

- A project `api` with `staging` and `production`.
- Secrets in both, versioned, with every read and write audited.
- An application that starts with `prk run` and never sees a `.env` file.
- One teammate with exactly the access she needs.

## Next steps

- [Give CI read-only access](/examples/ci-read-only) — the same thing for a deploy job.
- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Workers, GitHub Actions.
- [`prk secrets`](/reference/cli/secrets) — every flag on the commands above.
