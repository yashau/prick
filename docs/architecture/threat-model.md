---
title: Threat model
description: What prick protects against, what it deliberately does not, and the trades that were made on purpose.
sidebar:
  order: 4
---

This page is written to be useful rather than reassuring. If a property does not
hold, it is listed here rather than left for you to discover.

## What is being protected

Secret **values**. Nothing else on the following list is confidential:

- Secret key names.
- Project and environment names, slugs and descriptions.
- Identity subjects: email addresses and service token common names.
- Grants, and the entire audit log.

## Who is trusted

| Party | Trusted with |
|---|---|
| Anyone who can `wrangler deploy` | **Everything.** See below |
| Cloudflare | Running the Worker and D1, and authenticating at the edge |
| A global administrator | Every value in the system |
| The prick server | Storing and returning values. **Not** with choosing what code runs on your machine |

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
account *is* the set of people who can read every secret. Treat Cloudflare
account access as equivalent to a global admin grant, and audit it in the same
way.

### 2. `prk run` injects through the environment

`prk run` puts values into the child process's environment. On Linux that
environment is readable at `/proc/<pid>/environ` **by the same user and by
root**, appears in a core dump, and may be captured by process monitoring or a
crash reporter. On other platforms the equivalents differ in detail, not in kind.

This is a deliberate trade. The alternatives are worse for the same threat: a
file on disk persists after the process exits, command-line arguments are visible
in `ps` to *every* user, and a private channel would require the child program to
cooperate. The environment is the mechanism that every program already
understands.

**Practical consequence:** `prk run` protects a secret from *the disk* and from
*other users' processes at rest*, not from another process running as you, and not
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

- The CLI denies `print_stdout` and `print_stderr` workspace-wide; exactly one
  module lifts the ban. A secret reaching stderr is a build failure, not a review
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

Beyond that: a strict Content Security Policy with no host allowlist for scripts,
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

## What it does not protect against

- **A malicious administrator.** An admin can read everything they are granted.
  The audit log records that they did, which is detection, not prevention.
- **Cloudflare.** The Worker decrypts values in Cloudflare's runtime. If
  Cloudflare is in your threat model, this architecture is not for you.
- **A misconfigured Access application.** If Access is not attached to the
  hostname, the entire authorization model is bypassed — every project, every
  environment, every reveal endpoint, open to the internet. `workers_dev` and
  `preview_urls` are forced to `false` and CI asserts both, but an Access
  application with an over-broad policy is not something prick can detect. Verify
  it yourself, as in the [Quickstart](/getting-started/quickstart).
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

## Known gaps in the current build

Because most of the product is not implemented, several protections described
above exist as code that nothing calls yet:

- No secrets route is mounted, so the reveal audit, the `no-store` cache headers
  and the loud decrypt failure are not exercised on a live path.
- The rekey job does not exist, so a rotation cannot be completed and a retired
  key cannot safely be removed.
- The CLI does not authenticate, so the token file and the service-token headers
  are specification rather than behaviour.
- The UI is a route skeleton, so the client-render-only rule is not yet load
  bearing.

Do not run this as a production secrets manager yet.

## Reporting a vulnerability

Do not open a public issue. Use a private security advisory — see
`.github/SECURITY.md` in the repository.

## Next

- [Encryption](/architecture/encryption)
- [Authorization](/architecture/authorization)
- [Backup and recovery](/guides/backup-and-recovery)
