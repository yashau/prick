# `@yashau/prick-mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server, over stdio, for a self-hosted
secrets manager running on a Cloudflare Worker and D1.

It exists so that an AI coding assistant can **manage** secrets — see what exists, write a value it
just generated, remove one that is obsolete, tell you what your local `.env` is missing — without a
human pasting a credential into a chat window, and without the assistant reading one.

Full documentation: **[docs.getprick.dev](https://docs.getprick.dev)** — start with the
[MCP server guide](https://docs.getprick.dev/guides/mcp-server).

---

## The security posture

An MCP server hands tool access to a language model. For a secrets manager that is a genuine hazard,
so the default posture here is **write-mostly, read-rarely**.

| Tool                | Returns                                    | Default |
| ------------------- | ------------------------------------------ | ------- |
| `projects_list`     | project slugs and counts                   | on      |
| `environments_list` | environment slugs, key counts, revision    | on      |
| `secrets_list`      | **key names and metadata — never a value** | on      |
| `secrets_set`       | confirmation naming the key                | on      |
| `secrets_delete`    | confirmation naming the key                | on      |
| `secrets_diff`      | key names only, from both sides            | on      |
| `secrets_get`       | **a plaintext secret value**               | **off** |

### Why `secrets_get` is off by default

Because it is almost never the tool that answers the question.

"Is `DATABASE_URL` set in production?" — `secrets_list`. "What is my `.env` missing before I
deploy?" — `secrets_diff`. "Which keys does staging have that dev does not?" — `secrets_list`, twice.
"Rotate the Stripe key" — generate, `secrets_set`, done. Every one of those is answered by names, and
names are not confidential: they are what the UI renders and what the audit log records.

The residual cases that genuinely need plaintext — pasting a value into a third-party dashboard,
debugging a credential you suspect is malformed — are cases where a human is present anyway.

And a revealed value does not stay in one place. It enters the model's context, which means it can
land in a summary, a commit message, a code comment, a file the assistant writes, a log the client
keeps, or a support transcript. None of those are places a live credential should be, and none of
them are undone by noticing afterwards. Revocation is the only remedy, and revocation is an outage.

### The gate is registration, not refusal

When reveal is disabled, `secrets_get` is **not advertised in `tools/list` at all**. It is not
registered and then refused — it does not exist.

That distinction matters. A tool that is visible and refuses is still a tool the model can see, and a
model that can see it will reason about how to get it allowed: it will ask you to enable it, or it
will look for another route to the same data. A tool that was never registered does not enter the
model's option space and the question never comes up.

```
$ prick-mcp                          # tools/list -> 6 tools, no secrets_get
$ PRICK_MCP_ALLOW_REVEAL=true prick-mcp   # tools/list -> 7 tools, secrets_get present
$ prick-mcp --allow-reveal                # same
```

Enabling reveal is an operator decision, made before the transport is connected. Nothing arriving
over the wire can change it.

### The rest of the posture

- **Every tool description states, in the text the model reads, that values are confidential and must
  not be echoed into the conversation, a summary, a commit message, a file or a log.** That is a
  prompt, not an enforcement mechanism, and it is treated as such — it is the last line here, not the
  first.
- **`secrets_list` applies an allow-list projection.** It forwards `key`, `description`, `version`,
  `updated_at`, `updated_by` and `unreadable`, and drops everything else. If a future server build
  ever put a `value` field in the list response — by accident, by a debug flag left on, or because
  someone thought it would save a round-trip — this package would not forward it. "The list tool
  cannot leak a value" holds because of the shape of the code, not because of a promise made by a
  different package.
- **`secrets_diff` never builds a value.** Its `.env` scanner extracts key names and skips over
  values without ever accumulating one, so there is no value in its return type to leak. The cost is
  that it compares presence, not contents: "in both" means the key exists on both sides, not that the
  values agree. Checking that would require revealing, and it does not reveal.
- **`secrets_diff` can only read inside one directory.** It is the only tool that touches the local
  disk, and the path it is given comes from a language model — which is downstream of whatever
  document that model has been reading. Every path is resolved against a workspace root fixed at
  startup (the working directory, or `PRICK_MCP_WORKSPACE` / `--workspace`) and refused if it lands
  outside: `..`, an absolute path elsewhere and a symbolic link leading out are one case, decided by
  comparing resolved paths rather than by recognising a shape of string. The check runs before
  anything is opened and again after `realpath`, and the refusal quotes back only the caller's own
  argument — never the root, whose absolute path would say where the operator keeps their projects
  and under what user name.
- **No error path can carry a value.** The error type has no field a value could be assigned to — no
  `value`, no `body`, no `input`, no serialised `cause`. An unclassified throwable is reduced to a
  constant message rather than having its own text appended. A non-2xx response body is only quoted
  back when it parses as the API's documented error envelope; an HTML page, a proxy banner or a stack
  trace is described, never echoed. This is covered by a test that drives fourteen distinct failure
  paths with a sentinel value and asserts the sentinel appears in neither the result nor the log.
- **A tripwire on the one function that holds both.** `secrets_set` is the only place in this server
  that has a plaintext value and a failure at the same moment. If the value it just sent appears
  anywhere in the error it gets back, the text is replaced with a placeholder and the fact is logged
  at `error` level — a server that echoes submitted secrets in its error bodies is a defect somebody
  needs to hear about.
- **A value is never logged.** Not at `debug`, not in a request body, not as a length, not as a
  prefix. A length is a real signal about a credential and "it starts with `sk-`" is most of an
  identification.
- **Logs go to stderr. stdout is the transport.** stdout carries newline-delimited JSON-RPC and
  nothing else; one stray line desynchronises the client's parser, and the symptom ("the server
  stopped responding") is nowhere near the cause. The logger writes to stderr, a test asserts no
  module in `src/` touches `process.stdout` or `console`, and `main.ts` redirects `console.*` to
  stderr to cover dependencies.
- **There is no `--client-secret` flag.** Arguments are visible to every other process through `ps`
  and land in shell history. The credential comes from the environment or it does not come at all.
- **Plaintext `http://` is refused for anything but loopback.** The Access service token goes out on
  every request; sending it in the clear to a remote host is a disclosure, not a preference.
- **Deletion is annotated `destructiveHint: true`; writing is not.** The server keeps every prior
  version and an operator can roll back, so no `secrets_set` destroys data. A client that gates on the
  annotation therefore prompts where it should and does not where it should not.

### What this server does not protect you from

Stated plainly, because a security section that only lists wins is not useful:

- A model that has been told not to echo a value is not prevented from doing so. If you enable
  `secrets_get`, assume the value may end up anywhere the conversation ends up.
- The service token this server holds has whatever grants an administrator gave it. The blast radius
  of a compromised MCP client is exactly that token's scope — so scope it: an environment-scoped
  `writer` grant, not a global `admin` one.
- Nothing here defends against a malicious MCP client. It is a process on your machine reading your
  environment.

---

## Configuration

Authentication is a Cloudflare Access **service token**: two headers that Access validates at the
edge before the request reaches the Worker. There is no login flow and no token store here.

| Variable                  | Required | Meaning                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `PRICK_MCP_API_URL`       | yes      | Origin of the deployed Worker, e.g. `https://secrets.example.com`   |
| `PRICK_MCP_CLIENT_ID`     | yes      | Access service token Client ID                                      |
| `PRICK_MCP_CLIENT_SECRET` | yes      | Access service token Client Secret                                  |
| `PRICK_MCP_ALLOW_REVEAL`  | no       | `true` — and only the exact string `true` — registers `secrets_get` |
| `PRICK_MCP_WORKSPACE`     | no       | The only directory `secrets_diff` may read from. Default: the cwd   |
| `PRICK_MCP_TIMEOUT_MS`    | no       | Per-request timeout, 1000–120000. Default `15000`                   |
| `PRICK_MCP_LOG_LEVEL`     | no       | `debug` \| `info` \| `warn` \| `error` \| `silent`. Default `info`  |

Aliases are accepted so an environment already set up for `cloudflared` or for the `prk` CLI works
unchanged: `PRK_URL` for the base URL, and `PRK_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_ID` and
`PRK_ACCESS_CLIENT_SECRET` / `CF_ACCESS_CLIENT_SECRET` for the credential pair.

Flags: `--api-url <url>`, `--allow-reveal`, `--workspace <dir>`, `--log-level <level>`, `--help`,
`--version`.

A missing or non-directory `PRICK_MCP_WORKSPACE` is a startup failure, like any other
misconfiguration. The default — the working directory the client started the server in, which is the
project the client has open — is what makes the confinement real: a bound an operator has to switch
on is a bound that is off.

Misconfiguration is fatal at startup, not at the first tool call — a server that starts anyway
reports its problem to a language model instead of to the person who can fix it. Exit codes follow
`sysexits(3)`: `78` for a configuration error (the message on stderr names the missing variable),
`70` for an unexpected internal failure.

### Getting a service token

In the Cloudflare Zero Trust dashboard: **Access → Service Auth → Service Tokens → Create**. Attach
the token to a policy on the Access application in front of your Worker.

The token's `common_name` looks like `e367826f93b8d71185e03fe518aff3b4.access`, which nobody can map
to "my laptop's assistant". The normal flow is: point this server at your install, watch it get a
`403`, then find the identity under **Seen but not granted** in the admin UI and grant it there. Give
it the narrowest scope that does the job.

---

## MCP client configuration

Ready to paste. Default posture — `secrets_get` is not registered:

```json
{
  "mcpServers": {
    "prick": {
      "command": "npx",
      "args": ["-y", "@yashau/prick-mcp"],
      "env": {
        "PRICK_MCP_API_URL": "https://secrets.example.com",
        "PRICK_MCP_CLIENT_ID": "0123456789abcdef0123456789abcdef.access",
        "PRICK_MCP_CLIENT_SECRET": "REPLACE_ME"
      }
    }
  }
}
```

With reveal enabled — do this deliberately, and prefer a separate entry you can point at when you
actually need it rather than leaving it on:

```json
{
  "mcpServers": {
    "prick-reveal": {
      "command": "npx",
      "args": ["-y", "@yashau/prick-mcp", "--allow-reveal"],
      "env": {
        "PRICK_MCP_API_URL": "https://secrets.example.com",
        "PRICK_MCP_CLIENT_ID": "0123456789abcdef0123456789abcdef.access",
        "PRICK_MCP_CLIENT_SECRET": "REPLACE_ME"
      }
    }
  }
}
```

> The client config file holds a live credential. Give it `0600` permissions and keep it out of
> version control. If your client supports reading environment variables from the surrounding shell
> rather than from the config file, prefer that.

---

## Tools

### `projects_list`

No arguments. Returns the projects this identity can see: slug, name, description, environment count.

### `environments_list`

`project`. Returns the environments in that project: slug, name, key count, current revision.

### `secrets_list`

`project`, `environment`. Returns key names and metadata — **never a value**.

Entries with `unreadable: true` failed to decrypt on the server. That is either tampering or a master
key retired too early, and it is surfaced rather than skipped: a list that silently omits rows it
could not read turns a tamper attempt into a quietly shorter `.env`, which is how a deployment goes
out without `DATABASE_URL`.

### `secrets_set`

`project`, `environment`, `key`, `value`, optional `reason`.

Applied as a merge in one atomic server-side transaction: no other key is touched, and the previous
value is retained as a version, so a mistaken overwrite is recoverable. The result names the key and
the resulting revision and says nothing about the value — not its length, not a prefix, not a hash.

### `secrets_delete`

`project`, `environment`, `key`, optional `reason`.

The version history is retained as a tombstone, but the key stops being served immediately. Deleting
a key a running service depends on is an outage, not a tidy-up.

### `secrets_diff`

`project`, `environment`, `env_file`.

Compares key names in a local `.env` against the keys in an environment: `only_in_file`,
`only_in_environment`, `in_both`, plus duplicates, invalid names and malformed lines in the local
file. Reads no value from the server and retains none from the file.

`env_file` must resolve to a file inside the workspace root — the working directory the server was
started in, or whatever `PRICK_MCP_WORKSPACE` names. A path that leaves it is refused, and the
result reports `env_file` relative to that root rather than as an absolute path.

### `secrets_get` — disabled by default

`project`, `environment`, `key`, optional `reason` (`reveal` | `copy` | `export` | `run`).

Returns the bare plaintext value. Registered only when reveal is enabled. Every call is written to the
server's audit log against this server's identity, together with the reason, so an operator can tell a
look from a copy.

---

## API surface targeted

Every route is centralised in `src/routes.ts`, a file with no logic in it, and each one is served by
the router as landed — `docs/openapi.json` is generated from that router and `mise run openapi:check`
fails if it goes stale, so the table below is checkable against the server's own account of itself:

| Tool                | Method and path                                                  |
| ------------------- | ---------------------------------------------------------------- |
| `projects_list`     | `GET /api/v1/projects`                                           |
| `environments_list` | `GET /api/v1/projects/{project}/environments`                    |
| `secrets_list`      | `GET /api/v1/p/{project}/e/{environment}/secrets`                |
| `secrets_set`       | `POST /api/v1/p/{project}/e/{environment}/secrets:batch`         |
| `secrets_delete`    | `POST /api/v1/p/{project}/e/{environment}/secrets:batch`         |
| `secrets_diff`      | `GET /api/v1/p/{project}/e/{environment}/secrets`                |
| `secrets_get`       | `GET /api/v1/p/{project}/e/{environment}/secrets/{key}?reason=…` |

Both write tools send the documented batch body: `{"mode": "merge", "set": {...}}` or
`{"mode": "merge", "delete": [...]}`, with an optional `reason` recorded verbatim in the audit log.
`expected_rev` is deliberately not sent for a single-key merge — there is no read-modify-write to lose
a race on, and sending a revision read seconds ago would turn an unrelated concurrent write in the UI
into a spurious `412`.

Response envelopes are read tolerantly (a bare array, `{data: []}` or `{<name>: []}` are all
accepted) while the fields inside them are read strictly, through the allow-list projections. The
tolerance is where a mismatch is cheap; the strictness is where it is not.

---

## Development

```
pnpm --dir packages/mcp run typecheck   # tsc --noEmit over src/ and test/
pnpm --dir packages/mcp run test        # node:test, no test framework dependency
pnpm --dir packages/mcp run build       # tsc -> dist/
```

Relative imports carry a `.ts` extension. That is what lets one set of sources be both run directly
by `node --test` (Node's type stripping does not map `./foo.js` onto `./foo.ts`) and compiled by
`tsc`, which rewrites the specifier on emit. Without it the tests would have to run against build
output.

The zod primitives in `src/schemas.ts` are restated rather than imported from the workspace's shared
schema package: that package is private, and a published package cannot depend on something that is
never published. The duplication is bounded — a POSIX name pattern, a slug pattern and three byte
limits — and the server validates all of it again before writing anything.
