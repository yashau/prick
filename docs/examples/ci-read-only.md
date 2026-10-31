---
title: Give CI read-only access
description: Create an Access service token that holds exactly one environment, and hand it to a GitHub Actions job without the secret touching a terminal.
sidebar:
  order: 4
---

A deploy job needs to read `api:production` and nothing else. This creates the
token, grants it, and stores it in GitHub in one command, then points the job at
prick.

## Before you begin

- **Global** admin on the server. Creating a service token takes global admin;
  a project admin can grant an existing token, which is
  [the dashboard route](#without-cf_api_token-the-dashboard-route) below.
- The server set up for service tokens: the Worker holds `CF_API_TOKEN` and
  `CF_ACCOUNT_ID`, and the Access application carries a Service Auth policy for
  **Any Access Service Token**. Both are one-time steps, in
  [Authentication](/guides/authentication#once-per-deployment-set-up-service-tokens).
- The [GitHub CLI](https://cli.github.com), signed in to the repository.

## 1. Create the token, and store it in GitHub

```bash
prk access token create "api deploy job" --role reader --scope api:production --secret-file - | gh secret set PRK_ACCESS_CLIENT_SECRET
```

That one command:

- asks Cloudflare, through the Worker, for a new service token;
- records the identity it will authenticate as, named `api deploy job`, and
  grants it `reader` on `api:production`, in the same transaction;
- writes the client secret alone to stdout, straight into a GitHub secret. It
  never appears on your terminal, and prick keeps no copy of it.

The client id is printed outside the pipe. It ends in `.access` and is not
secret; store it beside the secret:

```bash
gh secret set PRK_ACCESS_CLIENT_ID --body e367826f93b8d71185e03fe518aff3b4.access
```

:::tip[Give CI the narrowest role that works]
A deploy job that only reads secrets is a `reader` on one environment. It is not
a `writer`, and it is certainly not a global admin. The scope `api:production`
means a token that leaks cannot read `api:staging`, let alone `billing`.
:::

## 2. Point the job at prick

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
      PRK_ACCESS_CLIENT_ID: ${{ secrets.PRK_ACCESS_CLIENT_ID }}
      PRK_ACCESS_CLIENT_SECRET: ${{ secrets.PRK_ACCESS_CLIENT_SECRET }}
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

## 3. Run it

It works on the first run: the token was granted before it ever made a request.
Confirm what it can reach:

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

Two clocks, set independently at create time:

```bash
prk access token create "api deploy job" --role reader --scope api:production --expires-in 90 --duration 2160h --secret-file - | gh secret set PRK_ACCESS_CLIENT_SECRET
```

`--expires-in 90` ends the **grant** after 90 days. An expired grant is skipped
during resolution, so it stops working without anyone cleaning it up, and it
stays in the table as a record that it existed. `--duration 2160h` ends the
**token** itself in Cloudflare after 90 days; the default is a year.
`prk access token refresh` extends it by its duration.

## Optional: rotate the secret without an outage

```bash
prk access token rotate "api deploy job" --grace 24h --secret-file - | gh secret set PRK_ACCESS_CLIENT_SECRET
```

The client id stays, so the grant does, and the job only needs the new secret.
The old secret keeps working for 24 hours, long enough for any run already in
flight. A leaked secret takes the immediate cut instead — see
[Respond to a leaked secret](/examples/rotate-a-leaked-key#a-leaked-credential).

## Optional: use the action instead of the CLI

```yaml title=".github/workflows/deploy.yml"
- uses: yashau/prick/action@v2026.819.0
  env:
    PRK_EXPECT_INSTANCE: 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
  with:
    url: https://prick.example.com
    client-id: ${{ secrets.PRK_ACCESS_CLIENT_ID }}
    client-secret: ${{ secrets.PRK_ACCESS_CLIENT_SECRET }}
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

## Without `CF_API_TOKEN`: the dashboard route

A server without `CF_API_TOKEN` answers `prk access token create` with
`SERVICE_TOKENS_UNCONFIGURED`, and `prk` says so before sending anything. The
token then comes from the dashboard, and introduces itself with a refused first
request.

1. In the Cloudflare dashboard, go to **Zero Trust → Access controls → Service
   credentials → Service Tokens** and create one. The client id ends in
   `.access`; the client secret starts with `cfast_` and is **shown once**.
2. Let it through Access. The **Any Access Service Token** policy admits it
   already. Without one, add a reusable policy under **Access controls →
   Policies** with the action **Service Auth** and an **include** rule using the
   **Service Token** selector, set to this token, and attach it to your prick
   application next to the people's Allow policy. Leave the people's policy on
   **Allow**: a Service Auth policy never shows a login page.
3. Store the pair as the `PRK_ACCESS_CLIENT_ID` and `PRK_ACCESS_CLIENT_SECRET`
   repository secrets, and run the job from step 2. It fails:

   ```
   error: No such project. (NOT_FOUND)
     help: It may not exist, or it may not be visible to you. Ask an administrator for a grant if you expected to see it.
   ```

   Access let the token through; prick refused it, because a brand-new token
   holds no grant. A project you hold no grant on is reported as absent rather
   than forbidden, so the status code cannot be used to discover which project
   names exist. That refusal is **recorded**.

4. Grant it from the list it put itself on. This step needs only admin on
   `api`:

   ```bash
   prk access identities --denied
   ```

   ```
   e367826f93b8d71185e03fe518aff3b4.access	service	1 attempt(s)
   ```

   ```bash
   prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
   ```

5. Name it now, while you know what it is. An access list of hex strings is
   how a stale token survives three audits:

   ```bash
   prk access rename e367826f93b8d71185e03fe518aff3b4.access "api deploy job"
   ```

Once the server has `CF_API_TOKEN`, `prk access token adopt
e367826f93b8d71185e03fe518aff3b4.access` brings this token under management, so
it rotates and revokes from `prk` like one it created.

## Troubleshooting

| What you see                                                   | What it means                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| An error naming Access's login page, or a non-JSON `401`/`403` | No Service Auth policy on the application admits this token, so the request never reaches prick                                               |
| `UNAUTHENTICATED`, exit 3                                      | One half of the pair is missing, or they come from different prefixes                                                                         |
| `NOT_FOUND`, exit 5                                            | The token holds no grant on this project. Also what a grant on a different project or environment looks like                                  |
| `FORBIDDEN`, exit 4                                            | The token can see the environment, but its role is too low for the operation                                                                  |
| `INSTANCE_MISMATCH`, exit 3                                    | `PRK_API_URL` answered as a different deployment than `PRK_EXPECT_INSTANCE` names. Find out why before changing either                        |
| `SERVICE_TOKENS_UNCONFIGURED` from `prk access token`          | The Worker has no usable `CF_API_TOKEN`; the hint names what is missing. Use [the dashboard route](#without-cf_api_token-the-dashboard-route) |

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
