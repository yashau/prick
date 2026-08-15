<div align="center">

<img src="assets/brand/lockup.svg" alt="prick" width="380">

### **P**ortable **R**untime **I**njection of **C**loudflare (stored) **K**eys

A self-hosted secrets manager that runs entirely on your own Cloudflare account.<br>
One Worker, one D1 database, and nothing else to operate.

[![CI](https://github.com/yashau/prick/actions/workflows/ci.yml/badge.svg)](https://github.com/yashau/prick/actions/workflows/ci.yml)
[![CodeQL](https://github.com/yashau/prick/actions/workflows/codeql.yml/badge.svg)](https://github.com/yashau/prick/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-C8F93A?labelColor=238112)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-8EDC20?labelColor=238112)](#status)

</div>

---

```bash
prk login https://secrets.example.com
prk secrets set DATABASE_URL --project api --env production   # prompts, masked
prk run --project api --env production -- ./deploy.sh         # injected, never written to disk
```

The name is the job description: keys live in your Cloudflare account, and `prk` injects them into a
process at runtime — portably, and without ever touching disk.

## What it is

|             |                                                                                                      |
| :---------- | :--------------------------------------------------------------------------------------------------- |
| **`prk`**   | A single static Rust binary. No Node, no `wrangler`, no runtime dependencies.                        |
| **Web UI**  | A SvelteKit admin console served from the same Worker.                                               |
| **Auth**    | Cloudflare Access — SSO for people, service tokens for CI. No credentials of our own invention.      |
| **Storage** | D1. Values are AES-256-GCM, and each ciphertext is cryptographically bound to the row that holds it. |

## How it works

```
  prk ─────┐                    ┌───────────────────────────────┐
           ├──▶ Cloudflare ────▶│  Worker                       │
  browser ─┘      Access        │  · verifies the signed JWT    │──▶  D1
                (SSO / tokens)  │  · resolves grants in D1      │   (encrypted)
                                │  · encrypts, decrypts, audits │
                                └───────────────────────────────┘
```

Everything sits behind one Access-protected hostname. Access authenticates at the edge before the
Worker runs; the Worker independently verifies the signed JWT to learn _who_ is calling, then
consults its own grant table to decide _what_ they may do.

## Design decisions worth knowing

<table>
<tr><td width="32%"><strong>Ciphertexts are bound to their row</strong></td>
<td>Additional authenticated data covers purpose, environment, key name and version. A ciphertext lifted from one row and pasted into another does not decrypt — it fails authentication.</td></tr>

<tr><td><strong>Writes are atomic</strong></td>
<td>A bulk write is a single D1 <code>batch()</code>, a real transaction. There is no window in which an environment is half-written.</td></tr>

<tr><td><strong>Nothing mutates unaudited</strong></td>
<td>The audit insert is the last statement <em>inside</em> that same transaction. If the audit write fails, the data write fails.</td></tr>

<tr><td><strong>Nothing is granted implicitly</strong></td>
<td>An authenticated identity holding no grant gets nothing — and <strong>404, not 403</strong>, from every resource-addressed route, so it cannot enumerate what exists.</td></tr>

<tr><td><strong>Failures are loud</strong></td>
<td>A row that will not decrypt is reported, never skipped. A silently shorter <code>.env</code> is how a deploy loses <code>DATABASE_URL</code> and nobody finds out until the outage.</td></tr>

<tr><td><strong>Secrets never reach the HTML</strong></td>
<td>The secrets screen is client-rendered on purpose: no server render means no serialised page payload. CI fails the build if a server load so much as calls a reveal function.</td></tr>
</table>

## Access control

Scope a grant at any level, combine them freely, hand them out through groups.

```
global                      admin     everything
project      acme           writer    every environment in acme
environment  acme/prod      reader    one environment
group        platform-team  admin     conferred to every member
```

Roles are `reader < writer < admin`. Effective role is the maximum over direct grants **and** the
grants of every group you belong to — purely additive, with no deny rules, because a deny that
silently overrides an explicit grant is the most confusing thing an authorization system can have.

`GET /identities/{id}/effective-permissions` answers _"why does Bob have production?"_ by naming the
grant or group that conferred it.

## Getting started

Deploy it to your own account. This repository never deploys it for you.

```bash
git clone https://github.com/yashau/prick && cd prick
mise trust && mise run bootstrap
openssl rand -base64 32 | pnpm --filter @prick/app exec wrangler secret put MASTER_KEY
pnpm --filter @prick/app exec wrangler d1 migrations apply prick --remote
pnpm --filter @prick/app exec wrangler deploy
```

Then put **Cloudflare Access** in front of the hostname before you put a secret in it. The Worker
ships with `workers_dev` and `preview_urls` disabled and CI asserts both on every push, because an
unprotected hostname serves the entire application without a JWT.

**[Quickstart](docs/getting-started/quickstart.md)** ·
**[Authentication](docs/guides/authentication.md)** ·
**[Access control](docs/guides/access-control.md)** ·
**[Threat model](docs/architecture/threat-model.md)**

## `MASTER_KEY` is the whole ballgame

Lose it and every stored secret is unrecoverable. A D1 export without it is just ciphertext — which
is a feature rather than a bug, and also the most common way people lose everything. Rotation is
supported and incremental, and the settings screen tells you when it is safe to drop the retired
key.

## Status

Pre-release. The architecture is settled and the test suite is real:

<div align="center">

| Rust | Worker + UI | E2E | Scripts | Action | MCP |
| ---: | ----------: | --: | ------: | -----: | --: |
|  546 |        1080 |  90 |     206 |    110 |  73 |

</div>

Nothing is published to npm yet, so `npm install -g @yashau/prick` does not work — build from source
until the first release is cut.

## Development

The only thing you install is [mise](https://mise.jdx.dev). It pins everything else.

```bash
mise run dev      # Worker + UI
mise run test     # every suite
mise run ci       # exact mirror of CI — run before opening a PR
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[AGENTS.md](AGENTS.md)**.

## License

[MIT](LICENSE)
