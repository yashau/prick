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

The architecture is settled and the security-critical layers are written. Large
parts of the product are not implemented yet, and this documentation says so at
the point where it matters rather than describing intent as fact.

| Area                                                          | State                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Crypto: envelope, AAD, keyring                                | Implemented                                                          |
| Access JWT verification, claims, authorization, bootstrap     | Implemented                                                          |
| Projects and environments (domain layer)                      | Implemented                                                          |
| Secrets, identities/grants, audit query, rekey (domain layer) | Not implemented                                                      |
| HTTP API                                                      | Only `GET /api/v1/health` is mounted                                 |
| CLI                                                           | Interface complete; only `prk version` and `prk completions` do work |
| Web UI                                                        | Route skeleton only                                                  |

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
