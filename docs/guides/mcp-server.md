---
title: MCP server
description: Let an AI coding assistant manage your secrets over the Model Context Protocol, without reading their values.
sidebar:
  order: 8
---

:::note[Before you begin]
This server authenticates with an Access **service token**, not with
`prk login`. Read
[Authentication](/guides/authentication#authenticate-a-machine) first.
:::

`@yashau/prick-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server, over stdio, published alongside the CLI at the same version and cut by
the same tag.

It exists so an assistant can **manage** secrets — see what exists, write a value
it just generated, remove one that is obsolete, tell you what your local `.env`
is missing — without a human pasting a credential into a chat window, and
without the assistant reading one.

## The posture: write-mostly, read-rarely

Handing tool access to a language model is a real hazard for a secrets manager,
so the reveal tool is off unless you turn it on.

| Tool                | Returns                                    | Default |
| ------------------- | ------------------------------------------ | ------- |
| `projects_list`     | project slugs and counts                   | on      |
| `environments_list` | environment slugs, key counts, revision    | on      |
| `secrets_list`      | **key names and metadata — never a value** | on      |
| `secrets_set`       | confirmation naming the key                | on      |
| `secrets_delete`    | confirmation naming the key                | on      |
| `secrets_diff`      | key names only, from both sides            | on      |
| `secrets_get`       | **a plaintext secret value**               | **off** |

Names answer nearly every question that gets asked. "Is `DATABASE_URL` set in
production?" is `secrets_list`. "What is my `.env` missing before I deploy?" is
`secrets_diff`. "Rotate the Stripe key" is generate, `secrets_set`, done. Key
names are not confidential — they are what the UI renders and what the audit log
records.

:::danger[A revealed value does not stay in one place]
It enters the model's context, which means it can land in a summary, a commit
message, a code comment, a file the assistant writes, a log the client keeps, or
a support transcript. Revocation is the only remedy, and revocation is an
outage.
:::

### The gate is registration, not refusal

When reveal is off, `secrets_get` is **not advertised in `tools/list` at all**.
It is not registered and then refused — it does not exist.

That distinction is the whole design. A tool that is visible and refuses is
still a tool the model can see, and a model that can see it will reason about
how to get it allowed: it will ask you to enable it, or look for another route
to the same data. A tool that was never registered does not enter the model's
option space, and the question never comes up.

Enabling reveal is an operator decision made before the transport is connected.
Nothing arriving over the wire can change it.

## Configure it

| Variable                  | Required | Meaning                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `PRICK_MCP_API_URL`       | yes      | Origin of the deployed Worker                                       |
| `PRICK_MCP_CLIENT_ID`     | yes      | Access service token client id, the one ending in `.access`         |
| `PRICK_MCP_CLIENT_SECRET` | yes      | Access service token client secret                                  |
| `PRICK_MCP_ALLOW_REVEAL`  | no       | `true` — and only the exact string `true` — registers `secrets_get` |
| `PRICK_MCP_TIMEOUT_MS`    | no       | Per-request timeout, 1000–120000. Default `15000`                   |
| `PRICK_MCP_LOG_LEVEL`     | no       | `debug`, `info`, `warn`, `error` or `silent`. Default `info`        |

An environment already set up for `cloudflared` or for `prk` works unchanged:
`PRK_URL` is read for the base URL, and `PRK_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_ID` and their secret halves for the credential pair.

Flags: `--api-url <url>`, `--allow-reveal`, `--log-level <level>`, `--help`,
`--version`. There is deliberately **no `--client-secret`** — arguments are
visible to every other process through `ps` and land in shell history, so the
credential comes from the environment or it does not come at all.

Misconfiguration is fatal at startup rather than at the first tool call: a server
that starts anyway reports its problem to a language model instead of to the
person who can fix it. Exit codes follow `sysexits(3)` — `78` for a configuration
error, naming the missing variable on stderr, and `70` for an unexpected internal
failure.

## Client configuration

Ready to paste. The default posture, with `secrets_get` unregistered:

```json title="mcp.json"
{
  "mcpServers": {
    "prick": {
      "command": "npx",
      "args": ["-y", "@yashau/prick-mcp"],
      "env": {
        "PRICK_MCP_API_URL": "https://prick.example.com",
        "PRICK_MCP_CLIENT_ID": "0123456789abcdef0123456789abcdef.access",
        "PRICK_MCP_CLIENT_SECRET": "REPLACE_ME"
      }
    }
  }
}
```

With reveal enabled — prefer a **separate entry** you point at when you actually
need it, rather than leaving it on:

```json title="mcp.json"
{
  "mcpServers": {
    "prick-reveal": {
      "command": "npx",
      "args": ["-y", "@yashau/prick-mcp", "--allow-reveal"],
      "env": {
        "PRICK_MCP_API_URL": "https://prick.example.com",
        "PRICK_MCP_CLIENT_ID": "0123456789abcdef0123456789abcdef.access",
        "PRICK_MCP_CLIENT_SECRET": "REPLACE_ME"
      }
    }
  }
}
```

:::caution[The client config file holds a live credential]
Give it mode `0600` and keep it out of version control. If your client can read
environment variables from the surrounding shell rather than from the config
file, prefer that.
:::

## Grant it the narrowest role that works

The blast radius of a compromised MCP client is exactly this token's scope. Give
it an environment-scoped `writer`, not a global `admin`.

The first run will `403`, and that is the flow — Access lets the token through
the edge, and prick refuses it, because a new service token has no grant. The
denial is the introduction:

```bash
prk access identities --denied
```

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role writer --scope api:staging
```

Name it while you are there, so an access list is readable a year from now:

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access "laptop assistant"
```

## The tools

| Tool                | Arguments                                           |
| ------------------- | --------------------------------------------------- |
| `projects_list`     | none                                                |
| `environments_list` | `project`                                           |
| `secrets_list`      | `project`, `environment`                            |
| `secrets_set`       | `project`, `environment`, `key`, `value`, `reason?` |
| `secrets_delete`    | `project`, `environment`, `key`, `reason?`          |
| `secrets_diff`      | `project`, `environment`, `env_file`                |
| `secrets_get`       | `project`, `environment`, `key`, `reason?`          |

`secrets_set` is applied as a merge in one atomic server-side transaction: no
other key is touched, and the previous value is retained as a version, so a
mistaken overwrite is recoverable. `secrets_delete` keeps the version history as
a tombstone, but the key stops being served immediately.

`secrets_diff` compares **key names** in a local `.env` against an environment —
`only_in_file`, `only_in_environment`, `in_both`, plus duplicates, invalid names
and malformed lines in the local file. Its scanner extracts names and skips over
values without ever accumulating one, so "in both" means the key exists on both
sides, not that the values agree. Checking that would require revealing.

Deletion is annotated `destructiveHint: true` and writing is not, so a client
that gates on the annotation prompts where it should.

Every `secrets_get` call is written to the audit log against this server's
identity, together with its reason, so an operator can tell a look from a copy.

## What this does not protect you from

Stated plainly, because a security section that only lists wins is not useful:

- A model told not to echo a value is not prevented from doing so. If you enable
  `secrets_get`, assume the value may end up anywhere the conversation ends up.
- Nothing here defends against a malicious MCP client. It is a process on your
  machine reading your environment.
- The token has whatever grants an administrator gave it. Scope it.

[`packages/mcp/README.md`](https://github.com/yashau/prick/blob/main/packages/mcp/README.md) carries the rest: the allow-list projection on
`secrets_list`, the tripwire on `secrets_set`, and why no error path can carry a
value.

## Next steps

- [Access control](/guides/access-control) — service tokens and scoped grants.
- [Threat model](/architecture/threat-model)
- [Secrets](/guides/secrets)
