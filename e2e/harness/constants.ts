/**
 * Every value the harness and the specs both need to agree on.
 *
 * One module, because the three halves of this suite -- the Node process that
 * boots the Worker, the Node process that mints tokens, and the browser that
 * talks to the result -- have no other way to stay in step. A slug typed twice
 * is a slug that will eventually be typed differently.
 */

/** The Access team name. Only ever appears in `iss`; nothing resolves it. */
export const ACCESS_TEAM = "prick-e2e";

/** The Access application's AUD tag. 64 hex characters, like the real thing. */
export const ACCESS_AUD = "1d4f7a2c9b6e0358f1a7c4d2e9b60358f1a7c4d2e9b603581d4f7a2c9b6e0358";

/** `kid` on every token this harness mints, and on the one published JWKS key. */
export const ACCESS_KID = "prick-e2e-access-signing-key";

/**
 * The master key, fixed rather than random.
 *
 * Base64 of exactly 32 ASCII bytes, so the value is legible in a failure
 * message and the derived `kid` is the same on every machine. It is a test key
 * for a database that is deleted at the end of the run.
 */
export const MASTER_KEY = "cHJpY2stZTJlLW1hc3Rlci1rZXktMDEyMzQ1Njc4OSE=";

/** The four identities the seed installs, and the tokens minted for them. */
export const ROLES = ["admin", "writer", "reader", "service"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Subjects, exactly as `classifyClaims` derives them.
 *
 * Users are keyed by LOWER-CASED email; the harness deliberately mints tokens
 * with mixed-case addresses so that the lower-casing is exercised rather than
 * assumed. A service token is keyed by its opaque `common_name`.
 */
export const SUBJECTS: Record<Role, string> = {
  admin: "admin@example.com",
  writer: "writer@example.com",
  reader: "reader@example.com",
  service: "1f0c2b8a4d6e9350f7a1c3b5d8e02f46.access",
};

/** What the tokens actually carry. Mixed case on purpose -- see `SUBJECTS`. */
export const TOKEN_EMAILS: Record<Exclude<Role, "service">, string> = {
  admin: "Admin@Example.com",
  writer: "Writer@Example.COM",
  reader: "READER@example.com",
};

/**
 * The seeded fixture data.
 *
 * `atlas` is the shared project. Specs that MUTATE create their own project
 * with a unique slug instead -- the suite runs fully parallel against one D1,
 * so a shared mutable environment would be a race rather than a test.
 */
export const SEED = {
  project: "atlas",
  otherProject: "ledger",
  production: "production",
  staging: "staging",
  /** Holds the deliberately undecryptable row. Nothing else lives here. */
  quarantine: "quarantine",
} as const;

/**
 * The keys `globalSetup` writes into `atlas/production` through the API.
 *
 * EVERY VALUE CARRIES THE `SEED_MARKER`, and that is load-bearing rather than
 * decorative. The SSR-boundary spec searches the raw HTML and every served
 * script for these strings, so a value that could plausibly occur in the bundle
 * for an innocent reason would make that assertion useless -- the first draft
 * used `checkout_v2,dark_mode`, which is a literal in the UI's own fixture
 * dataset, and the spec failed on a collision rather than on a leak. With the
 * marker, a match is unambiguous evidence that a value written to D1 reached
 * the browser through something other than a `fetch`.
 */
export const SEED_MARKER = "e2eseed9f13c7";

export const SEEDED_SECRETS: Record<string, string> = {
  DATABASE_URL: `postgres://atlas:${SEED_MARKER}-prod@db.internal:5432/atlas?sslmode=require`,
  FEATURE_FLAGS: `${SEED_MARKER}-checkout-v2,${SEED_MARKER}-dark-mode`,
  SESSION_SIGNING_KEY: `${SEED_MARKER}-0f1e2d3c4b5a69788796a5b4c3d2e1f0`,
};

/** The keys `globalSetup` writes into `atlas/staging`. Used by the import diff. */
export const STAGING_SECRETS: Record<string, string> = {
  DATABASE_URL: `postgres://atlas:${SEED_MARKER}-stage@db-staging.internal:5432/atlas`,
  FEATURE_FLAGS: `${SEED_MARKER}-checkout-v2`,
};

/** The key seeded by `seed.sql` whose envelope cannot be opened. */
export const UNREADABLE_KEY = "LEGACY_API_TOKEN";

/** The mask the value cell renders when nothing is revealed. */
export const MASK = "•".repeat(16);

/** `REVEAL_TTL_MS` in `reveal.svelte.ts`. Duplicated, and asserted against. */
export const REVEAL_TTL_MS = 30_000;

/** The header Access sets. The cookie is the browser's fallback. */
export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
export const ASSERTION_COOKIE = "CF_Authorization";

/**
 * The resolved appearance, mirrored into a cookie so the server can paint the
 * right palette in the first byte.
 *
 * Mirrors `THEME_COOKIE` in `packages/app/src/lib/client/theme.ts`. Restated
 * rather than imported for the same reason every wire shape in `harness/api.ts`
 * is: the e2e project deliberately does not depend on the application's source,
 * so a rename shows up here as a failing assertion rather than as a symbol that
 * quietly moved with it.
 *
 * It carries no authority. Forging it changes which colours are painted.
 */
export const THEME_COOKIE = "prick_theme";
