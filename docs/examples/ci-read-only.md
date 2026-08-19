---
title: Give CI read-only access
description: Create an Access service token, let it introduce itself, and grant it exactly one environment.
sidebar:
  order: 4
---

A deploy job needs to read `api:production` and nothing else. This walks the
whole flow, including the `403` on the first run — which is not a mistake, it is
how the job introduces itself.

## Before you begin

- Global or project admin on the project you are granting.
- Access to your Cloudflare Zero Trust dashboard.

## 1. Create the service token

In the Cloudflare dashboard, go to **Zero Trust → Access → Service auth →
Service Tokens** and create one.

You get two values. The client id ends in `.access` and is not secret. The client
secret is **shown once** — copy it now.

```
Client ID:     e367826f93b8d71185e03fe518aff3b4.access
Client Secret: 3a4f…  (shown once)
```

## 2. Let the token through Access

The token still has to get past Cloudflare Access, and a policy that lists only
human identities rejects it at the edge — before prick sees the request at all.

On your prick application's policy, add an **include** rule of type **Service
Auth**, and set the policy's action to **Service Auth** rather than Allow.

## 3. Store the pair in your CI secret store

For GitHub Actions, add two repository secrets:

| Secret                | Value             |
| --------------------- | ----------------- |
| `PRICK_CLIENT_ID`     | The `.access` id  |
| `PRICK_CLIENT_SECRET` | The client secret |

## 4. Point the job at prick

```yaml title=".github/workflows/deploy.yml"
name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-24.04
    env:
      PRK_API_URL: https://prick.example.com
      PRK_PROJECT: api
      PRK_ENV: production
      PRK_ACCESS_CLIENT_ID: ${{ secrets.PRICK_CLIENT_ID }}
      PRK_ACCESS_CLIENT_SECRET: ${{ secrets.PRICK_CLIENT_SECRET }}
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false

      - run: npm install -g @yashau/prick

      - run: prk run --no-input -- ./deploy.sh
```

`--no-input` makes a missing or rejected credential fail immediately rather than
blocking on a prompt no CI job can answer.

## 5. Run it, and expect a 403

```
error: You do not have permission to perform this action.
  help: An administrator can grant access from the Access screen; your subject now appears under "Seen but not granted".
```

Access let the token through; prick refused it. Authentication is not
authorization, and a brand-new service token holds no grant.

That refusal is **recorded**, and it is the introduction.

## 6. Grant it, from the list it put itself on

```bash
prk access identities --denied
```

```
e367826f93b8d71185e03fe518aff3b4.access	service	1 attempt(s)
```

```
Grant one of these with `prk access grant <SUBJECT> --role reader --scope <PROJECT>:<ENVIRONMENT>`.
```

There is the subject, so nobody has to copy an opaque hex string between two
consoles.

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
```

```
Granted reader to `e367826f93b8d71185e03fe518aff3b4.access` on `api:production`.
```

:::tip[Give CI the narrowest role that works]
A deploy job that only reads secrets is a `reader` on one environment. It is not
a `writer`, and it is certainly not a global admin. The scope `api:production`
means a token that leaks cannot read `api:staging`, let alone `billing`.
:::

## 7. Name it, now, while you know what it is

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access "api deploy job"
```

```
Named `e367826f93b8d71185e03fe518aff3b4.access` `api deploy job`.
```

This is the step everyone skips and everyone regrets. An access list of hex
strings is unreadable, which is how a stale token survives three audits: nobody
could say what it was for, so nobody was willing to be the one who removed it.

## 8. Re-run the job

It works. Confirm what the token can actually reach:

```bash
prk access explain e367826f93b8d71185e03fe518aff3b4.access
```

```
e367826f93b8d71185e03fe518aff3b4.access	service
groups	none
api:production	reader	via a direct grant on `api:production`
  -> reader	a direct grant	on `api:production`
```

One scope, one role. That is the whole blast radius if the token leaks.

## Optional: expire it on a schedule

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production --expires-in 90
```

An expired grant is skipped during resolution, so it stops working without
anyone cleaning it up, and it stays in the table as a record that it existed.

## Optional: use the action instead of the CLI

```yaml title=".github/workflows/deploy.yml"
- uses: yashau/prick/action@v2026.819.0
  with:
    url: ${{ secrets.PRICK_URL }}
    client-id: ${{ secrets.PRICK_CLIENT_ID }}
    client-secret: ${{ secrets.PRICK_CLIENT_SECRET }}
    project: api
    environment: production
    keys: |
      DATABASE_URL
      STRIPE_SECRET_KEY

- run: ./deploy.sh
```

Naming `keys` is worth doing: a job that asks for two variables cannot leak the
other thirty, and a name that is missing fails the step rather than starting the
job without it.

## Troubleshooting

| What you see                                 | What it means                                                         |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Access login page HTML instead of a response | The policy has no Service Auth rule, so the token never reaches prick |
| `UNAUTHENTICATED`, exit 3                    | One half of the pair is missing, or they come from different prefixes |
| `FORBIDDEN`, exit 4                          | The token authenticated and holds no grant — do step 6                |
| `NOT_FOUND`, exit 5                          | Granted, but on a different project or environment than the job reads |

Check the whole chain from the job itself:

```bash
prk doctor --no-input
```

## Next steps

- [GitHub Actions](/guides/using-secrets/github-actions) — every input the action takes.
- [Respond to a leaked secret](/examples/rotate-a-leaked-key) — what to do when this token leaks.
- [Access control](/guides/access-control)
