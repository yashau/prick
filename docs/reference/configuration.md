---
title: Configuration
description: Every environment variable, Worker secret and wrangler.jsonc setting, and where each one is read.
sidebar:
  order: 3
---

Configuration lives in four places: the CLI's environment, the CLI's files
(its profiles, and the project files a repository carries), the Worker's
secrets, and the Worker's `vars` in `packages/app/wrangler.jsonc`.

## CLI environment variables

| Variable                   | Fallback                  | Equivalent flag          | Purpose                                                  |
| -------------------------- | ------------------------- | ------------------------ | -------------------------------------------------------- |
| `PRK_PROFILE`              |                           | `--profile`              | The profile to use                                       |
| `PRK_API_URL`              |                           | `--api-url`              | Base URL of the Worker, instead of a profile             |
| `PRK_EXPECT_INSTANCE`      |                           | `--expect-instance`      | The instance id the server must report                   |
| `PRK_PROJECT`              |                           | `-P`, `--project`        | Default project                                          |
| `PRK_ENV`                  |                           | `-E`, `--env`            | Default environment                                      |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | `--access-client-id`     | Access service token client id                           |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | `--access-client-secret` | Access service token client secret                       |
| `PRK_CONFIG_DIR`           |                           |                          | The CLI's configuration directory: profiles and sessions |

An empty `PRK_PROFILE`, `PRK_API_URL` or `PRK_EXPECT_INSTANCE` counts as unset,
so a job can neutralise a variable it inherited by setting it to `""`.

An explicit flag wins over the variable. `PRK_*` is checked before the
`CF_ACCESS_*` fallbacks, which exist so that CI already configured for
`cloudflared` works unchanged, and **both halves must come from the same place** —
a `PRK_` id paired with a `CF_` secret is not a credential.

The pair is resolved in `crates/prick-auth/src/credential.rs` and attached as the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers by
`crates/prick-api/src/client.rs`.

`--access-client-secret-file` has no environment variable by design: it exists
precisely so the secret never reaches argv or the process environment. It takes
precedence over both the flag and `PRK_ACCESS_CLIENT_SECRET`. See
[the CLI reference](/reference/cli/#global-flags).

`PRK_API_URL` is for a machine with no profile for the server, such as a CI
runner authenticating with a service token. Once `prk login` has created a
profile, that profile records the server, and `PRK_PROFILE` or `--profile`
chooses between profiles. `PRK_API_URL` pointing at a URL one profile is for
uses that profile's session and pins.

## Which server a command talks to

Every `prk` invocation talks to exactly one server, chosen once, before any
request. Highest tier first:

| Tier        | Profile form                                         | URL form        | Source under `--json`        |
| ----------- | ---------------------------------------------------- | --------------- | ---------------------------- |
| Flag        | `--profile NAME`                                     | `--api-url URL` | `flag`                       |
| Environment | `PRK_PROFILE`                                        | `PRK_API_URL`   | `environment`                |
| Project     | `.prick.local.toml`, then `.prick.toml`, by instance |                 | `local_file`, `project_file` |
| Default     | `default_profile` in `config.toml`                   |                 | `default`                    |

- **A higher tier wins outright.** `--profile` beats `PRK_API_URL`; `PRK_PROFILE`
  beats a project file.
- **Both forms at one tier are refused** with `SELECTION_CONFLICT`:
  `--profile` with `--api-url`, or `PRK_PROFILE` with `PRK_API_URL`.
- **An unknown name is refused**, never skipped: `PROFILE_UNKNOWN`, or
  `PROFILE_RENAMED` naming the current name of a renamed profile.
- **The URL form** addresses a server directly. When exactly one profile is
  for that URL, its session and pins apply; when none is, only a service
  token can authenticate; when several are, the command is refused with
  `PROFILE_AMBIGUOUS`.
- **Nothing at all** is `NO_SERVER`, exit 1.

`prk profile show` prints which profile this command line and directory
select, and what selected it. `-v` on any command prints the same as
`talking to <host> (from <source>, instance <id>)`.

On top of the table:

- **Writes.** With two or more profiles, a command that changes data must be
  aimed by a flag, a variable or a project file; the default alone is
  refused with `PROFILE_REQUIRED`.
- **Service tokens.** With two or more profiles, a service token from
  `PRK_ACCESS_CLIENT_*` or `CF_ACCESS_CLIENT_*` is used only with a server
  chosen by the flag or environment tier. With a project file or the default,
  it is refused with `SERVICE_TOKEN_REFUSED`.
- **Instance checks.** Whenever a profile applies, `--expect-instance` is set,
  or a project file is in force, `prk` asks the server for its instance id
  (`/api/v1/whoami`, which carries no secret) before the command sends
  anything of its own. It must match the profile's pin, `--expect-instance`
  and the project's allow list. A server addressed by URL with no profile for
  it, no expectation and no project file gets no extra request.

The project and environment have their own order, first match wins: `-P` /
`-E`, then `PRK_PROJECT` / `PRK_ENV`, then `.prick.local.toml`, then
`.prick.toml`, then the profile's own `project` and `env`.

## CLI files

### The configuration directory

`PRK_CONFIG_DIR`, or by default:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/prick`, or `~/.config/prick` |
| macOS    | `~/Library/Application Support/prick`          |
| Windows  | `%LOCALAPPDATA%\prick`                         |

It holds `config.toml`, `credentials.json` and `credentials/<id>.json`. The
session files are described under
[`prk login`](/reference/cli/sign-in#where-the-token-is-stored).

### `config.toml`

The profiles. `prk login` and `prk profile` write it; it is safe to read, and
a hand edit is validated on the next run.

```toml title="config.toml"
# prick CLI profiles. Managed by `prk profile` and `prk login`; safe to read,
# and edits are validated on the next run.

version = 1
default_profile = "acme"

[profiles.acme]
api_url = "https://prick.acme.example"
credential = "credentials.json"
instance = "3f9c01ab3f9c01ab3f9c01ab3f9c01ab"
issuer = "https://acme.cloudflareaccess.com"
project = "api"
env = "production"

[profiles.globex]
api_url = "https://prick.globex.example"
credential = "637b1b2d310b2b96"
service_token_client_id = "e367826f93b8d71185e03fe518aff3b4.access"

[renamed.prod]
to = "acme"
instance = "3f9c01ab3f9c01ab3f9c01ab3f9c01ab"
```

| Key                       | Where             | Meaning                                                                                                              |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `version`                 | top level         | The format version. `1`. Any other value is refused: written by a newer `prk`, so update `prk`                       |
| `default_profile`         | top level         | The profile used when nothing else selects one. Optional; must name a profile                                        |
| `api_url`                 | `[profiles.NAME]` | The server. `https://`, or `http://` to a loopback address, with no `user@`. Fixed for the profile's life            |
| `credential`              | `[profiles.NAME]` | Its session file: `credentials.json`, or a 16-hex-digit id naming `credentials/<id>.json`. No two profiles share one |
| `instance`                | `[profiles.NAME]` | The pinned instance id, 32 lowercase hex digits. Absent until the server first reports one                           |
| `issuer`                  | `[profiles.NAME]` | The pinned Access issuer, `https://<team>.cloudflareaccess.com`. Absent until the first sign-in                      |
| `project`                 | `[profiles.NAME]` | The profile's default project slug. Optional                                                                         |
| `env`                     | `[profiles.NAME]` | The profile's default environment slug. Optional                                                                     |
| `service_token_client_id` | `[profiles.NAME]` | The only service-token client id this profile accepts from the environment. Optional                                 |
| `to`                      | `[renamed.NAME]`  | A tombstone: the name a renamed profile has now. `--profile NAME` fails naming it                                    |
| `instance`                | `[renamed.NAME]`  | The instance the profile was pinned to when renamed, if it was                                                       |

`NAME` is lowercase letters, digits and single hyphens, at most 64 characters.
Every read validates the names, URLs, credential references, instance ids and
slugs, that `default_profile` exists, and that no two profiles share a
credential file; a file that fails is refused with `PROFILE_STORE_FAILED`
naming the problem. A key this build does not know is accepted on read, so a
file a slightly newer `prk` wrote with an extra optional field still loads.

Every change is atomic and owner-only, made under the lock file
`config.toml.lock`. A lock older than ten seconds belongs to a process that
died and is taken over.

### `.prick.toml`

Committed with a repository, and found by searching up from the current
directory. The search stops at the first directory containing `.git`, after
checking it, or at your home directory, so a stray file above a repository
never applies to it.

```toml title=".prick.toml"
project = "api"
env = "staging"

[[allow]]
instance = "3f9c01ab3f9c01ab3f9c01ab3f9c01ab"
issuer = "https://acme.cloudflareaccess.com"
```

| Key         | Required     | Meaning                                                                                                         |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `[[allow]]` | at least one | A deployment this repository may talk to                                                                        |
| `instance`  | per entry    | Its instance id, 32 lowercase hex digits                                                                        |
| `issuer`    | no           | The Access issuer that deployment must also be behind; a profile pinned to another issuer is refused            |
| `project`   | no           | The project when neither `-P` nor `PRK_PROJECT` names one                                                       |
| `env`       | no           | The environment when neither `-E` nor `PRK_ENV` names one                                                       |
| `profile`   | no           | A tie-breaker between local profiles pinned to the one allowed instance. Refused with more than one `[[allow]]` |

Every other key is refused, `url` and `api_url` included. **A project file
never selects a URL, and never holds a credential.** It arrives with
`git clone`, so it is input from whoever wrote the repository, and it can only
narrow what this machine does: among the servers you registered yourself, it
picks the one pinned to an allowed instance.

It does two things:

- **It selects, by instance.** With exactly one `[[allow]]`, the profile used
  is the one local profile pinned to that instance, whatever it is called on
  this machine. Two profiles pinned to it, two identities on one server, need
  `profile` or `--profile` to choose. No profile pinned to it yet falls
  through to the default profile, which is then held to the allow list. With
  more than one `[[allow]]`, the committed file does not choose; the choice
  comes from `--profile`, `PRK_PROFILE` or `.prick.local.toml`.
- **It refuses.** Whatever selected the server, the server's instance must be
  on the allow list (`INSTANCE_NOT_ALLOWED`), the profile's issuer must match
  an entry's `issuer` (`ISSUER_MISMATCH`), and a server that reports no
  instance cannot satisfy the file at all (`INSTANCE_UNVERIFIED`).

`prk profile pin` writes the file for you.

### `.prick.local.toml`

This checkout's own choice, beside `.prick.toml`, for a repository that
allows more than one deployment.

```toml title=".prick.local.toml"
instance = "3f9c01ab3f9c01ab3f9c01ab3f9c01ab"
env = "production"
```

| Key        | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `instance` | The deployment this checkout uses. Must be in `.prick.toml`'s allow list                |
| `profile`  | With `instance`, a tie-breaker between profiles pinned to it; alone, the profile to use |
| `project`  | Overrides `.prick.toml`'s `project` for this checkout                                   |
| `env`      | Overrides `.prick.toml`'s `env` for this checkout                                       |

Every other key is refused. Inside a git repository it must be ignored by git
(`git check-ignore`), or every command refuses it with
`PROJECT_FILE_INVALID`: committed, it would make one checkout's choice for
everyone who clones. `prk profile pin --local` writes it.

## Worker secrets

Installed with `wrangler secret put`, never written in `wrangler.jsonc`.

| Secret           | Required               | Format                                                          |
| ---------------- | ---------------------- | --------------------------------------------------------------- |
| `MASTER_KEY`     | Yes                    | Base64 of **exactly 32 bytes**                                  |
| `MASTER_KEY_OLD` | Only during a rotation | One or more retired keys, comma-separated, each the same format |

```bash
openssl rand -base64 32
```

```bash
pnpm --dir packages/app exec wrangler secret put MASTER_KEY
```

`MASTER_KEY` is validated when the key ring is built, before any route runs. A
value that is not base64, or that decodes to any length other than 32 bytes, is
refused and the Worker fails closed on **every** request including `/health`. A
secrets manager that answers `/health` with 200 while its root of trust is
unusable is reporting the opposite of the truth.

The **decoded bytes** are the key derivation input, not the base64 text. That
distinction is the reason for the validation: feeding the text to HKDF is
completely silent — `MASTER_KEY="hunter2"` would be accepted and produce a fully
functional secrets manager protected by a password, with nothing observable at
runtime to distinguish it from a correct deployment.

Two further refusals, both meaning the rotation has not actually happened: a
retired key identical to the active one, and two keys in the ring that derive the
same key id.

:::danger[A Worker secret is write-only]
Record `MASTER_KEY` when you generate it. See
[Backup and recovery](/guides/backup-and-recovery).
:::

### Secrets Store

`loadMasterMaterial()` prefers a bound `secrets_store_secrets` binding
(`MASTER_KEY_STORE`, `MASTER_KEY_OLD_STORE`) and falls back to the plain secret.
The seam exists so that adopting Secrets Store later is a configuration change
rather than a code change.

It is deliberately **not** adopted now. Its advantages — one secret shared across
many Workers, central rotation — do not apply to a single self-hosted Worker, and
putting an open-beta control plane in front of the only root of trust of a
secrets manager is a poor trade.

## Worker vars

Plain configuration in `packages/app/wrangler.jsonc`. All are strings; the
Worker parses them once at the edge, so no route ever compares a number to the
string `"500"`.

| Var                  | Required    | Default                    | Meaning                                                                                          |
| -------------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `ACCESS_TEAM`        | Yes         | —                          | The `<team>` in `https://<team>.cloudflareaccess.com`. Used to build the issuer and the JWKS URL |
| `ACCESS_AUD`         | Yes         | —                          | The Access application's Audience (AUD) tag                                                      |
| `BOOTSTRAP_ADMINS`   | Effectively | empty                      | Comma-separated admin emails, evaluated live                                                     |
| `REQUIRE_CTX_ACCESS` | No          | `false`                    | Defence-in-depth assertion on Access-on-Workers                                                  |
| `SECRET_MAX_BYTES`   | No          | `65536`                    | Maximum size of one decrypted value, in UTF-8 bytes                                              |
| `ENV_MAX_SECRETS`    | No          | `500`                      | Hard cap on secrets per environment                                                              |
| `BODY_MAX_BYTES`     | No          | `1048576`                  | Maximum accepted request body                                                                    |
| `ACCESS_CERTS_URL`   | No          | derived from `ACCESS_TEAM` | Overrides the JWKS URL. Exists so the test harness can serve its own keys                        |

A numeric var that is present but unparseable is a **refusal**, not a silent
fallback. `ENV_MAX_SECRETS: "5OO"` (letter O) quietly falling back to 500 would
look like it worked, and the operator who meant to lower the cap to 50 would
never find out that they had not. `REQUIRE_CTX_ACCESS` accepts only the literals
`"true"` and `"false"`, quoted — it is a string var, so a JSON boolean arrives as
something else.

`SECRET_MAX_BYTES` and `ENV_MAX_SECRETS` bound more than the server. `prk`
derives the largest response it will read from those two defaults, so an
environment written at the defaults always exports. **Lowering** either is free.
**Raising** `SECRET_MAX_BYTES` above `65536` is only partly honoured: the
shared request schema caps a value at `65536` bytes, so `secrets:batch` still
refuses a larger one, while import, rename and rollback honour the higher limit.
The same applies to `BODY_MAX_BYTES`: an import's `content` is capped at
`1048576` bytes by the schema whatever the var says.
**Raising** either lets an environment grow past what the CLI reads back:
`prk secrets list` and `prk secrets get` keep working one value at a time, while
`prk secrets download` and `prk run` fail with `RESPONSE_TOO_LARGE` (exit 12).

`ACCESS_AUD` must be non-empty. An empty value would make the audience assertion
vacuous, and a verifier that accepts tokens minted for a _different_ Access
application in the same account is not a verifier.

### `REQUIRE_CTX_ACCESS`

Cloudflare shipped Access-on-Workers (`ctx.access`) on 2026-08-14. prick uses it
as an assertion **alongside** its own JWT verification, never instead of it, and
the flag stays `false` until the feature is documented and confirmed not to
swallow service-token requests. If it did swallow them, making it load-bearing
would break every CI client at once with no local signal.

The build wraps the Worker entry so that both the API and the admin UI see the
runtime's own per-request context, including `ctx.access`. Under `vite dev` no
such context exists, so the flag set to `"true"` refuses every request there.

## `wrangler.jsonc`

The parts that matter, beyond the vars above.

```jsonc title="packages/app/wrangler.jsonc"
{
  "name": "prick",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": ".svelte-kit/cloudflare/_worker.js",

  "workers_dev": false,
  "preview_urls": false,

  "routes": [{ "pattern": "prick.example.com", "custom_domain": true }],

  "assets": {
    "directory": ".svelte-kit/cloudflare",
    "binding": "ASSETS",
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "prick",
      "database_id": "<from wrangler d1 create>",
      "migrations_dir": "drizzle/migrations",
    },
  ],

  "observability": { "enabled": true, "head_sampling_rate": 1 },
}
```

| Setting                 | Why it is what it is                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workers_dev: false`    | **Non-negotiable.** Access attaches to a hostname. A `*.workers.dev` hostname Access is not in front of serves this Worker with no authentication at all     |
| `preview_urls: false`   | Same reason, for per-version preview URLs                                                                                                                    |
| `routes`                | Commented out in the repository. With workers.dev disabled and no route, `wrangler deploy` has nowhere to put the Worker — set this before your first deploy |
| `database_id`           | A placeholder in the repository. Replace it with the id from `wrangler d1 create`. It is not a secret                                                        |
| `assets.directory`      | Served **without invoking the Worker**, which is why `packages/app/_headers` exists                                                                          |
| `head_sampling_rate: 1` | Sample nothing away. This is an admin console's request volume, not a CDN's, and a dropped log line is a missing answer to "who read that secret"            |

CI greps this config for `workers_dev` and `preview_urls` on **every push** and
fails if either is not explicitly `false` — see
[Development](/contributing/development#deployment-guard). A hostname
Cloudflare Access is not attached to serves every secret in the installation to
the open internet, so this is the one setting worth checking mechanically.

## Local development

### `.dev.vars`

`mise.toml` loads a `.dev.vars` file from the **repository root** into the task
environment, with redaction on, so a `MASTER_KEY` never lands in a task log:

```toml title="mise.toml"
_.file = { path = "{{config_root}}/.dev.vars", redact = true }
```

Wrangler's own convention is a `.dev.vars` file beside `wrangler.jsonc`, in
`packages/app/`.

Both paths are covered by `.gitignore`, along with `.dev.vars.*`. Copy the
committed example — the one filename the ignore rule lets through — and fill it
in:

```bash
cp .dev.vars.example .dev.vars
```

```bash title=".dev.vars"
MASTER_KEY=<openssl rand -base64 32>
ACCESS_TEAM=your-team
ACCESS_AUD=<AUD tag>
BOOTSTRAP_ADMINS=you@example.com
```

Use a **different** master key locally. A development machine that holds the
production key has made every laptop a production credential.

### Bindings in `vite dev`

Real Cloudflare bindings during `mise run dev` come from
`@sveltejs/adapter-cloudflare`'s `platformProxy`, which reads `wrangler.jsonc`
and runs the same miniflare that `wrangler dev` does. Local D1 state persists
across restarts.

`@cloudflare/vite-plugin` is deliberately absent: it and SvelteKit both want to
own the server environment, and the pairing is unsupported.

No Cloudflare account is needed for local development.

## Next steps

- [Key rotation](/guides/key-rotation)
- [Development](/contributing/development)
