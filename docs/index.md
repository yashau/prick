---
title: prick
description: Documentation for prick, a self-hosted secrets manager that runs on one Cloudflare Worker and a D1 database.
sidebar:
  order: 0
  label: Overview
---

prick is a self-hosted secrets manager that runs inside your own Cloudflare
account: one Worker, one D1 database, and nothing else to operate.

Store a secret once, and hand it to whatever needs it:

```bash
prk secrets set DATABASE_URL --project api --env production
```

```bash
prk run --project api --env production -- npm start
```

The value goes straight into the process's environment block. No `.env` file,
nothing written to disk.

## What you get

- **`prk`** — a single static Rust binary. No Node and no `wrangler` at runtime.
- **A web UI** — a SvelteKit admin app served from the same Worker.
- **Cloudflare Access** — SSO for people, service tokens for CI.
- **Versioned secrets** — every write keeps history, and every read is audited.

Secret **values** are encrypted with AES-256-GCM, and each ciphertext is bound
to its row, so a value lifted out of one row and pasted into another fails to
decrypt. Secret **key names** are stored in plaintext on purpose — see the
[Threat model](/architecture/threat-model).

The name: **P**ortable **R**untime **I**njection of **C**loudflare (stored)
**K**eys.

## Start here

| If you want to…                      | Go to                                          |
| ------------------------------------ | ---------------------------------------------- |
| Understand what this is              | [Introduction](/getting-started/introduction)  |
| Deploy it to your Cloudflare account | [Quickstart](/getting-started/quickstart)      |
| Install the CLI                      | [Install](/getting-started/install)            |
| See a complete job done end to end   | [Examples](/examples/)                         |
| Look up a command                    | [CLI reference](/reference/cli/)               |
| Work out why something failed        | [Exit codes and errors](/reference/cli/errors) |

## Guides

- [Authentication](/guides/authentication) — **read this first.** Every other guide assumes it.
- [Projects and environments](/guides/projects-and-environments)
- [Secrets](/guides/secrets)
- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Cloudflare Workers, GitHub Actions.
- [Access control](/guides/access-control) — identities, grants, service tokens.
- [Backup and recovery](/guides/backup-and-recovery)
- [Key rotation](/guides/key-rotation)

## Examples

- [Onboard a new service](/examples/onboard-a-service)
- [Migrate from a `.env` file](/examples/migrate-from-dotenv)
- [Give CI read-only access](/examples/ci-read-only)
- [Respond to a leaked secret](/examples/rotate-a-leaked-key)
- [Script prk with `--json`](/examples/scripting-with-json)

## Reference

- [CLI](/reference/cli/) — every command, flag and exit code.
- [API](/reference/api) — HTTP endpoints and the error envelope.
- [Configuration](/reference/configuration) — environment variables, `wrangler.jsonc`, `.dev.vars`.

## Architecture

- [Overview](/architecture/overview)
- [Encryption](/architecture/encryption)
- [Authorization](/architecture/authorization)
- [Threat model](/architecture/threat-model)

## Contributing

- [Development](/contributing/development)
- [Testing](/contributing/testing)
- [Releasing](/contributing/releasing)

## Project status

The architecture is settled, the security-critical layers are written, and the
API surface is mounted. Two things are worth knowing before you adopt it, and
this documentation says so at the point where it matters rather than describing
intent as fact.

| Area                                                                      | State                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Crypto: envelope, AAD, key ring                                           | Implemented                                                                             |
| Access JWT verification, claims, authorization, bootstrap                 | Implemented                                                                             |
| Domain layer: projects, environments, secrets, identities, grants, groups | Implemented                                                                             |
| Domain layer: audit query, including per-scope narrowing                  | Implemented                                                                             |
| Domain layer: key ring status and the rekey job                           | Implemented. **No cron** — a rotation advances one page per call to `POST /admin/rekey` |
| HTTP API                                                                  | Fully mounted, and `docs/openapi.json` is generated from the router                     |
| `prk` CLI                                                                 | Login, token storage, service tokens and every subcommand are wired                     |
| Web UI                                                                    | Every screen exists and reads the domain layer                                          |

No release has been cut, so `@yashau/prick` is not on npm yet. Build the binary
locally with `mise run build:rust` — see [Install](/getting-started/install).
