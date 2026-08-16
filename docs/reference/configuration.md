---
title: Configuration
description: Every environment variable, Worker secret and wrangler.jsonc setting, and where each one is read.
sidebar:
  order: 3
---

Configuration lives in three places: the CLI's environment, the Worker's secrets,
and the Worker's `vars` in `packages/app/wrangler.jsonc`.

## CLI environment variables

| Variable                   | Fallback                  | Equivalent flag          | Purpose                            |
| -------------------------- | ------------------------- | ------------------------ | ---------------------------------- |
| `PRK_API_URL`              |                           | `--api-url`              | Base URL of the Worker             |
| `PRK_PROJECT`              |                           | `-P`, `--project`        | Default project                    |
| `PRK_ENV`                  |                           | `-E`, `--env`            | Default environment                |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | `--access-client-id`     | Access service token client id     |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | `--access-client-secret` | Access service token client secret |

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

`PRK_API_URL` is only needed when you have not run `prk login`, which records the
server it signed in to.

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

`ACCESS_AUD` must be non-empty. An empty value would make the audience assertion
vacuous, and a verifier that accepts tokens minted for a _different_ Access
application in the same account is not a verifier.

### `REQUIRE_CTX_ACCESS`

Cloudflare shipped Access-on-Workers (`ctx.access`) on 2026-08-14. prick uses it
as an assertion **alongside** its own JWT verification, never instead of it, and
the flag stays `false` until the feature is documented and confirmed not to
swallow service-token requests. If it did swallow them, making it load-bearing
would break every CI client at once with no local signal.

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
