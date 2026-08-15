---
title: package.json scripts
description: Wrapping npm and pnpm scripts with prk run, including the Windows batch-shim detail.
sidebar:
  order: 3
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

:::caution[Not implemented]
`prk run` is an argument definition in this build. The patterns below are the
intended usage.
:::

## Wrap the command, not the script

The simplest arrangement leaves `package.json` alone:

```bash
prk run --project api --env production -- npm run start
```

Child processes inherit the environment, so everything `npm run start` spawns
sees the secrets too.

## Or put it in the script

```json title="package.json"
{
  "scripts": {
    "start": "node server.js",
    "start:prod": "prk run -P api -E production -- node server.js"
  }
}
```

Keep the plain script and add a wrapped one, rather than making every developer's
`npm start` depend on a network round trip and a valid session.

Note the uppercase shorts: `-P` for project, `-E` for environment. Lowercase
`-p`/`-e` are left free for the subcommands.

## Use the environment instead of flags

Repeating `-P` and `-E` in every script is noise. Set them once:

```bash
export PRK_PROJECT=api
```

```bash
export PRK_ENV=production
```

```json title="package.json"
{
  "scripts": {
    "start:prod": "prk run -- node server.js"
  }
}
```

## Windows

`npm`, `pnpm` and most `node_modules/.bin` entries are `.cmd` shims on Windows,
not executables. Since the fix for CVE-2024-24576, Rust's standard library
refuses to launch a `.bat` or `.cmd` directly, so a naive implementation of
`prk run -- npm test` simply fails there.

prick resolves the program itself — honouring `PATHEXT` — and, when the result is
a batch shim, builds a correctly quoted `cmd.exe /d /s /c` line for it. That is
the **only** place in the codebase where an argument is escaped rather than
passed as a vector, and it is unit-tested against adversarial arguments.

You do not have to do anything differently:

```bash
prk run --project api --env production -- npm test
```

## `PATH` and `NODE_OPTIONS` are refused

Both are on the loader-controlled list, so a secret with either name will not be
injected — `prk run` fails rather than setting it. If you need to extend `PATH`
for a child, do it in your shell, not through the secret store. See
[Using secrets](/guides/using-secrets/#names-that-are-refused).

## A note on the npm install

Installing the CLI with `npm install -g @yashau/prick` routes `prk` through a
small Node launcher, which adds roughly 30–40 ms per invocation and keeps a Node
parent alive for the child's lifetime during `prk run`. That is inherent to
npm's `bin` mechanism, not something prick can avoid.

For `prk run` in particular, prefer a direct binary: the platform packages
declare `bin` themselves, and GitHub Release tarballs will be published
alongside them.

:::caution[Not published yet]
No release has been cut, so neither the npm package nor the release tarballs
exist. Build locally with `mise run build:rust`.
:::

## Next

- [Cloudflare Workers](/guides/using-secrets/cloudflare-workers)
- [GitHub Actions](/guides/using-secrets/github-actions)
