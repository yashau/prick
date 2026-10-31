-- The deployment's one instance row: 16 random bytes as 32 lowercase hex
-- characters, and `created_at` in Unix epoch milliseconds. Guarded so that
-- applying this file to a database that already holds a row is a no-op.
INSERT INTO `instance` (`id`, `created_at`)
SELECT lower(hex(randomblob(16))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE NOT EXISTS (SELECT 1 FROM `instance`);
