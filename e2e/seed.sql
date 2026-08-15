-- =============================================================================
-- The end-to-end fixture, applied with
--
--   wrangler d1 execute prick --local --file e2e/seed.sql
--
-- BEFORE the Worker starts. Two writers on one SQLite file is a race with no
-- upside: everything a spec needs after boot it can create through the API,
-- which is the path that encrypts values correctly and writes the audit rows.
--
-- -----------------------------------------------------------------------------
-- WHAT IS SEEDED HERE AND WHAT IS NOT
-- -----------------------------------------------------------------------------
-- Here:  projects, environments, identities, grants, and ONE deliberately
--        undecryptable secret. All of it is data with no ciphertext in it, or
--        ciphertext that is meant to be broken -- so writing it as SQL costs
--        nothing and duplicates no application logic.
--
-- Not here: readable secret VALUES. Those are written by `globalSetup` through
--        `POST …/secrets:batch`, because a correct envelope is
--        `base64url(version ‖ alg ‖ kid[8] ‖ iv[12] ‖ ciphertext‖tag)` sealed
--        under an AAD built from `(purpose, environment_id, key, version)` and
--        a key derived by HKDF from `MASTER_KEY`. Reimplementing that in the
--        test harness would produce a suite that asserts the harness agrees
--        with itself, which is the one thing a crypto test must not do.
--
-- -----------------------------------------------------------------------------
-- IDS
-- -----------------------------------------------------------------------------
-- Fixed, and shaped like UUIDv7 (`…-7xxx-8xxx-…`), because `Id` in
-- `@prick/shared` validates the version and variant nibbles and would reject a
-- made-up string. Fixed rather than generated so a failure message names a row
-- a human can find.
--
-- Timestamps are a fixed epoch (2026-08-05T09:46:40Z) for the same reason.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Projects
-- -----------------------------------------------------------------------------
INSERT INTO projects (id, slug, name, description, created_at, updated_at, created_by) VALUES
  ('0199e2e0-0000-7000-8000-000000000001', 'atlas', 'Atlas',
   'The shared read-only fixture. Specs that mutate create their own project.',
   1786000000000, 1786000000000, 'admin@example.com'),
  ('0199e2e0-0000-7000-8000-000000000002', 'ledger', 'Ledger',
   'Exists so that a project-scoped grant on atlas can be shown NOT to reach it.',
   1786000000000, 1786000000000, 'admin@example.com');

-- -----------------------------------------------------------------------------
-- Environments
-- -----------------------------------------------------------------------------
INSERT INTO environments (id, project_id, slug, name, description, rev, created_at, updated_at, created_by) VALUES
  ('0199e2e0-0000-7000-8000-000000000011', '0199e2e0-0000-7000-8000-000000000001',
   'production', 'Production', 'Readable values, written through the API at setup.',
   0, 1786000000000, 1786000000000, 'admin@example.com'),
  ('0199e2e0-0000-7000-8000-000000000012', '0199e2e0-0000-7000-8000-000000000001',
   'staging', 'Staging', 'The import dry-run target. Diffs against production.',
   0, 1786000000000, 1786000000000, 'admin@example.com'),
  ('0199e2e0-0000-7000-8000-000000000013', '0199e2e0-0000-7000-8000-000000000001',
   'quarantine', 'Quarantine', 'Holds the undecryptable row, and nothing else.',
   0, 1786000000000, 1786000000000, 'admin@example.com'),
  ('0199e2e0-0000-7000-8000-000000000014', '0199e2e0-0000-7000-8000-000000000002',
   'production', 'Production', 'Out of reach of every project-scoped atlas grant.',
   0, 1786000000000, 1786000000000, 'admin@example.com');

-- -----------------------------------------------------------------------------
-- Identities
--
-- `subject` is exactly what `classifyClaims` derives: a LOWER-CASED email for a
-- user, the opaque `common_name` for a service token. The harness deliberately
-- mints tokens with mixed-case addresses, so a verifier that stopped
-- lower-casing would fail to match these rows rather than pass quietly.
-- -----------------------------------------------------------------------------
INSERT INTO identities (id, kind, subject, display_name, disabled, created_at, updated_at, last_seen_at) VALUES
  ('0199e2e0-0000-7000-8000-000000000021', 'user', 'admin@example.com', 'E2E Administrator', 0, 1786000000000, 1786000000000, NULL),
  ('0199e2e0-0000-7000-8000-000000000022', 'user', 'writer@example.com', 'E2E Writer', 0, 1786000000000, 1786000000000, NULL),
  ('0199e2e0-0000-7000-8000-000000000023', 'user', 'reader@example.com', 'E2E Reader', 0, 1786000000000, 1786000000000, NULL),
  ('0199e2e0-0000-7000-8000-000000000024', 'service', '1f0c2b8a4d6e9350f7a1c3b5d8e02f46.access', 'E2E deploy (CI)', 0, 1786000000000, 1786000000000, NULL);

-- -----------------------------------------------------------------------------
-- Grants -- the role fixtures, one row each.
--
-- The admin is a REAL `scope_type = 'global'` row rather than an entry in
-- BOOTSTRAP_ADMINS. There is no god mode to lean on: a global admin here is an
-- ordinary grant resolved by the ordinary query, which is the property the
-- whole authorization design rests on, so the suite exercises that path rather
-- than the bootstrap one.
--
-- The three scope types are each represented once, deliberately:
--   global      admin
--   project     writer, on atlas only -- so `ledger` is a 403 for them
--   environment reader, on atlas/production only -- so `staging` is a 403
-- -----------------------------------------------------------------------------
INSERT INTO grants (id, identity_id, role, scope_type, project_id, environment_id, expires_at, created_at, created_by) VALUES
  ('0199e2e0-0000-7000-8000-000000000031', '0199e2e0-0000-7000-8000-000000000021',
   'admin', 'global', NULL, NULL, NULL, 1786000000000, 'seed'),
  ('0199e2e0-0000-7000-8000-000000000032', '0199e2e0-0000-7000-8000-000000000022',
   'writer', 'project', '0199e2e0-0000-7000-8000-000000000001', NULL, NULL, 1786000000000, 'seed'),
  ('0199e2e0-0000-7000-8000-000000000033', '0199e2e0-0000-7000-8000-000000000023',
   'reader', 'environment', NULL, '0199e2e0-0000-7000-8000-000000000011', NULL, 1786000000000, 'seed'),
  ('0199e2e0-0000-7000-8000-000000000034', '0199e2e0-0000-7000-8000-000000000024',
   'reader', 'project', '0199e2e0-0000-7000-8000-000000000001', NULL, NULL, 1786000000000, 'seed');

-- =============================================================================
-- THE UNDECRYPTABLE ROW
--
-- A syntactically VALID v0.1 envelope whose `kid` is sixteen zeroes -- a key id
-- no ring holds, because `kid` is derived by HKDF from the master key and
-- cannot be all zeroes. So the envelope parses, dispatches on its format byte,
-- and then fails to find a key.
--
--   0x01                        format: current
--   0x01                        alg:    AES-256-GCM
--   00 00 00 00 00 00 00 00     kid:    held by nothing
--   20 23 26 … 41               iv:     12 bytes, 0x20 stepping by 3
--   01 06 0b … 9c               ciphertext‖tag: 32 bytes, 5n+1
--
-- Parsing succeeds and decryption cannot, which is precisely the state a tamper
-- attempt or a prematurely-removed `MASTER_KEY_OLD` produces. `listSecrets`
-- must return this row marked `unreadable` and audit it with `outcome: 'error'`;
-- `revealSecret` and `exportSecrets` must FAIL rather than skip it. The
-- upstream behaviour this replaces was `catch { /* skip */ }`, which turns a
-- tampered row into a quietly shorter `.env` file -- which is how an
-- environment deploys without its `DATABASE_URL`.
--
-- It lives alone in `quarantine` so that the export test has an environment it
-- can legitimately export in full.
--
-- ONE CONSTRAINT ON THE BYTES, and it is not a cryptographic one: the base64url
-- of this blob is read by `typos` as prose, and the first pattern chosen here
-- happened to encode a three-letter run the spelling checker reports as a
-- misspelling -- which fails `mise run lint:typos`. So any replacement has to
-- be run past `typos` before it is committed. Widening the checker's
-- configuration is NOT the fix: an exemption added for a fixture blob is an
-- exemption that also blinds it to a real misspelling somewhere that matters.
-- =============================================================================
INSERT INTO secret_versions (id, environment_id, key, version, ciphertext, kid, op, created_at, created_by) VALUES
  ('0199e2e0-0000-7000-8000-000000000051', '0199e2e0-0000-7000-8000-000000000013',
   'LEGACY_API_TOKEN', 1,
   'AQEAAAAAAAAAACAjJiksLzI1ODs-QQEGCxAVGh8kKS4zOD1CR0xRVltgZWpvdHl-g4iNkpec',
   '0000000000000000', 'create', 1786000000000, 'seed');

INSERT INTO secrets (id, environment_id, key, current_version, description, created_at, updated_at, updated_by) VALUES
  ('0199e2e0-0000-7000-8000-000000000041', '0199e2e0-0000-7000-8000-000000000013',
   'LEGACY_API_TOKEN', 1,
   'Sealed under a key id this keyring does not hold. Deliberate.',
   1786000000000, 1786000000000, 'seed');
