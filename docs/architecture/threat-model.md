---
title: Threat model
description: What prick protects against, what it deliberately does not, and the trades that were made on purpose.
sidebar:
  order: 4
---

This page is written to be useful rather than reassuring. If a property does not
hold, it is listed here rather than left for you to discover.

## What is being protected

Secret **values**. Nothing else on the following list is encrypted:

- Secret key names.
- Project and environment names, slugs and descriptions.
- Identity subjects: email addresses and service token common names.
- Group slugs, names and memberships.
- Grants, and the entire audit log.

"Not encrypted" is not the same as "readable by anyone who asks". Every one of
those is still behind the grant table at request time: listing identities, groups
and grants needs an admin grant at some scope, and reading the audit log is
narrowed to the scopes you administer. What the list means is that anyone holding
the **database** — a D1 export, a Cloudflare account compromise — reads all of it
in the clear, `MASTER_KEY` or no `MASTER_KEY`.

## Who is trusted

| Party                            | Trusted with                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Anyone who can `wrangler deploy` | **Everything.** See below                                                          |
| Cloudflare                       | Running the Worker and D1, and authenticating at the edge                          |
| A global administrator           | Every value in the system                                                          |
| The prick server                 | Storing and returning values. **Not** with choosing what code runs on your machine |

## The three things you should know before adopting this

### 1. Deploy access is total access

Anyone who can run `wrangler deploy` against your account can read `MASTER_KEY`
— by deploying a Worker that prints it, or simply by replacing prick with
something that exfiltrates every value it decrypts. There is no grant, no role
and no audit configuration that changes this.

That is not a flaw in the authorization model; it is the boundary the
authorization model sits inside. It is also why the bootstrap admin mechanism is
a plain configuration variable rather than a token: anchoring the first
administrator to the authority that already has total access adds no exposure,
and a printed one-time credential would.

**Practical consequence:** the set of people who can deploy to this Cloudflare
account _is_ the set of people who can read every secret. Treat Cloudflare
account access as equivalent to a global admin grant, and audit it in the same
way.

### 2. `prk run` injects through the environment

`prk run` puts values into the child process's environment. On Linux that
environment is readable at `/proc/<pid>/environ` **by the same user and by
root**, appears in a core dump, and may be captured by process monitoring or a
crash reporter. On other platforms the equivalents differ in detail, not in kind.

This is a deliberate trade. The alternatives are worse for the same threat: a
file on disk persists after the process exits, command-line arguments are visible
in `ps` to _every_ user, and a private channel would require the child program to
cooperate. The environment is the mechanism that every program already
understands.

**Practical consequence:** `prk run` protects a secret from _the disk_ and from
_other users' processes at rest_, not from another process running as you, and not
from root. If your threat model includes a hostile process running as the same
user, `prk run` does not address it.

### 3. Secret key names are stored in plaintext

Only values are encrypted. `DATABASE_URL` is stored as text.

This is deliberate, and the reason is queryability: the UI lists key names, the
diff view compares them, the audit log names them, and an operator has to be able
to see that `DATABASE_URL` exists — and that it is missing from staging — without
decrypting anything. Encrypting names would mean either decrypting the whole
environment to render a list, or maintaining a searchable index that leaks the
same information by another route.

**Practical consequence:** anyone with read access to the D1 database learns your
complete inventory of secret names, environments and people, even though the
values are safe. Do not encode sensitive information in a key name.

## What the design does protect against

### Database read access

An attacker with a D1 export, or with read access to the database, gets
ciphertext. Without `MASTER_KEY` the values are not recoverable. This is also why
a backup without the key is worthless — see
[Backup and recovery](/guides/backup-and-recovery).

They do get all the metadata listed above.

### Database write access

The additional authenticated data binds each ciphertext to `(purpose,
environment_id, key, version)`. An attacker who can write to D1 therefore cannot:

- Move a production ciphertext into a development environment they can read.
- Move a value from one key name to another.
- Replay an old version as the current one.

Each of those fails GCM tag verification. See
[Encryption](/architecture/encryption).

They **can** still destroy data, and they can corrupt rows. Corruption is loud:
a decrypt failure fails the request or marks the row unreadable, and audits with
`outcome: 'error'`. Nothing skips a row it cannot read.

They can also **edit the audit log**. It is append-only by application
convention, not by storage guarantee.

### A malicious or compromised server

The server stores secrets. It does not get to choose what code runs on your
machine.

`prk run` refuses to inject variables the dynamic loader or a language runtime
interprets before the program starts — `LD_PRELOAD`, `DYLD_*`, `PATH`,
`NODE_OPTIONS`, `BASH_ENV` and their relatives. Without that, a compromised
server achieves arbitrary code execution on every machine that runs `prk run`.
The refusal fails the whole launch rather than dropping the offending variable,
and `--allow-unsafe-env` is the deliberate opt-out.

### Secrets leaking into logs and error messages

- The CLI denies `print_stdout` and `print_stderr` workspace-wide, with no
  exceptions: all output goes through `prk::output`, which writes to the stream
  handles directly. A secret reaching stderr is a build failure, not a review
  outcome.
- Secret values are held in types whose debug formatting is redacted.
- The API's validation error formatter reads `issue.path` and `issue.message` and
  drops `issue.input`. A rejected secret write would otherwise put the plaintext
  in the response, the Worker log and the audit detail at once.
- Crypto errors name the row — environment, key, version, key id — and never the
  value or the ciphertext.
- An unclassified 500 carries a constant message rather than the underlying one,
  because nothing has established what that text contains.

### Secrets leaking into a browser page

Screens that display values are client-rendered only. There is no server render,
so there is no serialised page payload for a value to sit in. Form actions never
return values, because SvelteKit serialises an action's return into page data.

Beyond that: a strict Content Security Policy with no host allowlist for scripts on the
admin UI (the `/api/v1/docs` reference viewer is the documented exception),
`frame-ancestors 'none'` delivered as a real header (meta-tag CSP ignores that
directive), no service worker registered anywhere — a service worker cache is a
plaintext secret store on disk — revealed values held only in memory with a
30-second expiry and an idle wipe, and secret inputs marked so password managers
do not capture and sync them.

### Cross-site reads of the API

There is no CORS middleware, deliberately. Omitting `Access-Control-Allow-Origin`
entirely is what stops any other site reading a response from this API in a
victim's browser.

### Token forgery

The Worker verifies the Access JWT itself rather than trusting that the edge ran.
The signing algorithm is taken from the JWKS entry matched by `kid`, never from
the token header, which rejects `alg: none` and RS256→HS256 confusion. Issuer is
exact-match, audience is checked against the array, and expiry has no skew
allowance.

## Writing to the wrong organisation

One `prk` can hold profiles for several deployments: your own, a client's, a
staging copy. Keeping one deployment's **credential** away from another is the
easy half; see [Authentication](/guides/authentication#what-keeps-servers-apart).
The harder half is your own valid credential writing a value into the wrong
deployment. Project, environment and key names collide across organisations,
so `api:production` exists in both and the wrong write returns `200`. Nothing
about it is loud unless the client makes it so.

### How it goes wrong

| Scenario                                                                                            | Control                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A stale default: `prk profile use other` yesterday, `prk secrets set` today                         | With two or more profiles, a write must name its server; the default alone is refused                        |
| A leftover `PRK_PROFILE` in a long-lived terminal                                                   | Every write prints `writing to <host> (profile <name>, instance <id>)` before it is sent                     |
| A pipe whose second half resolves through the default                                               | The same write rule; one invocation talks to one server and has no way to change it                          |
| A repository's committed file naming `prod`, which is a different deployment on this machine        | Project files select by instance id, never by profile name                                                   |
| An injected secret named `PRK_API_URL` or `PRK_PROFILE` redirecting a `prk` nested inside `prk run` | `prk run` skips those names, with a warning naming the key, unless `--allow-prk-vars` is given               |
| A hostname repointed, by DNS or a reused domain, at another deployment                              | The instance pin: a different instance is refused before the command's own first request                     |
| A service token for one deployment sent to another                                                  | With several profiles, a token pairs only with a server chosen by flag or environment; and the client-id pin |
| Two profiles chosen between by a model, through two MCP entries                                     | One MCP entry per deployment, an instance pin per entry; see [MCP server](/guides/mcp-server)                |

A refusal is used rather than a confirmation prompt throughout. It behaves the
same under `--no-input`, and a y/N prompt that appears on every write is
answered from muscle memory.

### The project file only allows

A `.prick.toml` arrives with `git clone`, so it is input from whoever wrote the
repository, not from you. It is constrained accordingly:

- It **never names a URL or a credential**. Every key it does not recognise is
  refused, so `url = ...` is an error rather than a line that might be honoured.
  A cloned repository therefore cannot aim a command, or a service token in
  your environment, at a server you did not register.
- It **lists instance ids**, and among the profiles you already have, selects
  the one pinned to the listed instance. It narrows what your machine does; it
  never widens it.
- **Whatever selects the server**, the server's instance must be on the list.
  A flag can choose among the listed deployments, not escape them.
- It **cannot pair with a service token** when several profiles exist. A token
  in the environment and a server chosen by a file are two decisions nobody
  made together.
- A `.prick.local.toml` beside it holds one checkout's choice and is refused
  unless git ignores it, so it cannot become a choice made for everyone who
  clones.

### Trust on first use

A profile pins the instance id its server reports the first time it talks to
the server: at `prk login`, at the first command after `prk profile add`, or
at the first command after updating from a single-server install. That first
answer is trusted on the same basis as the URL itself: you chose to sign in to
that hostname, through its Access organisation. A deployment that was already
the wrong one at that moment is pinned as it is.

After that, the pin is the strongest check in the client. A server that
reports a different instance, or stops reporting one, is refused, and nothing
the server says can change a pin. Replacing it is a deliberate local act:
remove the profile and sign in again.

### Deployments sharing one Access organisation

Two deployments of the same application, run for two clients behind one
Access organisation, can be identical to every request: the same issuer, the
same administrator, the same slugs and key names. The issuer pin cannot tell
them apart. The instance id can, and every control above is keyed on it:
the profile pin, the project file's allow list, and `--expect-instance` for a
script.

A service token is where such deployments are most easily confused, because
one token can be accepted by both. The client can only control which token it
sends, so a profile can pin its `service_token_client_id` and any other is
refused before it is sent. Which deployments accept a token is a server-side
property: under a policy admitting any Access service token, prick's grants
separate the deployments, because a token holds grants only on the deployment
that granted it and the other answers `404`; under policies scoped to one token
each, the edge separates them.

### The instance id is shown only to authenticated callers

The instance id is reported by `/api/v1/whoami` and in a `Prick-Instance` header
on authenticated responses, never by the unauthenticated `/api/v1/health`. It
is not a secret and carries no authority, but it is a stable fingerprint that
names **which** deployment answered, and the one unauthenticated route reveals
nothing beyond "a prick server is listening here". The cost is that the check
needs a credential: `prk` verifies the instance after the
credential for that URL is attached, on a request that carries no secret
value, and before the command's own first request.

## What it does not protect against

- **A malicious administrator.** An admin can read everything they are granted.
  The audit log records that they did, which is detection, not prevention.
- **Cloudflare.** The Worker decrypts values in Cloudflare's runtime. If
  Cloudflare is in your threat model, this architecture is not for you.
- **A misconfigured Access application.** If Access is not attached to the
  hostname, the entire authorization model is bypassed — every project, every
  environment, every reveal endpoint, open to the internet. `workers_dev` and
  `preview_urls` are set to `false`, and CI asserts both on every push. An Access application
  with an over-broad policy is not something prick can detect at all. Verify it
  yourself, as in the [Quickstart](/getting-started/quickstart), and note that
  `prk doctor` fails and `prk login` warns loudly if `/health` answers `200`
  unauthenticated.
- **A compromised developer machine.** The token file is mode `0600`, which stops
  other users, not malware running as you.
- **Denial of service.** There are size and count limits, but no rate limiting is
  implemented in the Worker. The `RATE_LIMITED` code exists in the taxonomy for a
  response Cloudflare's own protections may produce, not because prick enforces a
  quota.
- **Multi-tenancy.** This is a single-tenant, self-hosted system. Projects are
  organisation, not isolation: the same master key protects every value in the
  deployment.
- **Loss of `MASTER_KEY`.** There is no escrow, no recovery key and no vendor
  who can help. This is by construction.

## What the operator carries

The protections above are exercised on live paths: the API surface is mounted,
the CLI authenticates and injects, and the reveal audit, the `no-store` headers
and the loud decrypt failure all run on real requests. Three of them depend on an
operator to carry through:

- **The rekey advances while you drive it.** `getKeyringStatus` and `rekeyPage`
  are implemented, and a rotation moves one page per call to `POST /admin/rekey`.
  `MASTER_KEY_OLD` becomes removable once the ring reports zero rows against
  every retired key id, so drive a rotation through to that point. See
  [Key rotation](/guides/key-rotation).
- **`ENV_MAX_SECRETS` is derived rather than measured.** 500 comes from an
  undocumented per-batch statement limit weighed against a documented 30-second
  ceiling. Load-test it against your own workload and lower the cap if the
  measurement disagrees.
- **Provenance is established at publish time.** npm provenance and trusted
  publishing are properties the release workflow confers on each release it
  runs. See [Releasing](/contributing/releasing).

Do not run this as a production secrets manager yet.

## Reporting a vulnerability

Do not open a public issue. Use a private security advisory — see
`.github/SECURITY.md` in the repository.

## Next steps

- [Encryption](/architecture/encryption)
- [Authorization](/architecture/authorization)
- [Backup and recovery](/guides/backup-and-recovery)
