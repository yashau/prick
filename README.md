<div align="center">

<img src="assets/brand/lockup.svg" alt="prick" width="380">

### **P**ortable **R**untime **I**njection of **C**loudflare (stored) **K**eys

A self-hosted secrets manager that runs entirely on your own Cloudflare account.<br>
One Worker, one D1 database, and nothing else to operate.

[![CI](https://img.shields.io/github/actions/workflow/status/yashau/prick/ci.yml?branch=main&label=CI&labelColor=238112&color=C8F93A&logo=githubactions&logoColor=white)](https://github.com/yashau/prick/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/yashau/prick/codeql.yml?branch=main&label=CodeQL&labelColor=238112&color=C8F93A&logo=github&logoColor=white)](https://github.com/yashau/prick/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-C8F93A?labelColor=238112&logo=opensourceinitiative&logoColor=white)](LICENSE)
[![crates.io](https://img.shields.io/crates/v/prk?label=crates.io&labelColor=238112&color=C8F93A&logo=rust&logoColor=white)](https://crates.io/crates/prk)
[![npm](https://img.shields.io/npm/v/%40yashau%2Fprick?label=npm&labelColor=238112&color=C8F93A&logo=npm&logoColor=white)](https://www.npmjs.com/package/@yashau/prick)

**[Install](#-install)** · **[Examples](#-examples)** · **[Access control](#-access-control)** ·
**[Getting started](#-getting-started)** · **[Quickstart](docs/getting-started/quickstart.md)** ·
**[CLI reference](docs/reference/cli/index.md)** · **[Docs](docs/index.md)**

</div>

---

```bash
prk login https://secrets.example.com
prk secrets set DATABASE_URL --project api --env production   # prompts, masked
prk run --project api --env production -- ./deploy.sh         # injected, never written to disk
```

The name is the job description: keys live in your Cloudflare account, and `prk` injects them into a
process at runtime — portably, and without ever touching disk.

## 🧩 What it is

|             |                                                                                                            |
| :---------- | :--------------------------------------------------------------------------------------------------------- |
| **`prk`**   | The command-line client: one static Rust binary, talking HTTP to your Worker.                              |
| **Web UI**  | A SvelteKit admin console served from the same Worker.                                                     |
| **Auth**    | Cloudflare Access — SSO for people, service tokens for CI. Identity comes from the signed JWT.             |
| **Storage** | D1. Values are AES-256-GCM, and each ciphertext is cryptographically bound to the row that holds it.       |
| **MCP**     | An [MCP server](docs/guides/mcp-server.md), so a coding assistant can manage secrets without reading them. |

## ⚙️ How it works

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

## 📦 Install

`prk` is one static binary. Every channel below serves the same prebuilt artefact from the
[release page](https://github.com/yashau/prick/releases), and every one of those is
provenance-attested — `gh attestation verify <archive> --repo yashau/prick` checks it against this
repository.

```bash
brew install yashau/prick/prk    # macOS, Linux
cargo binstall prk               # anywhere with a Rust toolchain
npm install -g @yashau/prick     # anywhere with Node
winget install yashau.prick      # Windows
```

Scoop takes the bucket first:

```powershell
scoop bucket add prick https://github.com/yashau/scoop-bucket
scoop install prick/prk
```

`cargo install prk` builds from source instead, and the
[release page](https://github.com/yashau/prick/releases) carries plain archives for eight
platforms with a `SHA256SUMS` and an SPDX SBOM beside them.

If you already use mise, let it own the install:

```bash
mise use -g npm:@yashau/prick
```

npm's global prefix sits inside the active Node's install directory, so a plain `npm install -g`
lands somewhere that is only on `PATH` while mise is activated — and moves the day mise bumps Node.
mise's own npm backend puts a `prk` shim in the shims directory that is already on your `PATH`, and
keeps it there across Node upgrades.

The npm route adds a Node process to every invocation, which `prk doctor` reports; the direct
installs above avoid it. See **[Install the CLI](docs/getting-started/install.md)** for the whole
picture, shell completions included.

## 💻 Examples

Deploying takes five commands — see [Getting started](#-getting-started) — and everything below
assumes you have run `prk login`.

> [!TIP]
> Set the project and environment once and the flags disappear from every command for the rest of
> the day. A `direnv` file per repository does the same thing permanently.
>
> ```bash
> export PRK_PROJECT=api PRK_ENV=production
> ```

<details open>
<summary><b>🏃 Hand the whole environment to a process</b></summary>

<br>

```bash
prk run -- npm start
```

Secrets reach the child through its environment block and nowhere else: no temporary `.env`, no
fifo, nothing written to disk. Everything after `--` belongs to the child, so its own flags are
unambiguous even when `prk` understands them too:

```bash
prk run -- npm test --json -q
```

`prk run` never invokes a shell — that is what keeps quoting predictable — so ask for one when you
want one:

```bash
prk run -- sh -c 'migrate && npm start'
```

On Unix `prk` replaces itself with the child via `execvp`, so the exit code and signal disposition
are the command's own and a script cannot tell it ran under `prk run`.

Check what went in, without seeing values:

```bash
prk run -vv -- node -e 'console.log("up")'
```

```
injecting 12 secrets into the child environment
variables: DATABASE_URL, REDIS_URL, STRIPE_SECRET_KEY, …
up
```

</details>

<details open>
<summary><b>🔏 Put a secret in</b></summary>

<br>

> ⚠️ **The value is never an argument.** An argument lands in your shell history and is visible in
> `ps` output to every user on the machine. The masked prompt and `--stdin` are the two ways in.

```bash
prk secrets set STRIPE_SECRET_KEY --description "Live mode, rotates quarterly"
```

```
Value for STRIPE_SECRET_KEY:
Added `STRIPE_SECRET_KEY` (rev 12).
```

Or pipe it, which is the same write without a terminal:

```bash
openssl rand -hex 32 | prk secrets set SESSION_SECRET --stdin
```

Descriptions are stored in plaintext beside the key name, so they are safe to read in a listing —
and must never contain a value.

</details>

<details>
<summary><b>🗂️ Create a project and its environments</b></summary>

<br>

```bash
prk projects create "API service" --slug api
prk env create Production
prk env create Staging
```

```
Created project `API service` (api).
Created environment `Production` (production).
Created environment `Staging` (staging).
```

The **slug** is what every command, URL and `--scope` addresses, and it is permanent. The display
name is free text and can be renamed.

</details>

<details>
<summary><b>📥 Move an existing <code>.env</code> in</b></summary>

<br>

> 🛑 **`upload` replaces the environment by default** — keys the file does not name are deleted.
> Look before you leap.

```bash
prk secrets upload .env --dry-run
```

```
3 added, 1 changed, 2 removed (dry run; nothing was written).
```

Once it says what you expected:

```bash
prk secrets upload .env --reason "initial import from the repo"
git rm --cached .env && rm .env
```

`--reason` is copied verbatim into the audit row. Use `--merge` to add keys without removing the
ones the file leaves out. The whole file goes in one request, as one transaction with its audit row
inside it — so a failed import leaves the environment exactly as it was.

</details>

<details>
<summary><b>🎯 Take one value out</b></summary>

<br>

```bash
export DATABASE_URL="$(prk secrets get DATABASE_URL)"
```

`prk secrets get` prints the bare value on stdout and nothing else, so it composes. Every reveal is
audited, and the audit row records _why_: `reveal`, `copy`, `export` or `run`. That is what lets a
reader tell "someone looked at it" from "someone took it".

</details>

<details>
<summary><b>📄 Write a file, when the consumer insists on one</b></summary>

<br>

```bash
prk secrets download --format env --output .env
docker run --env-file .env myimage
rm -f .env
```

`--output` creates the file `0600`. Prefer `prk run`, which writes nothing — or forward named
variables into the container instead, since a container does **not** inherit the `docker` client's
environment:

```bash
prk run -- docker run -e DATABASE_URL -e STRIPE_SECRET_KEY myimage
```

Four export formats are available — `env`, `shell`, `yaml` and `json` — and every one of them quotes
unconditionally rather than "when necessary". Conditional quoting means modelling the consumer's
grammar exactly, and a single miss is either a command injection or a silently altered value.

</details>

<details>
<summary><b>🤖 Give CI read-only access to one environment</b></summary>

<br>

Point the job at prick and let it `403` on the first run. That refusal is not a mistake — it is how
a service token introduces itself:

```bash
prk access identities --denied
```

```
e367826f93b8d71185e03fe518aff3b4.access	service	1 attempt(s)
```

There is the subject, so nobody copies an opaque hex string between two consoles:

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
prk access rename e367826f93b8d71185e03fe518aff3b4.access "api deploy job"
```

Name it while you still know what it is. An access list of hex strings is how a stale token survives
three audits: nobody could say what it was for, so nobody was willing to be the one who removed it.

Then, in the workflow:

```yaml
env:
  PRK_API_URL: https://secrets.example.com
  PRK_PROJECT: api
  PRK_ENV: production
  PRK_ACCESS_CLIENT_ID: ${{ secrets.PRICK_CLIENT_ID }}
  PRK_ACCESS_CLIENT_SECRET: ${{ secrets.PRICK_CLIENT_SECRET }}
steps:
  - run: prk run --no-input -- ./deploy.sh
```

`--no-input` fails immediately instead of blocking on a prompt no CI job can answer.

</details>

<details>
<summary><b>⏪ Roll back a bad value</b></summary>

<br>

```bash
prk secrets history DATABASE_URL
```

```
v4	set	you@example.com
v3	set	deploy@example.com
v2	delete	you@example.com	DELETED
v1	set	you@example.com
```

Tombstones are shown rather than skipped — "this key was deleted at version 2" answers half the
questions this command gets asked.

```bash
prk secrets rollback DATABASE_URL --to 3 --reason "bad connection string in v4"
```

```
Restored `DATABASE_URL` from version 3 as version 5 (rev 46).
```

The old plaintext is re-encrypted as a **new** version bound to it, so an old ciphertext blob
replayed into the current row still fails its tag check.

</details>

<a id="why-does-bob-have-production"></a>

<details>
<summary><b>🔍 Answer "why does Bob have production?"</b></summary>

<br>

```bash
prk access explain bob@example.com
```

```
bob@example.com	user
groups	contractors, platform
billing:production	admin	via group `platform` on `billing:*`
     reader	a direct grant	on `billing:production`
  -> admin	group `platform`	on `billing:*`
```

`->` marks the grant the server reported as decisive — the one to remove. Revoking Bob's direct
`reader` grant would change nothing; taking him out of `platform` is the answer.

</details>

<details>
<summary><b>🚨 Stop an identity at three in the morning</b></summary>

<br>

```bash
prk access disable bob@example.com
```

One write, checked **before** grants are resolved, so it outranks every grant at every scope —
direct, group-held and `BOOTSTRAP_ADMINS` alike. Nothing has to be enumerated, so nothing can be
missed.

`prk access enable` puts it all back exactly as it was, because disabling never touched the grants.
Run `prk access explain` first to see what re-enabling would restore.

</details>

<details>
<summary><b>🧰 Script it</b></summary>

<br>

`--json` is a contract rather than a formatting flag:

| Outcome | stdout            | stderr                  |
| ------- | ----------------- | ----------------------- |
| Success | one JSON document | **empty**               |
| Failure | **empty**         | one JSON error envelope |

Both halves are guaranteed, so a redirect that fails writes an empty file rather than a truncated
one that still parses.

```bash
# Refuse to deploy from an environment holding a secret that will not decrypt.
unreadable=$(prk secrets list --json | jq '[.[] | select(.unreadable)] | length')
[ "$unreadable" -eq 0 ] || { echo "$unreadable secret(s) will not decrypt" >&2; exit 1; }
```

```bash
# Optimistic write: refuse if anyone else touched the environment in between.
rev=$(prk env list --json | jq -r '.[] | select(.slug == "production") | .rev')
prk secrets upload .env --expected-rev "$rev" --no-input
```

```bash
# Diff two environments by key. Names only — no values are involved.
diff <(prk secrets list --json -E staging    | jq -r '.[].key' | sort) \
     <(prk secrets list --json -E production | jq -r '.[].key' | sort)
```

</details>

<br>

Complete walkthroughs live in **[docs/examples](docs/examples/index.md)**; every command, flag and
exit code is in the **[CLI reference](docs/reference/cli/index.md)**.

## 🏛️ Design decisions worth knowing

<table>
<tr><td width="32%"><strong>🔗 Ciphertexts are bound to their row</strong></td>
<td>Additional authenticated data covers purpose, environment, key name and version. A ciphertext lifted from one row and pasted into another does not decrypt — it fails authentication.</td></tr>

<tr><td><strong>⚛️ Writes are atomic</strong></td>
<td>A bulk write is a single D1 <code>batch()</code>, a real transaction. There is no window in which an environment is half-written.</td></tr>

<tr><td><strong>📝 Nothing mutates unaudited</strong></td>
<td>The audit insert is the last statement <em>inside</em> that same transaction. If the audit write fails, the data write fails.</td></tr>

<tr><td><strong>🚫 Nothing is granted implicitly</strong></td>
<td>An authenticated identity holding no grant gets nothing — and <strong>404, not 403</strong>, from every resource-addressed route, so it cannot enumerate what exists.</td></tr>

<tr><td><strong>📢 Failures are loud</strong></td>
<td>A row that will not decrypt is reported, never skipped. A silently shorter <code>.env</code> is how a deploy loses <code>DATABASE_URL</code> and nobody finds out until the outage.</td></tr>

<tr><td><strong>🙈 Secrets never reach the HTML</strong></td>
<td>The secrets screen is client-rendered on purpose: no server render means no serialised page payload. CI fails the build if a server load so much as calls a reveal function.</td></tr>
</table>

## 🛡️ Access control

A grant is a **role** — what you may do — at a **scope** — where you may do it.

| Role     | Read metadata | Read values | Write secrets | Manage grants |
| :------- | :-----------: | :---------: | :-----------: | :-----------: |
| `reader` |      ✅       |     ✅      |       —       |       —       |
| `writer` |      ✅       |     ✅      |      ✅       |       —       |
| `admin`  |      ✅       |     ✅      |      ✅       |      ✅       |

Totally ordered: `reader < writer < admin`.

| Scope         | Written as        | Covers                             |
| :------------ | :---------------- | :--------------------------------- |
| `global`      | `*:*` (default)   | Every project on the server        |
| `project`     | `acme:*`          | Every environment in `acme`        |
| `environment` | `acme:production` | One environment, and only that one |

Grants inherit **downwards only**: a project grant covers every environment in it, and an
environment admin is not a project admin.

```bash
prk access grant alice@example.com --role admin                             # everything
prk access grant bob@example.com   --role writer --scope acme:*             # one project
prk access grant ci@example.com    --role reader --scope acme:production    # one environment
prk access grant dana@example.com  --role reader --scope acme:staging --expires-in 30
```

A **group** is a named set of identities, and holds grants of its own — so the same scopes are handed
out to a roster rather than to a person. Membership on its own confers nothing.

> [!NOTE]
> Your effective role at a scope is the **maximum** over your direct grants and the grants of every
> group you belong to: purely additive, with no deny rules, because a deny that silently overrides an
> explicit grant is the most confusing thing an authorization system can have.
>
> It resolves in one query, so a 200-secret operation performs one authorization lookup rather than
> two hundred.

`prk access explain` — `GET /identities/{id}/effective-permissions` — answers _"why does Bob have
production?"_ by naming the grant or group that conferred it. There is a
[worked example above](#why-does-bob-have-production).

## 🚀 Getting started

Deploy it to your own account. This repository never deploys it for you.

```bash
git clone https://github.com/yashau/prick && cd prick
mise trust && mise run bootstrap
openssl rand -base64 32 | pnpm --filter @prick/app exec wrangler secret put MASTER_KEY
pnpm --filter @prick/app exec wrangler d1 migrations apply prick --remote
pnpm --filter @prick/app exec wrangler deploy
```

> [!IMPORTANT]
> Put **Cloudflare Access** in front of the hostname before you put a secret in it. The Worker ships
> with `workers_dev` and `preview_urls` disabled and CI asserts both on every push, because an
> unprotected hostname serves the entire application without a JWT.

**[Quickstart](docs/getting-started/quickstart.md)** ·
**[Authentication](docs/guides/authentication.md)** ·
**[Access control](docs/guides/access-control.md)** ·
**[Threat model](docs/architecture/threat-model.md)**

## 🔑 `MASTER_KEY` is the whole ballgame

> [!CAUTION]
> Lose it and every stored secret is unrecoverable. A D1 export without it is just ciphertext —
> which is a feature rather than a bug, and also the most common way people lose everything. **Back
> up the key before you store the first secret.**

Rotation is incremental, and both the settings screen and `prk keyring status` tell you when it is
safe to drop the retired key — counted live, every time you ask.

```bash
prk keyring rekey --until-done
```

See **[Backup and recovery](docs/guides/backup-and-recovery.md)** and
**[Key rotation](docs/guides/key-rotation.md)**.

## 📊 Status

The CLI is published on **crates.io, npm, Homebrew, Scoop and WinGet**, and the Worker is yours to
deploy. Releases are CalVer, cut from a git tag, and every archive carries a provenance attestation
and an SBOM.

The test suite is real: six suites — Rust, Worker + UI, end-to-end, scripts, the GitHub Action and
the MCP server — and CI runs every one of them on every push. `prick-core` additionally carries a
machine-checked purity proof under miri, and `cargo audit bin` works on a downloaded binary because
the dependency list is embedded in it. `mise run test` prints the current counts, which is the only
place they stay right.

Migrations are additive only, the API is versioned at `/api/v1`, and a client and server on
different versions is supported — `prk doctor` reports both.

## 🛠️ Development

The only thing you install is [mise](https://mise.jdx.dev). It pins everything else.

```bash
mise run dev      # Worker + UI
mise run test     # every suite
mise run ci       # a superset of CI — run before opening a PR
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[AGENTS.md](AGENTS.md)**.

## ⚖️ License

[MIT](LICENSE)
