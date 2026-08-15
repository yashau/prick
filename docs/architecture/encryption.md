---
title: Encryption
description: Key derivation, the ciphertext envelope, and the additional authenticated data that binds each ciphertext to its row.
sidebar:
  order: 2
---

Secret **values** are encrypted with AES-256-GCM under a key derived from
`MASTER_KEY`. Secret **key names** are not — see
[Threat model](/architecture/threat-model) for that trade.

Everything on this page is implemented and tested. Source:
`packages/app/src/lib/server/crypto/`.

## Loading the master key

`MASTER_KEY` is base64 that decodes to **exactly 32 bytes**. It is validated when
the key ring is built, before any route runs, so a bad value makes the Worker
refuse every request — including `/health` — rather than serving happily until
the first secret is read.

The **decoded bytes** are the key derivation input, not the base64 text. That is
the specific failure this validation exists to make impossible, because it is
completely silent: `MASTER_KEY="hunter2"` would be accepted, the derivation would
happily stretch those seven bytes, and the result is a fully functional secrets
manager protected by a password. Nothing observable at runtime would distinguish
it from a correct deployment.

## Derivation

```
kid(mk) = hex(first 8 bytes of HKDF-SHA256(ikm = mk, salt, "prick/v1/kid"))
DEK(mk) = HKDF-SHA256(ikm = mk, salt, "prick/v1/dek/secret.value")
```

with the fixed salt `prick/v1/keyring`.

| Property | Value |
|---|---|
| Salt | `prick/v1/keyring` |
| Key id info | `prick/v1/kid` |
| Data key info | `prick/v1/dek/secret.value` |
| Key id | 8 bytes, rendered as 16 lowercase hex characters |
| Data key | AES-256-GCM, `extractable: false` |

The key id is **derived** from the key material rather than configured, so it
cannot drift from the key it names. Two deployments given the same `MASTER_KEY`
compute the same id; a mistyped key computes a different one, and the resulting
error names it.

:::danger[The salt and the info strings are part of the storage format]
Changing either changes every key id and every data key, which makes every
stored row undecryptable. They are constants, not configuration.
:::

The data key is imported with `extractable: false`, so it cannot be read back out
of the runtime — not by later code in the same module, not by a bug elsewhere
that gets hold of the `CryptoKey`. The raw master bytes are not retained either:
once the id and the data key are derived, the decoded material goes out of scope.
There is no field on any object a serialiser, a logger or a debugger could render
into key material.

Derivation is memoised per isolate, keyed on a hash of the concatenated material
rather than on the material itself. Re-deriving on every request is pure latency
for no security gain.

## The envelope

```
base64url( version ‖ alg ‖ kid[8] ‖ iv[12] ‖ ciphertext‖tag )
```

| Field | Bytes |
|---|---|
| `version` | 1 |
| `alg` | 1 (`0x01` = AES-256-GCM) |
| `kid` | 8 |
| `iv` | 12 |
| `ciphertext‖tag` | remainder, at least 16 (the tag) |

A v1 header is therefore 22 bytes, and the shortest legal v1 envelope is 38.

**Byte 0 is read first, and it dispatches.** An unknown format byte throws. It is
never guessed at, never best-effort decoded, and never treated as the current
format on the assumption that it probably is. The length checks happen *after*
the dispatch and are specific to the format that byte named — a shared "is it
long enough" check up front would be checking the wrong number for every format
but one.

| Format | Meaning |
|---|---|
| `0x01` | Current. AES-256-GCM with full additional authenticated data |
| `0x00` | v0 — legacy, no AAD. **Decrypt-only, never emitted** |

The v0 format exists so that a v0 export can be imported and immediately
re-encrypted as `0x01`. Its body is `iv[12] ‖ ciphertext‖tag`: no algorithm byte
and no key id, so decrypting one has to try every key in the ring. Accepting it
is **opt-in per call**, defaulting to refuse — a v0 row is bound to nothing and is
exactly as transplantable as the ciphertexts the AAD exists to stop being, so
accepting one by default would reintroduce that weakness per row, silently, on
the normal read path.

The serialiser refuses every format byte except `0x01`. That refusal is the
structural half of "the legacy format is never emitted": it is not a rule about
how callers should behave, it is the absence of a code path.

### The IV

96 fresh random bits per encryption. Nothing reuses, derives or counters an IV. A
repeated `(key, IV)` pair in GCM is catastrophic — it leaks the XOR of the two
plaintexts and, worse, the authentication subkey.

## The additional authenticated data

This is the most important part of the design, and the one thing that genuinely
cannot be retrofitted: once rows exist without it, every one of them has to be
decrypted and re-encrypted to gain it.

```
AAD = "prick" ‖ 0x01
    ‖ len16(purpose)        ‖ purpose          ("secret.value")
    ‖ len16(environment_id) ‖ environment_id
    ‖ len16(key)            ‖ key
    ‖ u32be(version)
```

The defect it closes: an AES-GCM ciphertext with no additional data is bound to
nothing. Every blob in the table is interchangeable with every other, so anyone
with write access to the database can transplant a production secret into a
development environment they are allowed to read — and the decryption succeeds,
because there is nothing to contradict.

With this AAD in place, that ciphertext fails GCM tag verification.

### Why length-prefixed and not delimited

Every variable-length field is prefixed with its length as a **big-endian
`u16`**. It is not delimiter-separated, and the difference is not stylistic.

A delimiter scheme becomes ambiguous the instant a field can contain the
delimiter. "The key can't contain a colon" is an assumption, not a guarantee —
and a schema constraint that holds today is not the thing you want a
cryptographic binding to depend on. Length-prefixing is unconditionally
injective, for two bytes per field.

The property that is tested explicitly:

```
{ key: "AB", env: "C"  }
{ key: "A",  env: "BC" }
```

These **must** produce different AAD. A separator scheme fails exactly this: both
serialise to the same `A B : C` byte string, and a ciphertext sealed for one row
opens under the other.

Lengths are counted in **UTF-8 bytes**, not in JavaScript string units. A prefix
counting UTF-16 code units while the payload was written as UTF-8 would not
describe the bytes that follow it, which reintroduces the ambiguity by another
route.

Bounds: a field may not be empty — it is part of the row's identity — and may not
exceed 65535 bytes. The version must be an integer in `[0, 4294967295]`.

### What each field buys

All of these are GCM tag failures, not application-level checks:

| Field | Attack it kills |
|---|---|
| `environment_id` | Cross-environment transplant |
| `key` | Cross-key transplant |
| `version` | Rollback and roll-forward replay |
| `purpose` | Reuse of a value blob in some future non-value context |

Concretely: take the ciphertext for `DATABASE_URL` version 3 in production, write
it into the `DATABASE_URL` row of a development environment you can read, and the
read fails. Change the row's key name, and it fails. Present it as version 2 or
version 4, and it fails.

## What is bound and what is not

Two fields are deliberately **excluded**, for opposite reasons.

**`project_id` is excluded.** Including it would promote "an environment can
never be reparented" into a cryptographic invariant, so any future reparent would
require re-encrypting every row in the project. Instead `environments.id` and
`environments.project_id` are documented as immutable and there is no reparent
operation — a schema constraint rather than a crypto one.

**`kid` is excluded, and lives in the envelope instead.** A rekey must change
which key protects a row **without** changing the row's identity. Because the key
id is outside the AAD, re-encrypting under a new master key leaves the
authenticated data — and therefore the version — untouched. If the key id were in
the AAD, every rekey would be a version bump, and rotating a key would rewrite
the history of every secret you own.

## How mutations interact with the AAD

| Operation | Handling |
|---|---|
| Update a value | New version, encrypt fresh. **Never copy a blob** |
| Rename a key | Decrypt under the old identity, re-encrypt under the new one at the next version, both in one transaction. There is no cheap rename |
| Roll back to version N | Decrypt N, re-encrypt as `current + 1`. The old blob is never resurrected |
| Rekey | Re-encrypt under the **identical** AAD with a new key id. Version unchanged |
| Import a v0 row | Accepted on decrypt only, then immediately re-encrypted as `0x01` |

## Failure behaviour

Encryption and decryption either return a correct result or **throw**. There is
no path that returns `null`, an empty string, a "skipped" marker or a partially
decoded value. The caller cannot accidentally treat a failure as an absent row —
which is how an environment quietly deploys without its `DATABASE_URL`.

| Error | Meaning |
|---|---|
| `SERVER_MISCONFIGURED` | The master key material is absent, malformed or internally inconsistent. Raised while parsing configuration, so the Worker fails closed on every route |
| `DECRYPT_FAILED` | The bytes were not sealed against the identity they are being opened under |
| `UNKNOWN_KID` | The envelope names a key id the ring does not hold. **Names the id**, and lists the ones loaded |
| `CRYPTO_FORMAT` | A stored blob is not parseable |
| `CRYPTO_INPUT` | A caller supplied an identity that cannot be encoded |
| `PAYLOAD_TOO_LARGE` | The plaintext exceeds the configured byte ceiling |

An AEAD failure and a presented-under-the-wrong-identity failure are
indistinguishable to AES-GCM and are reported the same way. That is correct,
because they are the same event.

`UNKNOWN_KID` is deliberately a different error from `DECRYPT_FAILED`: "you
removed `MASTER_KEY_OLD` too early" and "this row has been tampered with" need
opposite responses, and one generic failure cannot tell them apart.

Every message may name a key, an environment id, a version, a key id, a byte
limit or a format byte. **None may contain a plaintext value, a ciphertext, or
master key material** — these strings reach logs, HTTP responses and audit rows.

One message is written to leak less than it could: the payload-too-large error
names the *limit* and not the actual size. A value's exact byte length is the
most revealing metadata a value has, and naming the limit already tells the
caller everything they need in order to act.

## Nothing in this encoding may ever change

Every stored row's tag was computed over these exact bytes. Altering the magic,
the version byte, the field order or the prefix width makes every existing row
undecryptable. A new binding requires a **new envelope format byte**, not an edit
to the existing encoder.

## Next

- [Key rotation](/guides/key-rotation)
- [Threat model](/architecture/threat-model)
- [Backup and recovery](/guides/backup-and-recovery)
