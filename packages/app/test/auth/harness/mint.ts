/**
 * JWT minting, inside workerd, with real key material.
 *
 * Deliberately hand-rolled rather than delegated to `hono/jwt`'s `sign()`: the
 * negative suite has to produce tokens `sign()` refuses to make -- `alg: none`,
 * an HS256 token carrying a `kid` that points at an RSA key, a header whose
 * `alg` disagrees with the key that actually signed it. A minter that can only
 * emit well-formed tokens cannot test a verifier.
 */

/** How the signature is produced. The header is set independently, on purpose. */
export type SigningStrategy =
  | { kind: "rs256"; privateJwk: JsonWebKey }
  /** Algorithm confusion: the RSA PUBLIC key, used as an HMAC secret. */
  | { kind: "hs256"; secret: string }
  /** `alg: none`: the signature segment is empty. */
  | { kind: "none" }
  /** A syntactically valid but wrong signature. */
  | { kind: "garbage" };

export interface JoseHeaderSpec {
  alg: string;
  kid?: string;
  typ?: string;
}

/** Access claim payload. Every field optional so any of them can be omitted. */
export interface AccessPayloadSpec {
  iss?: string;
  aud?: unknown;
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  email?: string;
  common_name?: string;
  identity_nonce?: string;
  country?: string;
  type?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodePart(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Copy into a plain `ArrayBuffer`.
 *
 * `TextEncoder#encode` is typed as `Uint8Array<ArrayBufferLike>`, which the
 * WebCrypto `BufferSource` parameter does not accept because the buffer could
 * in principle be a `SharedArrayBuffer`.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function signBytes(strategy: SigningStrategy, data: Uint8Array): Promise<Uint8Array> {
  switch (strategy.kind) {
    case "none":
      return new Uint8Array(0);

    case "garbage":
      return crypto.getRandomValues(new Uint8Array(256));

    case "hs256": {
      const key = await crypto.subtle.importKey(
        "raw",
        toBuffer(new TextEncoder().encode(strategy.secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBuffer(data)));
    }

    case "rs256": {
      const key = await crypto.subtle.importKey(
        "jwk",
        strategy.privateJwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toBuffer(data)));
    }
  }
}

export async function mintJwt(
  header: JoseHeaderSpec,
  payload: AccessPayloadSpec | Record<string, unknown>,
  strategy: SigningStrategy,
): Promise<string> {
  const encodedHeader = encodePart({ typ: "JWT", ...header });
  const encodedPayload = encodePart(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await signBytes(strategy, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64Url(signature)}`;
}

export interface AccessTokenOptions {
  privateJwk: JsonWebKey;
  kid: string;
  team: string;
  aud: string;
  /** Epoch MILLISECONDS, matching the verifier's injected clock. */
  now: number;
  /** Overrides merged over the generated claim set. `undefined` deletes. */
  claims?: AccessPayloadSpec;
  header?: Partial<JoseHeaderSpec>;
  strategy?: SigningStrategy;
}

function applyOverrides(
  base: AccessPayloadSpec,
  overrides: AccessPayloadSpec | undefined,
): AccessPayloadSpec {
  if (overrides === undefined) return base;

  const merged: Record<string, unknown> = { ...base };

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }

  return merged as AccessPayloadSpec;
}

/**
 * A human Access token: non-empty `sub`, an `email`, and an `nbf`.
 *
 * `aud` is an ARRAY, because that is what Access actually issues. A fixture
 * that used a bare string would let an `aud === expected` verifier pass its own
 * tests and reject every real token.
 */
export async function mintUserToken(options: AccessTokenOptions): Promise<string> {
  const seconds = Math.floor(options.now / 1000);

  const base: AccessPayloadSpec = {
    iss: `https://${options.team}.cloudflareaccess.com`,
    aud: [options.aud],
    sub: "b1c9f0e4-9a0e-4d51-9f77-1f1a0f0c2d3e",
    email: "Operator@Example.COM",
    exp: seconds + 3600,
    iat: seconds - 5,
    nbf: seconds - 5,
    identity_nonce: "n0nce",
    country: "MV",
    type: "app",
  };

  return mintJwt(
    { alg: "RS256", kid: options.kid, ...options.header },
    applyOverrides(base, options.claims),
    options.strategy ?? { kind: "rs256", privateJwk: options.privateJwk },
  );
}

/**
 * A service Access token: EMPTY `sub`, a `common_name`, no `email`, NO `nbf`.
 *
 * This shape is the reason the verifier checks `nbf` only when present. A
 * verifier that requires it rejects every machine client in the estate with a
 * message that explains nothing.
 */
export async function mintServiceToken(options: AccessTokenOptions): Promise<string> {
  const seconds = Math.floor(options.now / 1000);

  const base: AccessPayloadSpec = {
    iss: `https://${options.team}.cloudflareaccess.com`,
    aud: [options.aud],
    sub: "",
    common_name: "e367826f93b8d71185e03fe518aff3b4.access",
    exp: seconds + 3600,
    iat: seconds - 5,
    type: "app",
  };

  return mintJwt(
    { alg: "RS256", kid: options.kid, ...options.header },
    applyOverrides(base, options.claims),
    options.strategy ?? { kind: "rs256", privateJwk: options.privateJwk },
  );
}
