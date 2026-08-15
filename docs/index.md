---
title: prick
description: Documentation for prick, a self-hosted secrets manager that runs on one Cloudflare Worker and a D1 database.
sidebar:
  order: 0
  label: Overview
---

**P**ortable **R**untime **I**njection of **C**loudflare (stored) **K**eys.

prick is a self-hosted secrets manager. It runs entirely inside your own
Cloudflare account: one Worker, one D1 database, and nothing else to operate.

- **`prk`** — a single static Rust binary. No Node and no `wrangler` at runtime.
- **Web UI** — a SvelteKit admin app served from the same Worker.
- **Cloudflare Access** — SSO for people, service tokens for CI.

Secret **values** are encrypted with AES-256-GCM. Each ciphertext is bound to
its row with additional authenticated data, so a value lifted out of one row and
pasted into another fails to decrypt. Secret **key names** are stored in
plaintext, on purpose — see [Threat model](/architecture/threat-model).

## Project status

The architecture is settled, the security-critical layers are written, and the
API surface is mounted. Two things are still missing, and this documentation says
so at the point where it matters rather than describing intent as fact.

| Area                                                                      | State                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Crypto: envelope, AAD, key ring                                           | Implemented                                                                                  |
| Access JWT verification, claims, authorization, bootstrap                 | Implemented                                                                                  |
| Domain layer: projects, environments, secrets, identities, grants, groups | Implemented                                                                                  |
| Domain layer: audit query, including per-scope narrowing                  | Implemented                                                                                  |
| Domain layer: key ring status and the rekey job                           | Implemented. **No cron** — a rotation advances one page per call to `POST /admin/rekey`      |
| HTTP API                                                                  | Fully mounted. `docs/openapi.json` is generated from the router, and CI fails if it is stale |
| `prk` CLI                                                                 | Login, token storage, service tokens and every subcommand are wired                          |
| Web UI                                                                    | Every screen exists and reads the domain layer                                               |

No release has been cut, so `@yashau/prick` is not on npm yet — build the binary
locally with `mise run build:rust`.

## Start here

- [Introduction](/getting-started/introduction) — what prick is and how it fits together.
- [Quickstart](/getting-started/quickstart) — deploy the Worker, then sign in.

## Guides

- [Authentication](/guides/authentication) — **read this first.** Every other guide assumes it.
- [Projects and environments](/guides/projects-and-environments)
- [Secrets](/guides/secrets)
- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Cloudflare Workers, GitHub Actions.
- [Access control](/guides/access-control) — identities, grants, service tokens.
- [Backup and recovery](/guides/backup-and-recovery)
- [Key rotation](/guides/key-rotation)

## Reference

- [CLI](/reference/cli) — every command, flag and exit code.
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
