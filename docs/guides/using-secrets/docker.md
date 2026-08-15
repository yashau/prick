---
title: Docker
description: Getting secrets into a container without baking them into an image or leaving a plaintext file behind.
sidebar:
  order: 2
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

:::caution[Not implemented]
`prk run` and `prk secrets download` are argument definitions in this build. The
patterns below are the intended usage.
:::

## The thing that trips everyone up

A container does **not** inherit the environment of the process that started
`docker`. So this does not do what it looks like:

```bash
prk run --project api --env production -- docker run myimage
```

The secrets land on the `docker` CLI process. Inside the container there is
nothing.

You have to name the variables you want forwarded, or pass a file.

## Forward named variables

`docker run -e NAME` with no `=` takes the value from the client's environment,
which is exactly what `prk run` has just populated:

```bash
prk run --project api --env production -- docker run -e DATABASE_URL -e STRIPE_SECRET_KEY myimage
```

Explicit, no file on disk, and the container gets only what you listed.

## Docker Compose

Compose interpolates `${VAR}` in the compose file from the environment it was
started with, and an `environment:` entry written with no value takes the value
from that environment too:

```yaml title="compose.yaml"
services:
  api:
    image: myimage
    environment:
      - DATABASE_URL
      - STRIPE_SECRET_KEY
```

```bash
prk run --project api --env production -- docker compose up
```

## When you need a file

Some workflows want `--env-file`. Write one, use it, remove it:

```bash
prk secrets download --format env --output .env --project api --env production
```

```bash
docker run --env-file .env myimage
```

```bash
rm -f .env
```

`--output` creates the file with mode `0600`, so it is not readable by other
users on the box. It is still a plaintext secret on a disk, so treat it as
temporary and keep it out of your build context — add `.env` to both
`.gitignore` and `.dockerignore`.

Note that Docker's `--env-file` parser is not the same parser prick uses. It does
not support quoted values with escapes. If a value contains a newline or a quote,
forward it with `-e` instead of through a file.

## Never put a secret in a build

```dockerfile
# Do not do this.
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
```

Build arguments and `ENV` instructions persist in the image's layer history, and
anyone who can pull the image can read them. Secrets belong at run time, not at
build time. If a build genuinely needs a credential — a private package registry
token, say — use BuildKit's `--mount=type=secret`, which does not persist into
the image.

## Next

- [package.json scripts](/guides/using-secrets/package-json)
- [Threat model](/architecture/threat-model)
