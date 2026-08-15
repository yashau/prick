# Security policy

## Reporting a vulnerability

**Report privately: <https://github.com/yashau/prick/security/advisories/new>**

Do not open a public issue, a discussion, or a pull request that fixes the
problem before the advisory exists. This project stores production credentials
for the people who run it; a public report is a live exploit notice for every
deployment that has not upgraded yet.

You should get an acknowledgement within 72 hours. If you do not, assume the
message was missed and open a public issue that says only "I sent a private
advisory on <date>, please look at it" -- with no detail.

Please include:

- What an attacker can do, and what they need in order to do it.
- The version (`prk --version`, or the deployed commit).
- A reproduction, ideally against a scratch project.
- Your view of the severity, and why.

Please leave out real secret values, tokens, account identifiers and cookies.
A redacted reproduction is worth more than a real one.

## Supported versions

Versions are CalVer (`YYYY.MMDD.N`) and roll forward only. **Only the current
`latest` release on npm is supported.** There are no backport branches: a fix is
published as a new version, never as a re-tag of an old one. A published version
is never deleted or overwritten.

## Scope

In scope:

- Anything that lets an identity read, write or delete a secret it holds no
  grant for.
- Anything that reveals a plaintext secret value to a party that did not
  explicitly request it: a server-rendered page payload, a log line, an error
  message, an audit detail field, a cached response, a browser or CDN cache.
- Bypassing Cloudflare Access to reach the Worker at all -- including a
  hostname the Access policy is not attached to.
- Forging, replaying, transplanting or rolling back an encrypted value. Every
  ciphertext is bound to its environment, key and version through AEAD
  additional data; a way to break that binding is a vulnerability.
- Any un-audited mutation.
- A supply-chain path into a published artefact: the release workflow, the
  npm packages, the release archives.

Out of scope:

- Anyone who can run `wrangler deploy` against your account, or who can read
  the `MASTER_KEY` Worker secret. They can decrypt everything by design. This is
  stated plainly rather than defended against, because it cannot be defended
  against: it is the same authority that installed the application.
- Anyone who legitimately holds an `admin` grant. `admin` means admin.
- Misconfiguration of your own Cloudflare Access policies.
- Reports produced solely by a scanner, with no demonstrated impact.
- Denial of service through ordinary request volume against your own Worker.

## Things that are already known and deliberate

Please do not report these:

- **`MASTER_KEY` is a plain Worker secret, not Secrets Store.** Deliberate. See
  `CONTRIBUTING.md`.
- **`BOOTSTRAP_ADMINS` is a plaintext `vars` list.** Deliberate: it anchors
  bootstrap to the same authority that deploys the Worker, which is strictly
  greater than any grant it can create.
- **The v0 envelope format has no AEAD additional data.** It is accepted on
  decrypt only, for importing existing data, and is never emitted.
- **Denied requests are recorded, including the identity that was denied.** That
  is the feature that makes an unrecognised service token grantable.

## Handling

Fixes are developed in a private fork attached to the advisory and land as a
single commit when the advisory is published, together with a new release and a
CVE. Credit is given in the advisory unless you ask otherwise.
