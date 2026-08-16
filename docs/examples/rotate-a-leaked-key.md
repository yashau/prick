---
title: Respond to a leaked secret
description: Close the leak, work out the blast radius, and leave a record — for a leaked value and for a leaked credential.
sidebar:
  order: 5
---

Something got out. This page is the order to do things in, for the two cases
that actually happen: a **secret value** leaked (a Stripe key in a screenshot, a
`.env` committed to git), or a **credential** leaked (a service token in a public
build log, a stolen laptop).

:::danger[Do the containment step first, read the rest after]
For a leaked credential, the first command is
[`prk access disable`](#a-leaked-credential). For a leaked value, it is rotating
the value at the provider. Everything else can wait ten minutes; those cannot.
:::

## A leaked value

A `STRIPE_SECRET_KEY` ended up somewhere it should not be.

### 1. Rotate at the provider first

Issue a new key in the provider's dashboard and revoke the old one **there**.
Until that is done, changing what prick stores accomplishes nothing — the leaked
string still works.

### 2. Store the new value

```bash
export PRK_PROJECT=api
export PRK_ENV=production
```

```bash
prk secrets set STRIPE_SECRET_KEY --reason "rotating after 2026-08-16 leak in build log #4412"
```

```
Value for STRIPE_SECRET_KEY:
```

```
Updated `STRIPE_SECRET_KEY` (rev 47).
```

`--reason` is written verbatim into the audit row. In three months, that
sentence is the difference between "why did this change" and an afternoon of
archaeology.

### 3. Find every environment that had it

A key is per-environment, so the same secret usually exists in several:

```bash
for env in production staging preview; do
  printf '%s: ' "$env"
  prk secrets list --env "$env" --json | jq -r '[.[] | select(.key == "STRIPE_SECRET_KEY")] | length'
done
```

```
production: 1
staging: 1
preview: 0
```

Rotate each one that holds it. A staging key that shares a value with production
is a production key.

### 4. Work out who could have read it

```bash
prk secrets history STRIPE_SECRET_KEY
```

```
v3	set	you@example.com
v2	set	deploy@example.com
v1	set	you@example.com
```

That is who **wrote** it. For who could have read it, list everyone with a role
on the scope:

```bash
prk access list
```

```
alice@example.com	admin	billing:*
deploy@example.com	reader	api:production
e367826f93b8d71185e03fe518aff3b4.access	writer	api:staging
```

:::caution[`prk access list` shows direct grants only]
Someone can hold a role through a **group** and never appear in that listing.
For a real blast-radius answer, check each identity:

```bash
prk access explain alice@example.com
```

:::

Reads themselves are audited, with the reason recorded — `reveal`, `copy`,
`export` or `run` — so an administrator can query the audit log for who actually
took it, rather than only who could have. See
[Access control](/guides/access-control#reading-the-audit-log).

### 5. Restart whatever holds the old value in memory

A running process took its environment at startup. Redeploy or restart it, or it
keeps using the key you just rotated.

## A leaked credential

A service token appeared in a public log, or someone's laptop went missing.

### 1. Disable the identity. Now

```bash
prk access disable e367826f93b8d71185e03fe518aff3b4.access --yes
```

```
Disabled `e367826f93b8d71185e03fe518aff3b4.access`.
It now resolves to no role at any scope, whatever its grants say -- including BOOTSTRAP_ADMINS. Re-enable with `prk access enable e367826f93b8d71185e03fe518aff3b4.access`.
```

This is one write, checked **before** grants are resolved, so it outranks every
grant at every scope — direct grants, group-held roles, and `BOOTSTRAP_ADMINS`
alike. Nothing has to be enumerated, so nothing can be missed.

Do this instead of hunting for grants to revoke. Revoking is per-scope: a
compromised identity may hold several grants, and the ones it holds through a
group are not revocable with `prk access revoke` at all. The hunt's failure mode
is missing one and believing you are done.

:::note[Disabling requires global admin]
If you are a project admin, this is the moment to page whoever holds global
admin. Meanwhile, revoke what you can reach:

```bash
prk access revoke e367826f93b8d71185e03fe518aff3b4.access --scope api:production --yes
```

:::

### 2. Establish what it could reach

```bash
prk access explain e367826f93b8d71185e03fe518aff3b4.access
```

A disabled identity reports `none` at every scope, with its sources still
listed. That listing is exactly the blast radius: every environment in it holds
secrets that must now be treated as leaked.

:::tip[Watch for it still trying]
Anything still holding the credential now gets a `403`, and each refusal is
audited under `access.denied` with `disabled: true` in its detail — which
distinguishes "the kill switch stopped this" from "this identity was never
granted anything".

Those rows tell you which jobs are still configured with the leaked credential,
so you know what to reconfigure in step 5.
:::

### 3. Revoke the credential at Cloudflare

Disabling stops prick from honouring the identity. The token can still
authenticate to Cloudflare Access and reach anything else that trusts it, so
delete it under **Zero Trust → Access → Service auth → Service Tokens**.

For a person, revoke their Access sessions and, if the laptop is gone, assume
the local token file went with it.

### 4. Rotate everything it could read

Work through the scopes from step 2 and treat every secret in them as leaked —
following [A leaked value](#a-leaked-value) for each.

```bash
prk secrets list --env production
```

```
DATABASE_URL	v4	you@example.com
STRIPE_SECRET_KEY	v3	you@example.com
```

### 5. Issue a replacement credential

Create a new service token, and give it a narrower scope than the old one had —
the incident is the evidence for how narrow it should have been. See
[Give CI read-only access](/examples/ci-read-only).

Name it while you are there:

```bash
prk access rename <NEW SUBJECT> "api deploy job (replaces token disabled 2026-08-16)"
```

### 6. Leave the old identity disabled

Do not delete it. A disabled identity is a record: it keeps the audit rows
readable, and it means a rediscovered copy of the credential fails against a
subject somebody can look up rather than against nothing at all.

## If you got it wrong

Disabling is fully reversible, and the grants come back exactly as they were,
because disabling never touched them:

```bash
prk access enable e367826f93b8d71185e03fe518aff3b4.access
```

```
Enabled `e367826f93b8d71185e03fe518aff3b4.access`.
Its grants are in force again; `prk access explain e367826f93b8d71185e03fe518aff3b4.access` shows exactly what that restored.
```

A secret rotated by mistake is recoverable too — the previous value is still in
history:

```bash
prk secrets history STRIPE_SECRET_KEY
```

```
v4	set	you@example.com
v3	set	you@example.com
v2	set	deploy@example.com
v1	set	you@example.com
```

```bash
prk secrets rollback STRIPE_SECRET_KEY --to 3 --reason "rotation was against the wrong environment"
```

```
Restored `STRIPE_SECRET_KEY` from version 3 as version 5 (rev 48).
```

Note that `--to` takes a **version** from the history listing, not the
environment's `rev`. Rolling back writes a new version rather than resurrecting
the old ciphertext.

## What this page is not about

If the **master key** leaked — the `MASTER_KEY` Worker secret, not an
application secret — that is a different and larger job, because every
ciphertext in the database is bound to it. See
[Key rotation](/guides/key-rotation).

## Next steps

- [Access control](/guides/access-control) — the kill switch, groups, and the audit log.
- [Key rotation](/guides/key-rotation) — rotating `MASTER_KEY` itself.
- [Threat model](/architecture/threat-model) — what the design does and does not defend against.
