---
title: Give CI read-only access
description: Create an Access service token, let it introduce itself, and grant it exactly one environment.
sidebar:
  order: 4
---

A deploy job needs to read `api:production` and nothing else. This walks the
whole flow, including the `404` on the first run — which is not a mistake, it is
how the job introduces itself.

## Before you begin

- Global or project admin on the project you are granting.
- Access to your Cloudflare Zero Trust dashboard.

## 1. Create the service token

In the Cloudflare dashboard, go to **Zero Trust → Access controls → Service
credentials → Service Tokens** and create one.

You get two values. The client id ends in `.access` and is not secret. The client
secret starts with `cfast_` and is **shown once** — copy it now.

```
Client ID:     e367826f93b8d71185e03fe518aff3b4.access
Client Secret: cfast_…  (shown once)
```

## 2. Let the token through Access

The token still has to get past Cloudflare Access, and the Allow policy that
admits your people does not admit it: a service token is authorised only by a
policy whose action is **Service Auth**.

1. Under **Zero Trust → Access controls → Policies**, add a policy with the
   action **Service Auth** and an **include** rule using the **Service Token**
   selector, set to the token you just created.
2. Open your prick application under **Access controls → Applications** and
   add that policy next to the existing Allow policy.

The application now carries two policies, and each admits one kind of caller.
Access evaluates Service Auth policies first, so the token is matched before
the people's policy is consulted. Leave the people's policy on **Allow**: a
Service Auth policy never shows a login page, so changing its action locks
every person out of `prk login`.

:::tip[One policy for every token]
The **Any Access Service Token** selector admits every service token in the
account, so a new token needs no policy edit. Access is then not the boundary
between tokens — prick's grants are, and a new token still holds none until
step 6.
:::

If you run more than one prick deployment, create a separate token for each.
Either scope each deployment's policy to its own token, so the edge keeps them
apart, or admit any service token and let prick's grants keep them apart: the
token is granted on this deployment only, and any other answers it with `404`.

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
      PRK_EXPECT_INSTANCE: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
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

`PRK_EXPECT_INSTANCE` pins the job to one deployment: if `PRK_API_URL` ever
answers with a different one — a repointed hostname, a database rebuilt from
scratch — the job stops before it sends its own first request, rather than
deploying with another deployment's secrets. Copy the id from the `instance:`
line of `prk whoami`, signed in to this server. It is not a secret.

The runner has no profiles, and the job does not need any: the server is named
by URL and the credential is the service token.

## 5. Run it, and expect a 404

```
error: No such project. (NOT_FOUND)
  help: It may not exist, or it may not be visible to you. Ask an administrator for a grant if you expected to see it.
```

Access let the token through; prick refused it. Authentication is not
authorization, and a brand-new service token holds no grant. A project you hold
no grant on is reported as absent rather than forbidden, so that the status code
cannot be used to discover which project names exist.

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
  env:
    PRK_EXPECT_INSTANCE: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
  with:
    url: https://prick.example.com
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

| What you see                                                   | What it means                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| An error naming Access's login page, or a non-JSON `401`/`403` | No Service Auth policy on the application admits this token, so the request never reaches prick — redo step 2            |
| `UNAUTHENTICATED`, exit 3                                      | One half of the pair is missing, or they come from different prefixes                                                    |
| `NOT_FOUND`, exit 5                                            | The token holds no grant on this project — do step 6. Also what a grant on a different project or environment looks like |
| `FORBIDDEN`, exit 4                                            | The token can see the environment, but its role is too low for the operation                                             |
| `INSTANCE_MISMATCH`, exit 3                                    | `PRK_API_URL` answered as a different deployment than `PRK_EXPECT_INSTANCE` names. Find out why before changing either   |

Which form the first row takes depends on **strict service token
authentication**, a setting of your Zero Trust organization. With it on, Access
answers a token it does not authorise with a `401` or `403` and never redirects
to the login page; it is always on for organizations created on or after
2026-10-05, and older organizations can turn it on. With it off, Access
redirects to its login page, and prk reports that redirect by name.

Check the whole chain from the job itself:

```bash
prk doctor --no-input
```

## Next steps

- [GitHub Actions](/guides/using-secrets/github-actions) — every input the action takes.
- [Respond to a leaked secret](/examples/rotate-a-leaked-key) — what to do when this token leaks.
- [Access control](/guides/access-control)
