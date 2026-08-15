<!--
The title of this pull request becomes the commit message on main verbatim,
because this repository squash-merges. It must follow Conventional Commits:

    <type>(<optional scope>): <subject in lower case, no trailing period>

CI checks this. See .github/workflows/pr-title.yml for the accepted types.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## How to verify

<!--
The commands a reviewer should run, or the steps to click through. If this
cannot be verified without a Cloudflare account, say so.
-->

## Checklist

- [ ] `mise run ci` passes locally.
- [ ] Tests cover the change. A bug fix has a test that fails without the fix.
- [ ] No secret value can reach stdout, stderr, a log line, an error message, a
      server-rendered page payload or an audit detail field as a result of this
      change.
- [ ] Documentation is updated if behaviour, flags or output changed.

### If this touches encryption or the database

- [ ] No ciphertext is copied between rows. Every write re-encrypts under its
      own AAD.
- [ ] Migrations are additive only. Nothing in this pull request both ships code
      and drops or tightens a column.
- [ ] Any generated migration has been read, and no `PRAGMA foreign_keys=OFF`
      survived into it.

### If this touches authorization

- [ ] The check goes through the shared core, not through a route handler that
      decides for itself.
- [ ] Both identity kinds are covered: an SSO user and a service token. Service
      token claims have no `email`, no `nbf`, and an empty `sub`.
