# prick

**P**ortable **R**untime **I**njection of **C**loudflare (stored) **K**eys.

A self-hosted secrets manager that runs entirely on your own Cloudflare account — one Worker, one D1
database, and nothing else to operate.

The name is the job description: keys live in your Cloudflare account, and `prk` injects them into a
process at runtime — portably, and without ever touching disk.

- **`prk`** — a single static Rust binary. No Node, no `wrangler`, no runtime dependencies.
- **Web UI** — a SvelteKit admin app served from the same Worker.
- **Cloudflare Access** — SSO for people, service tokens for CI. No passwords, no bearer tokens of
  our own invention.

```bash
npm install -g @yashau/prick     # once a release is cut; until then: mise run build:rust

prk login https://secrets.example.com
prk secrets set DATABASE_URL --project api --env production   # prompts, masked
prk run --project api --env production -- ./deploy.sh
```

## How it works

```
prk / browser  ──▶  Cloudflare Access  ──▶  Worker  ──▶  D1
                    (SSO / service          (Hono +      (values encrypted,
                     tokens, at the edge)    SvelteKit)   AES-256-GCM + AAD)
```

Everything sits behind one Access-protected hostname. Access authenticates at the edge before the
Worker runs; the Worker independently verifies the signed JWT to learn _who_ is calling, then
consults its own grant table to decide _what_ they may do.

Secret **values** are encrypted with AES-256-GCM under a key derived from your `MASTER_KEY` via
HKDF-SHA256. Each ciphertext is bound to its row with additional authenticated data — environment,
key name and version — so a ciphertext lifted from one row and pasted into another simply fails to
decrypt.

## Design notes

A few decisions worth knowing before you adopt it:

- **The CLI never talks to the Cloudflare API.** It is a pure HTTP client against your Worker. That
  is why it needs no credentials beyond your Access session, and why it ships as one binary.
- **Deployment is `wrangler deploy`.** Provisioning is a once-per-install job, so it belongs to
  Cloudflare's own tooling rather than to a bespoke `init` command.
- **Writes are atomic.** A bulk write is a single D1 `batch()` — a transaction. There is no window in
  which an environment is half-written.
- **Nothing mutates without an audit row**, because the audit insert is the last statement _inside_
  the same transaction. If the audit write fails, the data write fails.
- **`MASTER_KEY` is the whole ballgame.** Lose it and the data is unrecoverable; a D1 export without
  it is just ciphertext. Rotation is designed to be incremental, with the UI computing when it is
  safe to drop the retired key — but the job that does the re-encryption is **not implemented yet**,
  so a rotation cannot currently be finished.

## Status

Not production ready, but no longer a skeleton. The crypto, the Access
verification and the authorization layer are implemented and tested; the domain
layer — projects, environments, secrets, identities, grants, groups and the audit
query — is written, and the whole HTTP API is mounted on top of it. `prk` logs in,
stores its token, sends service-token headers and runs every subcommand.

Two things are still missing, and the documentation says so where it matters:

- **The rekey job.** `GET /api/v1/admin/keyring` and `POST /api/v1/admin/rekey`
  are mounted but answer `501`, so a rotation can be started and not finished.
- **The web UI's data.** Every screen exists, but its server loads still read
  fixture data rather than the domain layer.

No release has been cut, so nothing is published to npm yet.

## Development

The only thing you need to install is [mise](https://mise.jdx.dev) — it pins every other tool.

```bash
mise trust
mise run bootstrap
mise run dev
```

`mise run ci` mirrors CI exactly; run it before opening a PR. See `CONTRIBUTING.md`.

## License

MIT
