---
title: GitHub Actions
description: Authenticating a CI job with an Access service token and injecting secrets into a workflow step.
sidebar:
  order: 5
---

:::note[Authenticate first]
CI authenticates with an Access **service token**, not with `prk login`. Read
[Authentication](/guides/authentication#setting-up-a-service-token-for-ci) first.
:::

:::caution[Not implemented]
The CLI is not published and the commands below exit with `NOT_IMPLEMENTED`.
There is no `prick` GitHub Action; one is planned as a separate repository and
does not exist yet. Do not write a workflow that depends on either today.
:::

## Two secrets in GitHub, none in the workflow

The only thing your repository stores is the service token. Everything else lives
in prick.

1. Create a service token under **Zero Trust → Access → Service Auth**.
2. Add it to the Access policy for your prick hostname.
3. Store the pair as GitHub Actions secrets, e.g. `PRICK_CLIENT_ID` and
   `PRICK_CLIENT_SECRET`.

## The workflow

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

`PRK_ACCESS_CLIENT_ID` / `PRK_ACCESS_CLIENT_SECRET` are prick's names. If your
runner already sets `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` for
`cloudflared`, those are read as a fallback and the job works unchanged.

`--no-input` matters: it makes a missing or rejected credential fail immediately
instead of blocking on a prompt no CI job can answer.

## The first run will 403, and that is the flow

Access will let the token through the edge, and prick will refuse it, because
authentication is not authorization and a new service token has no grant.

That denial is recorded. The subject then appears in the "seen but not granted"
list, so an administrator can grant it without anyone copying an opaque
`e367826f93b8d71185e03fe518aff3b4.access` string between two consoles:

```bash
prk access identities --denied
```

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
```

Give CI the **narrowest** role that works. A deploy job that only reads secrets
is a `reader` on one environment, not a global admin.

## Masking

If you must put a value into the workflow environment rather than into a child
process, mask it so GitHub redacts it from logs:

```bash
echo "::add-mask::$SECRET_VALUE"
```

Prefer `prk run` — a value injected straight into the child never passes through
a step's stdout at all.

## Do not write the file into the workspace

```bash
prk secrets download --format env --output "$RUNNER_TEMP/.env"
```

Anything in the checkout directory risks being picked up by an upload-artifact
step or a build context. `$RUNNER_TEMP` is discarded with the runner.

## Next

- [Access control](/guides/access-control)
- [Threat model](/architecture/threat-model)
