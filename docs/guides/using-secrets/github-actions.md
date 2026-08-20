---
title: GitHub Actions
description: Authenticating a CI job with an Access service token and injecting secrets into a workflow step.
sidebar:
  order: 5
---

:::note[Before you begin]
CI authenticates with an Access **service token**, not with `prk login`. Read
[Authentication](/guides/authentication#authenticate-a-machine) first.
:::

:::note[Both routes install from npm]
Both routes below install `@yashau/prick` at run time. The action lives in this
repository at `action/` with its own test suite (`mise run test:action`).
:::

## Two secrets in GitHub, none in the workflow

The only thing your repository stores is the service token. Everything else lives
in prick.

1. Create a service token under **Zero Trust → Access → Service auth → Service
   Tokens**. The client secret is shown once; the client id ends in `.access`.
2. Add it to the Access policy for your prick hostname — an **include** rule of
   type **Service Auth**, with the policy's action set to **Service Auth** rather
   than Allow. A policy listing only human identities rejects the token at the
   edge, before prick ever sees the request.
3. Store the pair as GitHub Actions secrets, e.g. `PRICK_CLIENT_ID` and
   `PRICK_CLIENT_SECRET`.

## The action

```yaml title=".github/workflows/deploy.yml"
- uses: yashau/prick/action@v2026.819.0
  with:
    url: ${{ secrets.PRICK_URL }}
    client-id: ${{ secrets.PRICK_CLIENT_ID }}
    client-secret: ${{ secrets.PRICK_CLIENT_SECRET }}
    project: api
    environment: production

- run: ./deploy.sh # DATABASE_URL, STRIPE_SECRET_KEY, … are all just there
```

| Input                | Required | Default              | Meaning                                                                              |
| -------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------ |
| `url`                | yes      | —                    | Base URL of the server. Must be `https`: the service token is a request header       |
| `client-id`          | yes      | —                    | Access service token client id, the one ending in `.access`                          |
| `client-secret`      | yes      | —                    | Access service token client secret                                                   |
| `project`            | yes      | —                    | Project to read. Matched exactly, case-sensitively                                   |
| `environment`        | no       | `production`         | Environment to read. Matched exactly, case-sensitively                               |
| `keys`               | no       | _(all)_              | Allowlist of secret names, newline- or comma-separated                               |
| `prefix`             | no       | _(none)_             | Prepended to every variable name, e.g. `APP_`                                        |
| `export-to`          | no       | `env`                | `env` appends to `$GITHUB_ENV`; `outputs` sets one JSON output. Prefer `env`         |
| `version`            | no       | _(the action's ref)_ | Version of `@yashau/prick` to install                                                |
| `mask`               | no       | `true`               | Register values with the log masker. **Setting this to `false` prints your secrets** |
| `allow-unsafe-names` | no       | `false`              | Permit `PATH`, `NODE_OPTIONS`, `LD_*`, `GITHUB_*` and friends                        |

Two outputs: `keys`, the newline-separated variable names that were injected after
any prefix — names only, so it is safe to print — and `secrets`, a JSON object set
only under `export-to: outputs`.

Naming `keys` is worth doing. A job that asks for two variables cannot leak the
other thirty, and a name that is **not** in the environment fails the step rather
than starting the job without it.

`allow-unsafe-names` defaults to `false` for the same reason `prk run` refuses
those names, only more so: a value written to `$GITHUB_ENV` applies to every later
step in the job, so a secret store that can set `PATH` controls the whole job.

It is a **composite** action rather than a bundled JavaScript one. A JavaScript
action has to commit its own `dist/` — a build artefact no reviewer reads and that
nothing can prove was built from the sources beside it. For the thing holding
access to every secret in an environment, that is exactly the wrong shape. The
`version` input defaults to the action's own ref when that ref is a release tag, so
the action and the CLI cannot drift.

## Or drive the CLI yourself

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

:::note[A different 403 looks the same from here]
The denial above is `FORBIDDEN`, and a grant fixes it. If the error is
`MITIGATED` instead, the request never reached prick at all: Cloudflare's bot
products challenge datacenter IPs, and GitHub-hosted runners are datacenter IPs.
No grant will fix that one — see
[Cloudflare protections](/guides/cloudflare-protections).
:::

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

## Next steps

- [Access control](/guides/access-control)
- [Threat model](/architecture/threat-model)
